// ============================================================
//  admin.js – AutoRelationMap 管理画面
// ============================================================

const sb = window.sb ?? null;

const LOG_PAGE_SIZE = 50;
const ACTION_LABELS = {
  node_add:    { label: 'ノード追加',         cls: 'log-action--add'    },
  node_delete: { label: 'ノード削除',         cls: 'log-action--delete' },
  node_rename: { label: '名前変更',           cls: 'log-action--edit'   },
  node_icon:   { label: 'アイコン変更',       cls: 'log-action--edit'   },
  link_add:    { label: 'リンク追加',         cls: 'log-action--add'    },
  link_delete: { label: 'リンク削除',         cls: 'log-action--delete' },
  link_edit:   { label: 'リンク編集',         cls: 'log-action--edit'   },
};

let currentUser = null;
let mapId = null;
let mapOwnerId = null;
let bannedIds = new Set();
let logPage = 0;
let logTotal = 0;

// ---- 初期化 ----
async function init() {
  if (!sb) {
    showGuard('Supabase が設定されていません。');
    return;
  }

  // URL から mapId を取得 /map/:id/admin
  const m = window.location.pathname.match(
    /^\/map\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/admin$/i
  );
  if (!m) { showGuard('無効な URL です。'); return; }
  mapId = m[1];

  document.getElementById('btn-back').addEventListener('click', () => {
    window.location.href = `/map/${mapId}`;
  });

  // セッション確認
  const { data: { session } } = await sb.auth.getSession();
  currentUser = session?.user ?? null;
  if (!currentUser) { showGuard('ログインが必要です。'); return; }

  // マップ所有者確認
  const { data: mapData, error: mapError } = await sb.from('maps')
    .select('owner_id, title')
    .eq('id', mapId)
    .single();

  if (mapError || !mapData) { showGuard('マップが見つかりません。'); return; }
  if (mapData.owner_id !== currentUser.id) { showGuard('このマップの管理者権限がありません。'); return; }

  mapOwnerId = mapData.owner_id;
  document.getElementById('header-map-title').textContent = mapData.title || '無題マップ';
  document.title = `管理画面 – ${mapData.title || '無題マップ'} | AutoRelationMap`;

  // コンテンツ表示
  document.getElementById('content').style.display = 'flex';

  await loadAll();
}

function showGuard(msg) {
  const el = document.getElementById('auth-guard');
  el.style.display = 'block';
  el.querySelector('p').textContent = msg;
}

async function loadAll() {
  await Promise.all([loadParticipants(), loadLogs()]);
}

// ---- 参加者 ----
async function loadParticipants() {
  // BAN リスト取得（actor_name も保持）
  const { data: banRows } = await sb.from('banned_accounts')
    .select('banned_user_id, actor_name')
    .eq('map_id', mapId);
  bannedIds = new Set((banRows ?? []).map(r => r.banned_user_id));
  const bannedNameMap = new Map((banRows ?? []).map(r => [r.banned_user_id, r.actor_name]));

  // ノード・リンクのオーナーから参加者を収集
  const [{ data: nodeOwners }, { data: linkOwners }] = await Promise.all([
    sb.from('nodes').select('owner_id').eq('map_id', mapId),
    sb.from('links').select('owner_id').eq('map_id', mapId),
  ]);

  const participantIds = new Set([
    ...(nodeOwners ?? []).map(r => r.owner_id),
    ...(linkOwners ?? []).map(r => r.owner_id),
    // BAN 済みユーザーも一覧に含める（コンテンツは削除済みだが管理対象として表示）
    ...bannedIds,
  ]);

  // ログから名前を取得（最新を優先）
  const { data: logNames } = await sb.from('map_logs')
    .select('actor_id, actor_name')
    .eq('map_id', mapId)
    .order('created_at', { ascending: false })
    .limit(200);

  const nameMap = new Map();
  for (const row of (logNames ?? [])) {
    if (!nameMap.has(row.actor_id)) nameMap.set(row.actor_id, row.actor_name);
  }

  const participants = [...participantIds].map(id => ({
    id,
    // ログ名 → BAN 時に保存した名前 → ID 前半 の順で fallback
    name: nameMap.get(id) || bannedNameMap.get(id) || id.slice(0, 8) + '…',
    isBanned: bannedIds.has(id),
    isOwner: id === mapOwnerId,
  }));

  document.getElementById('participant-count').textContent = participants.length;

  const container = document.getElementById('participants-list');
  if (participants.length === 0) {
    container.innerHTML = '<div class="empty">参加者はいません</div>';
    return;
  }

  container.innerHTML = '';
  participants.forEach(p => {
    const row = document.createElement('div');
    row.className = 'participant-row';

    const initial = (p.name || '?')[0].toUpperCase();
    row.innerHTML = `
      <div class="participant-avatar">${escHtml(initial)}</div>
      <div class="participant-info">
        <div class="participant-name">${escHtml(p.name)}</div>
        <div class="participant-id">${escHtml(p.id)}</div>
      </div>
    `;

    if (p.isOwner) {
      const badge = document.createElement('span');
      badge.className = 'badge-owner';
      badge.textContent = 'オーナー';
      row.appendChild(badge);
    } else if (p.isBanned) {
      const badge = document.createElement('span');
      badge.className = 'badge-banned';
      badge.textContent = 'BAN済み';
      row.appendChild(badge);

      const btn = document.createElement('button');
      btn.className = 'btn-unban';
      btn.textContent = 'BAN解除';
      btn.addEventListener('click', () => unbanUser(p.id));
      row.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn-ban';
      btn.textContent = 'BAN';
      btn.addEventListener('click', () => banUser(p.id, p.name));
      row.appendChild(btn);
    }

    container.appendChild(row);
  });
}

// ---- ログ ----
async function loadLogs() {
  const from = logPage * LOG_PAGE_SIZE;
  const to   = from + LOG_PAGE_SIZE - 1;

  const { data, count, error } = await sb.from('map_logs')
    .select('id, actor_name, action, target_name, created_at', { count: 'exact' })
    .eq('map_id', mapId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    document.getElementById('logs-tbody').innerHTML =
      '<tr><td colspan="4" class="empty">ログの取得に失敗しました</td></tr>';
    return;
  }

  logTotal = count ?? 0;
  document.getElementById('log-count').textContent = logTotal;

  const tbody = document.getElementById('logs-tbody');
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">ログはありません</td></tr>';
    renderPagination();
    return;
  }

  tbody.innerHTML = '';
  data.forEach(row => {
    const info = ACTION_LABELS[row.action] ?? { label: row.action, cls: 'log-action--edit' };
    const dt = new Date(row.created_at);
    const dateStr = dt.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
      + ' ' + dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="log-time">${escHtml(dateStr)}</td>
      <td class="log-actor">${escHtml(row.actor_name || '不明')}</td>
      <td><span class="log-action ${info.cls}">${escHtml(info.label)}</span></td>
      <td class="log-target">${escHtml(row.target_name || '—')}</td>
    `;
    tbody.appendChild(tr);
  });

  renderPagination();
}

function renderPagination() {
  const totalPages = Math.ceil(logTotal / LOG_PAGE_SIZE);
  const el = document.getElementById('log-pagination');
  el.innerHTML = '';
  if (totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.className = 'btn-page';
  prev.textContent = '← 前';
  prev.disabled = logPage === 0;
  prev.addEventListener('click', () => { logPage--; loadLogs(); });

  const info = document.createElement('span');
  info.style.cssText = 'padding: 6px 8px; font-size: 13px; color: var(--text-sub);';
  info.textContent = `${logPage + 1} / ${totalPages}`;

  const next = document.createElement('button');
  next.className = 'btn-page';
  next.textContent = '次 →';
  next.disabled = logPage >= totalPages - 1;
  next.addEventListener('click', () => { logPage++; loadLogs(); });

  el.appendChild(prev);
  el.appendChild(info);
  el.appendChild(next);
}

// ---- BAN / UNBAN ----
async function banUser(userId, userName) {
  if (!confirm(`「${userName}」をBANしますか？\nこのユーザーが追加したノード・リンク・ログが全て削除されます。この操作は取り消せません。`)) return;

  // 1. ノードを削除（リンクは CASCADE で自動削除）
  const { error: nodesErr } = await sb.from('nodes')
    .delete()
    .eq('map_id', mapId)
    .eq('owner_id', userId);
  if (nodesErr) { alert('ノードの削除に失敗しました: ' + nodesErr.message); return; }

  // 2. リンクを削除（CASCADE で消えていない分を念のため）
  await sb.from('links')
    .delete()
    .eq('map_id', mapId)
    .eq('owner_id', userId);

  // 3. ログを削除
  await sb.from('map_logs')
    .delete()
    .eq('map_id', mapId)
    .eq('actor_id', userId);

  // 4. BAN 登録（actor_name を保存して BAN 後も名前を維持）
  const { error: banErr } = await sb.from('banned_accounts').insert({
    map_id: mapId,
    banned_user_id: userId,
    banned_by: currentUser.id,
    actor_name: userName,
  });
  if (banErr) { alert('BAN処理に失敗しました: ' + banErr.message); return; }

  logPage = 0;
  await loadAll();
}

async function unbanUser(userId) {
  if (!confirm('このユーザーのBANを解除しますか？')) return;

  const { error } = await sb.from('banned_accounts')
    .delete()
    .eq('map_id', mapId)
    .eq('banned_user_id', userId);

  if (error) { alert('BAN解除に失敗しました: ' + error.message); return; }

  await loadAll();
}

// ---- ユーティリティ ----
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- 起動 ----
init().catch(err => {
  console.error('[admin] init error:', err);
  showGuard(`エラーが発生しました: ${err?.message ?? err}`);
});
