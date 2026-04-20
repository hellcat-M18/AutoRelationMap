// ============================================================
//  AutoRelationMap – app.js
// ============================================================

const SVG_ID = 'map-svg';
const ICON_SIZE = 120;
const R_BASE = 32;
const R_MIN = 28;
const R_MAX = 110;
const FORCE_LINK_GAP = 330;
const COLLIDE_PADDING = 135;
const BIDIR_SPLIT_OFFSET = 6;

let nodes = [];
let links = [];
let nextNodeId = 1;
let nextLinkId = 1;
let biDirSet = new Set();
let biDirPrimarySet = new Set();
let biDirSecondarySet = new Set();
let pendingDataUrl = null;
let selectedNodeId = null;
let searchMatches = [];      // マッチノードIDの配列
let searchMatchSet = new Set();
let searchIndex = 0;
let arrowSrc = null;
let ctxTarget = null;
let modalCallback = null;
let width = 0;
let height = 0;
let layoutRunId = 0;

// ---- パフォーマンス用キャッシュ ----
let inDegreeCache = new Map();
let totalDegreeCache = new Map();
let maxInDegreeCache = 1;
let maxDegreeCache = 1;
let geometryCache = new Map();

const svg = d3.select(`#${SVG_ID}`);

const zoomBehavior = d3.zoom()
  .scaleExtent([0.1, 5])
  .on('zoom', event => {
    mainGroup.attr('transform', event.transform);
  });

svg.call(zoomBehavior)
  .on('dblclick.zoom', null);

const mainGroup = svg.append('g').attr('class', 'main-group');
const linkGroup = mainGroup.append('g').attr('class', 'link-group');
const labelGroup = mainGroup.append('g').attr('class', 'label-group');
const nodeGroup = mainGroup.append('g').attr('class', 'node-group-root');

const dragLine = mainGroup.append('line')
  .attr('id', 'drag-line')
  .attr('visibility', 'hidden');

// 非対称リンクフォース: ターゲット（矢印の先）だけ引き寄せられ、ソースは動かない
function forceAsymmetricLink() {
  let _links = [];
  let _distanceFn = () => 100;
  let _strength = 0.25;

  function force(alpha) {
    _links.forEach(link => {
      const source = getLinkSourceNode(link);
      const target = getLinkTargetNode(link);
      if (!source || !target || source === target) return;

      const dx = (target.x + (target.vx || 0)) - (source.x + (source.vx || 0));
      const dy = (target.y + (target.vy || 0)) - (source.y + (source.vy || 0));
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const desired = _distanceFn(link);
      const k = (dist - desired) / dist * alpha * _strength;

      // ターゲットのみ引き寄せる（ソースは動かさない）
      target.vx -= dx * k;
      target.vy -= dy * k;
    });
  }

  force.links = function(l) {
    if (!arguments.length) return _links;
    _links = l;
    return force;
  };

  force.distance = function(fn) {
    if (!arguments.length) return _distanceFn;
    _distanceFn = typeof fn === 'function' ? fn : () => +fn;
    return force;
  };

  force.strength = function(s) {
    if (!arguments.length) return _strength;
    _strength = +s;
    return force;
  };

  return force;
}

const simulation = d3.forceSimulation()
  .alphaDecay(0.0228)
  .force('link', forceAsymmetricLink().distance(link => {
    const source = getLinkSourceNode(link);
    const target = getLinkTargetNode(link);
    return (source?.r ?? R_BASE) + (target?.r ?? R_BASE) + FORCE_LINK_GAP;
  }).strength(0.25))
  .force('charge', d3.forceManyBody().strength(-3300).distanceMax(1800))
  .force('center', d3.forceCenter())
  .force('collide', d3.forceCollide().radius(node => node.r + COLLIDE_PADDING).strength(1))
  .on('tick', ticked);

function nodeById(id) {
  return nodes.find(node => node.id === id);
}

function getLinkSourceId(link) {
  return typeof link.source === 'object' ? link.source.id : link.source;
}

function getLinkTargetId(link) {
  return typeof link.target === 'object' ? link.target.id : link.target;
}

function getLinkSourceNode(link) {
  return typeof link.source === 'object' ? link.source : nodeById(link.source);
}

function getLinkTargetNode(link) {
  return typeof link.target === 'object' ? link.target : nodeById(link.target);
}

function rebuildDegreeCache() {
  inDegreeCache = new Map();
  totalDegreeCache = new Map();
  nodes.forEach(node => {
    inDegreeCache.set(node.id, 0);
    totalDegreeCache.set(node.id, 0);
  });
  links.forEach(link => {
    const src = getLinkSourceId(link);
    const tgt = getLinkTargetId(link);
    inDegreeCache.set(tgt, (inDegreeCache.get(tgt) ?? 0) + 1);
    totalDegreeCache.set(src, (totalDegreeCache.get(src) ?? 0) + 1);
    totalDegreeCache.set(tgt, (totalDegreeCache.get(tgt) ?? 0) + 1);
  });
  maxInDegreeCache = nodes.length ? Math.max(1, ...inDegreeCache.values()) : 1;
  maxDegreeCache   = nodes.length ? Math.max(1, ...totalDegreeCache.values()) : 1;
}

function getNodeDegree(nodeId) {
  return totalDegreeCache.get(nodeId) ?? 0;
}

function getInDegree(nodeId) {
  return inDegreeCache.get(nodeId) ?? 0;
}

function getMaxInDegree() {
  return maxInDegreeCache;
}

function getMaxDegree() {
  return maxDegreeCache;
}

function calcRadius(nodeId) {
  const deg = getInDegree(nodeId);
  if (deg === 0) return R_BASE;
  const maxDeg = getMaxInDegree();
  const t = maxDeg === 1 ? 1 : (deg - 1) / (maxDeg - 1);
  return Math.round(R_MIN + (R_MAX - R_MIN) * t);
}

// ---- LOD: サイズ基準の濃度（最大の80%超は全濃、それ以下を2乗フェード） ----
const LOD_FULL_RATIO = 0.8; // R_MAX のこの割合以上は opacity 1.0
function calcLodOpacity(r) {
  const threshold = R_MAX * LOD_FULL_RATIO;
  if (r >= threshold) return 1;
  const t = Math.max(0, r / threshold);
  // 2乗で大小の差を強調（小: 0.15、threshold到達: 1.0）
  return 0.15 + 0.85 * t * t;
}

function linkLodOpacity(link) {
  const s = getLinkSourceNode(link);
  const tg = getLinkTargetNode(link);
  return Math.min(calcLodOpacity(s?.r ?? R_BASE), calcLodOpacity(tg?.r ?? R_BASE));
}

function updateLodStyles() {
  nodeGroup.selectAll('g.node-group')
    .style('--node-base-lod', node => calcLodOpacity(node.r));
  linkGroup.selectAll('path.link-path')
    .style('--lod', link => linkLodOpacity(link));
  labelGroup.selectAll('text.link-label')
    .style('--lod', link => linkLodOpacity(link));
}

function updateAllRadii() {
  nodes.forEach(node => {
    node.r = calcRadius(node.id);
  });
}

function getSvgSize() {
  const element = document.getElementById(SVG_ID);
  width = element.clientWidth || 800;
  height = element.clientHeight || 600;
}

function updateBiDir() {
  biDirSet.clear();
  biDirPrimarySet.clear();
  biDirSecondarySet.clear();
  const pairSet = new Set();
  links.forEach(link => pairSet.add(`${getLinkSourceId(link)}-${getLinkTargetId(link)}`));
  links.forEach(link => {
    const s = getLinkSourceId(link);
    const t = getLinkTargetId(link);
    if (pairSet.has(`${t}-${s}`)) {
      biDirSet.add(link.id);
      const revLink = links.find(l => getLinkSourceId(l) === t && getLinkTargetId(l) === s);
      if (revLink) {
        if (link.id < revLink.id) biDirPrimarySet.add(link.id);
        else biDirSecondarySet.add(link.id);
      }
    }
  });
}

function clearSelection() {
  selectedNodeId = null;
  applySelectionState();
}

function applySelectionState() {
  // 選択ノードに隣接するノードIDセットを構築
  const connectedIds = new Set();
  if (selectedNodeId !== null) {
    links.forEach(link => {
      const src = getLinkSourceId(link);
      const tgt = getLinkTargetId(link);
      if (src === selectedNodeId) connectedIds.add(tgt);
      if (tgt === selectedNodeId) connectedIds.add(src);
    });
  }

  nodeGroup.selectAll('g.node-group')
    .classed('selected',  node => node.id === selectedNodeId)
    .classed('connected', node => connectedIds.has(node.id));

  linkGroup.selectAll('path.link-path')
    .classed('highlighted-out', link => {
      if (!selectedNodeId) return false;
      const split = isBidirSplit(link);
      // 非スプリット双方向プライマリは highlighted-bidir を使う
      if (biDirPrimarySet.has(link.id) && !split) return false;
      return getLinkSourceId(link) === selectedNodeId;
    })
    .classed('highlighted-in', link => {
      if (!selectedNodeId) return false;
      const split = isBidirSplit(link);
      if (biDirPrimarySet.has(link.id) && !split) return false;
      return getLinkTargetId(link) === selectedNodeId;
    })
    .classed('highlighted-bidir', link => {
      if (!selectedNodeId || !biDirPrimarySet.has(link.id)) return false;
      if (isBidirSplit(link)) return false; // スプリット時は out/in に委ねる
      return getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId;
    })
    .classed('link-bidir-secondary-visible', link => {
      if (!biDirSecondarySet.has(link.id)) return false;
      return isBidirSplit(link);
    })
    .attr('marker-start', link => {
      if (!biDirPrimarySet.has(link.id)) return null;
      return isBidirSplit(link) ? null : 'url(#arrow-bidir-start)';
    });

  // スプリット時はジオメトリが変わるのでパスとラベル位置を再描画
  geometryCache.clear();
  linkGroup.selectAll('path.link-path').attr('d', link => computePath(link));

  labelGroup.selectAll('text.link-label')
    .classed('link-bidir-secondary-visible', link => {
      if (!biDirSecondarySet.has(link.id)) return false;
      return isBidirSplit(link);
    })
    .classed('highlighted', link => {
      if (!selectedNodeId) return false;
      return getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId;
    })
    .classed('highlighted-out', link => {
      if (!selectedNodeId) return false;
      const split = isBidirSplit(link);
      if (biDirPrimarySet.has(link.id) && !split) return false;
      return getLinkSourceId(link) === selectedNodeId;
    })
    .classed('highlighted-in', link => {
      if (!selectedNodeId) return false;
      const split = isBidirSplit(link);
      if (biDirPrimarySet.has(link.id) && !split) return false;
      return getLinkTargetId(link) === selectedNodeId;
    })
    .classed('highlighted-bidir', link => {
      if (!selectedNodeId || !biDirPrimarySet.has(link.id)) return false;
      if (isBidirSplit(link)) return false;
      return getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId;
    })
    .attr('transform', link => {
      const point = getLabelMidpoint(link);
      return `translate(${point.x},${point.y})`;
    });

  svg.classed('selection-active', Boolean(selectedNodeId));

  if (selectedNodeId !== null) {
    const node = nodeById(selectedNodeId);
    if (node) openDetailPanel(node);
  } else {
    closeDetailPanel();
  }
}

function nodeChip(n) {
  const imgTag = n.dataUrl
    ? `<img class="detail-chip-icon" src="${n.dataUrl}" alt="" />`
    : `<span class="detail-chip-icon detail-chip-icon--blank"></span>`;
  return `<span class="detail-chip">${imgTag}<span class="detail-other">${n.name}</span></span>`;
}

function isMobile() {
  return window.matchMedia('(max-width: 640px)').matches;
}

function openDrawer() {
  document.getElementById('sidebar').classList.add('drawer-open');
  document.getElementById('mobile-overlay').classList.add('visible');
  // ドロワーを開いたら詳細パネルを閉じる
  document.getElementById('detail-panel').classList.remove('open');
}

function closeDrawer() {
  document.getElementById('sidebar').classList.remove('drawer-open');
  document.getElementById('mobile-overlay').classList.remove('visible');
}

function openDetailPanel(node) {
  renderDetailPanel(node);
  document.getElementById('detail-panel').classList.add('open');
  // モバイルでは詳細パネルを開いたらドロワーを閉じ、オーバーレイを表示
  if (isMobile()) {
    document.getElementById('sidebar').classList.remove('drawer-open');
    document.getElementById('mobile-overlay').classList.add('visible');
  }
}

function closeDetailPanel() {
  document.getElementById('detail-panel').classList.remove('open');
  // モバイルでは詳細パネルを閉じたらオーバーレイも消す
  if (isMobile()) {
    document.getElementById('mobile-overlay').classList.remove('visible');
  }
}

function renderDetailPanel(node) {
  document.getElementById('detail-icon').src = node.dataUrl || '';
  document.getElementById('detail-name').textContent = node.name;

  // 入力（このノードへ向かう矢印）
  const inList = document.getElementById('detail-in-list');
  inList.innerHTML = '';
  const inLinks = links.filter(l => getLinkTargetId(l) === node.id);
  if (inLinks.length === 0) {
    inList.innerHTML = '<li class="detail-empty">なし</li>';
  } else {
    inLinks.forEach(link => {
      const src = getLinkSourceNode(link);
      if (!src) return;
      const li = document.createElement('li');
      li.className = 'detail-row';
      li.innerHTML =
        `<div class="detail-row-info">` +
          nodeChip(src) +
          `<span class="detail-arrow">→</span>` +
          `<span class="detail-rel">${link.label || '（ラベルなし）'}</span>` +
        `</div>`;
      inList.appendChild(li);
    });
  }

  // 出力（このノードから出る矢印）
  const outList = document.getElementById('detail-out-list');
  outList.innerHTML = '';
  const outLinks = links.filter(l => getLinkSourceId(l) === node.id);
  if (outLinks.length === 0) {
    outList.innerHTML = '<li class="detail-empty">なし</li>';
  } else {
    outLinks.forEach(link => {
      const tgt = getLinkTargetNode(link);
      if (!tgt) return;
      const li = document.createElement('li');
      li.className = 'detail-row';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'detail-row-info';
      infoDiv.innerHTML =
        `<span class="detail-rel">${link.label || '（ラベルなし）'}</span>` +
        `<span class="detail-arrow">→</span>` +
        nodeChip(tgt);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'detail-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'detail-btn-edit';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => openLabelModal(node, tgt, link));

      const delBtn = document.createElement('button');
      delBtn.className = 'detail-btn-del';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        links = links.filter(l => l.id !== link.id);
        broadcastOp('link_delete', { id: link.id });
        scheduleSave();
        restart({ layout: true, fit: false });
      });

      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(delBtn);
      li.appendChild(infoDiv);
      li.appendChild(actionsDiv);
      outList.appendChild(li);
    });
  }
}

// ---- ピボットMDS: グラフ距離をもとにした初期配置 ----
// 繋がりが近いノードを最初から近くに置くことで交差を大幅に削減する
function bfsDistances(startId, adjMap) {
  const dist = new Map();
  dist.set(startId, 0);
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    const d = dist.get(id);
    for (const neighbor of adjMap.get(id) ?? []) {
      if (!dist.has(neighbor)) {
        dist.set(neighbor, d + 1);
        queue.push(neighbor);
      }
    }
  }
  // 非連結ノードはノード数を距離として扱う
  nodes.forEach(n => { if (!dist.has(n.id)) dist.set(n.id, nodes.length); });
  return dist;
}

function seedPivotMdsPositions() {
  getSvgSize();
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    nodes[0].x = width / 2; nodes[0].y = height / 2;
    nodes[0].vx = 0; nodes[0].vy = 0;
    return;
  }

  // 無向隣接マップを構築
  const adj = new Map();
  nodes.forEach(n => adj.set(n.id, []));
  links.forEach(link => {
    const s = getLinkSourceId(link);
    const t = getLinkTargetId(link);
    adj.get(s)?.push(t);
    adj.get(t)?.push(s);
  });

  // ピボット1: 入次数最大ノード（最も参照されている＝中心的）
  const pivot1Id = nodes.reduce((best, n) =>
    getInDegree(n.id) > getInDegree(best.id) ? n : best, nodes[0]).id;

  // ピボット1からBFS → 最遠ノードをピボット2に
  const dist1 = bfsDistances(pivot1Id, adj);
  let pivot2Id = pivot1Id;
  let maxDist = -1;
  dist1.forEach((d, id) => { if (d > maxDist && id !== pivot1Id) { maxDist = d; pivot2Id = id; } });
  if (pivot2Id === pivot1Id) {
    pivot2Id = nodes.find(n => n.id !== pivot1Id)?.id ?? pivot1Id;
  }

  const dist2 = bfsDistances(pivot2Id, adj);

  // dist1 → X軸、dist2 → Y軸 としてキャンバスにスケール
  const xs = nodes.map(n => dist1.get(n.id) ?? 0);
  const ys = nodes.map(n => dist2.get(n.id) ?? 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const margin = Math.min(width, height) * 0.12;
  const scaleX = (width  - margin * 2) / rangeX;
  const scaleY = (height - margin * 2) / rangeY;
  const scale  = Math.min(scaleX, scaleY) * 0.82;
  const cx = width / 2;
  const cy = height / 2;

  nodes.forEach((node, i) => {
    const nx = xs[i] - (minX + maxX) / 2;
    const ny = ys[i] - (minY + maxY) / 2;
    // 同距離ノードが重ならないよう微小ジッターを加える
    node.x = cx + nx * scale + (Math.random() - 0.5) * 18;
    node.y = cy + ny * scale + (Math.random() - 0.5) * 18;
    node.vx = 0;
    node.vy = 0;
  });
}

// ---- 円形初期配置 (BFS 訪問順で隣接ノードを円上で近接させ交差を削減) ----
function seedCircularLayout() {
  getSvgSize();
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    nodes[0].x = width / 2; nodes[0].y = height / 2;
    nodes[0].vx = 0; nodes[0].vy = 0;
    return;
  }

  // 無向隣接マップ
  const adj = new Map();
  nodes.forEach(n => adj.set(n.id, []));
  links.forEach(link => {
    const s = getLinkSourceId(link);
    const t = getLinkTargetId(link);
    adj.get(s)?.push(t);
    adj.get(t)?.push(s);
  });

  // 度数最大ノードを起点にBFSで訪問順を決定
  const startNode = nodes.reduce((best, n) =>
    (adj.get(n.id)?.length ?? 0) > (adj.get(best.id)?.length ?? 0) ? n : best, nodes[0]);
  const order = [];
  const visited = new Set([startNode.id]);
  const queue = [startNode.id];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    // 隣接ノードを次数昇順で並べて探索することで密なクラスタを先にまとめる
    const neighbors = [...(adj.get(id) ?? [])].sort(
      (a, b) => (adj.get(a)?.length ?? 0) - (adj.get(b)?.length ?? 0)
    );
    for (const nb of neighbors) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  // 非連結ノードを末尾に追加
  nodes.forEach(n => { if (!visited.has(n.id)) order.push(n.id); });

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.55;
  const n = nodes.length;
  const orderMap = new Map(order.map((id, i) => [id, i]));

  nodes.forEach(node => {
    const i = orderMap.get(node.id) ?? 0;
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    node.x = cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 12;
    node.y = cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 12;
    node.vx = 0;
    node.vy = 0;
  });
}

function stopActiveLayouts() {
  simulation.stop();
}

function beginLayout() {
  layoutRunId += 1;
  stopActiveLayouts();
  return layoutRunId;
}

function getSimulationTickCount(startAlpha = 1, endAlpha = 0.001) {
  return Math.ceil(Math.log(endAlpha / startAlpha) / Math.log(1 - simulation.alphaDecay()));
}

function fitView(duration = 600) {
  if (nodes.length === 0) return;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  nodes.forEach(node => {
    x0 = Math.min(x0, node.x - node.r - 40);
    y0 = Math.min(y0, node.y - node.r - 40);
    x1 = Math.max(x1, node.x + node.r + 40);
    y1 = Math.max(y1, node.y + node.r + 40);
  });

  const boundsWidth = Math.max(1, x1 - x0);
  const boundsHeight = Math.max(1, y1 - y0);
  const scale = Math.min(width / boundsWidth, height / boundsHeight, 1.5) * 0.9;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;

  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-centerX, -centerY);

  if (duration > 0) {
    svg.transition().duration(duration).call(zoomBehavior.transform, transform);
  } else {
    svg.call(zoomBehavior.transform, transform);
  }
}

function focusNode(node, duration = 500) {
  if (!node) return;
  // 現在の zoom スケールを維持しつつノード中心にパン
  const currentTransform = d3.zoomTransform(svg.node());
  const k = currentTransform.k;
  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(k)
    .translate(-node.x, -node.y);
  svg.transition().duration(duration).call(zoomBehavior.transform, transform);
}

// ---- 検索 ----
function openSearch() {
  document.getElementById('search-bar').classList.remove('hidden');
  const input = document.getElementById('search-input');
  input.focus();
  input.select();
}

function closeSearch() {
  document.getElementById('search-bar').classList.add('hidden');
  document.getElementById('search-input').value = '';
  searchMatches = [];
  searchMatchSet.clear();
  searchIndex = 0;
  nodeGroup.selectAll('g.node-group').classed('search-match', false);
  updateSearchCounter();
}

function updateSearchCounter() {
  const el = document.getElementById('search-counter');
  el.textContent = searchMatches.length === 0 ? '' : `${searchIndex + 1} / ${searchMatches.length}`;
}

function updateSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) {
    searchMatches = [];
    searchMatchSet.clear();
    searchIndex = 0;
    nodeGroup.selectAll('g.node-group').classed('search-match', false);
    updateSearchCounter();
    return;
  }
  const lower = query.toLowerCase();
  searchMatches = nodes
    .filter(n => n.name.toLowerCase().includes(lower))
    .map(n => n.id);
  searchMatchSet = new Set(searchMatches);
  searchIndex = 0;
  nodeGroup.selectAll('g.node-group').classed('search-match', node => searchMatchSet.has(node.id));
  if (searchMatches.length > 0) navigateToSearchMatch();
  updateSearchCounter();
}

function navigateToSearchMatch() {
  if (searchMatches.length === 0) return;
  const id = searchMatches[searchIndex];
  selectedNodeId = id;
  applySelectionState();
  const node = nodeById(id);
  if (node) focusNode(node);
  updateSearchCounter();
}

function searchNext() {
  if (searchMatches.length === 0) return;
  searchIndex = (searchIndex + 1) % searchMatches.length;
  navigateToSearchMatch();
}

function searchPrev() {
  if (searchMatches.length === 0) return;
  searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
  navigateToSearchMatch();
}

// 選択中のノードに接続する双方向リンクかどうか
function isBidirSplit(link) {
  if (!selectedNodeId) return false;
  if (!biDirSet.has(link.id)) return false;
  const s = getLinkSourceId(link);
  const t = getLinkTargetId(link);
  return s === selectedNodeId || t === selectedNodeId;
}

function computeLinkGeometry(link) {
  const cached = geometryCache.get(link.id);
  if (cached !== undefined) return cached;

  const source = getLinkSourceNode(link);
  const target = getLinkTargetNode(link);
  if (!source || !target) { geometryCache.set(link.id, null); return null; }

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / distance, uy = dy / distance;
  const nx = -uy, ny = ux; // 垂直方向（進行方向の左）

  const split = isBidirSplit(link);
  // 非スプリットの双方向プライマリは始端にも矢印スペースを確保
  const startGap = (biDirPrimarySet.has(link.id) && !split) ? source.r + 12 : source.r;
  // スプリット時は垂直方向に対称オフセット
  const side = biDirSecondarySet.has(link.id) ? -1 : 1;
  const offX = split ? nx * BIDIR_SPLIT_OFFSET * side : 0;
  const offY = split ? ny * BIDIR_SPLIT_OFFSET * side : 0;
  const sx = source.x + ux * startGap + offX;
  const sy = source.y + uy * startGap + offY;
  const ex = target.x - ux * (target.r + 12) + offX;
  const ey = target.y - uy * (target.r + 12) + offY;
  const cpx = (sx + ex) / 2;
  const cpy = (sy + ey) / 2;

  const result = { sx, sy, cpx, cpy, ex, ey };
  geometryCache.set(link.id, result);
  return result;
}

function computePath(link) {
  const geometry = computeLinkGeometry(link);
  if (!geometry) return '';
  return `M ${geometry.sx} ${geometry.sy} L ${geometry.ex} ${geometry.ey}`;
}

function getLabelMidpoint(link) {
  const geometry = computeLinkGeometry(link);
  if (!geometry) return { x: 0, y: 0 };
  return { x: geometry.cpx, y: geometry.cpy - 8 };
}

function syncGraphElements() {
  const linkSelection = linkGroup.selectAll('path.link-path')
    .data(links, link => link.id);

  linkSelection.exit().remove();

  const linkEnter = linkSelection.enter()
    .append('path')
    .attr('class', 'link-path')
    .on('click', onLinkClick)
    .on('contextmenu', onLinkRightClick)
    .on('mouseover', (event, link) => showTooltip(event, link.label || '（ラベルなし）'))
    .on('mouseout', hideTooltip);

  linkEnter.merge(linkSelection)
    .attr('marker-start', link => biDirPrimarySet.has(link.id) ? 'url(#arrow-bidir-start)' : null)
    .classed('link-bidir', link => biDirPrimarySet.has(link.id))
    .classed('link-bidir-secondary', link => biDirSecondarySet.has(link.id));

  const labelSelection = labelGroup.selectAll('text.link-label')
    .data(links, link => link.id);

  labelSelection.exit().remove();

  labelSelection.enter()
    .append('text')
    .attr('class', 'link-label')
    .merge(labelSelection)
    .text(link => link.label)
    .classed('link-bidir-secondary', link => biDirSecondarySet.has(link.id));

  const nodeSelection = nodeGroup.selectAll('g.node-group')
    .data(nodes, node => node.id);

  nodeSelection.exit().remove();

  const nodeEnter = nodeSelection.enter()
    .append('g')
    .attr('class', 'node-group')
    .attr('data-id', node => node.id)
    .on('click', onNodeClick)
    .on('contextmenu', onNodeRightClick)
    .on('pointerdown', onNodePointerDown)
    .on('pointerup pointercancel', onNodePointerUp)
    .on('mouseover', (event, node) => showTooltip(event, node.name))
    .on('mouseout', hideTooltip);

  nodeEnter.append('clipPath')
    .attr('id', node => `clip-${node.id}`)
    .append('circle');

  nodeEnter.append('circle').attr('class', 'node-occluder');
  nodeEnter.append('image');
  nodeEnter.append('circle').attr('class', 'node-ring');
  nodeEnter.append('text').attr('class', 'node-label');

  nodeEnter.call(
    d3.drag()
      .on('start', onArrowDragStart)
      .on('drag', onArrowDragMove)
      .on('end', onArrowDragEnd)
  );

  const nodeMerge = nodeEnter.merge(nodeSelection);

  nodeMerge.select('clipPath circle')
    .attr('r', node => node.r)
    .attr('cx', 0)
    .attr('cy', 0);

  nodeMerge.select('.node-occluder')
    .attr('r', node => node.r + 2)
    .attr('cx', 0)
    .attr('cy', 0);

  nodeMerge.select('image')
    .attr('href', node => node.dataUrl || '')
    .attr('x', node => -node.r)
    .attr('y', node => -node.r)
    .attr('width', node => node.r * 2)
    .attr('height', node => node.r * 2)
    .attr('clip-path', node => `url(#clip-${node.id})`);

  nodeMerge.select('.node-ring')
    .attr('r', node => node.r);

  nodeMerge.select('.node-label')
    .attr('y', node => node.r + 20)
    .text(node => node.name);

  ticked();
  updateLodStyles();
  applySelectionState();
}

function ticked() {
  geometryCache.clear();

  linkGroup.selectAll('path.link-path')
    .attr('d', link => computePath(link));

  labelGroup.selectAll('text.link-label')
    .attr('transform', link => {
      const point = getLabelMidpoint(link);
      return `translate(${point.x},${point.y})`;
    });

  nodeGroup.selectAll('g.node-group')
    .attr('transform', node => `translate(${node.x ?? 0},${node.y ?? 0})`);
}

function getForceRadialTarget(node) {
  const inDeg = getInDegree(node.id);
  const maxRadius = Math.min(width, height) * 0.55;
  if (nodes.length <= 1) return 0;
  if (inDeg === 0) return maxRadius;
  const maxInDeg = getMaxInDegree();
  return maxRadius * (1 - inDeg / (maxInDeg + 1)) * 0.85;
}

// 2線分の交差判定 (端点共有は除く)
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const dx1 = bx - ax, dy1 = by - ay;
  const dx2 = dx - cx, dy2 = dy - cy;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * dy2 - (cy - ay) * dx2) / denom;
  const u = ((cx - ax) * dy1 - (cy - ay) * dx1) / denom;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}

// ノード座標配列を使って交差数をカウント (O(m²))
function countCrossings(positions) {
  const evalLinks = links.filter(l => !biDirSecondarySet.has(l.id));
  let count = 0;
  for (let i = 0; i < evalLinks.length; i++) {
    const si = getLinkSourceId(evalLinks[i]);
    const ti = getLinkTargetId(evalLinks[i]);
    const ax = positions.get(si).x, ay = positions.get(si).y;
    const bx = positions.get(ti).x, by = positions.get(ti).y;
    for (let j = i + 1; j < evalLinks.length; j++) {
      const sj = getLinkSourceId(evalLinks[j]);
      const tj = getLinkTargetId(evalLinks[j]);
      if (sj === si || sj === ti || tj === si || tj === ti) continue;
      const cx = positions.get(sj).x, cy = positions.get(sj).y;
      const dx = positions.get(tj).x, dy = positions.get(tj).y;
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) count++;
    }
  }
  return count;
}

// 交差削減: ノードペアをスワップして交差数を hill-climbing で最小化
// ノードオブジェクトの x/y を直接書き換え、改善しなければ戻す
function crossingReduceSwaps() {
  const evalLinks = links.filter(l => !biDirSecondarySet.has(l.id));
  if (evalLinks.length < 2 || nodes.length < 4) return;
  // 大規模グラフは計算コストが高いためスキップ
  if (nodes.length > 80 || evalLinks.length > 120) return;

  // nodeMap はノードオブジェクトへの参照: x/y 変更が即座に反映される
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  function localCrossings() {
    let count = 0;
    for (let i = 0; i < evalLinks.length; i++) {
      const si = getLinkSourceId(evalLinks[i]);
      const ti = getLinkTargetId(evalLinks[i]);
      const na = nodeMap.get(si);
      const nb = nodeMap.get(ti);
      if (!na || !nb) continue;
      const ax = na.x, ay = na.y, bx = nb.x, by = nb.y;
      for (let j = i + 1; j < evalLinks.length; j++) {
        const sj = getLinkSourceId(evalLinks[j]);
        const tj = getLinkTargetId(evalLinks[j]);
        if (sj === si || sj === ti || tj === si || tj === ti) continue;
        const nc = nodeMap.get(sj);
        const nd = nodeMap.get(tj);
        if (!nc || !nd) continue;
        if (segmentsIntersect(ax, ay, bx, by, nc.x, nc.y, nd.x, nd.y)) count++;
      }
    }
    return count;
  }

  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let improved = false;
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const ni = nodes[i], nj = nodes[j];
        const before = localCrossings();

        // スワップ
        let tmp = ni.x; ni.x = nj.x; nj.x = tmp;
        tmp = ni.y; ni.y = nj.y; nj.y = tmp;

        const after = localCrossings();
        if (after < before) {
          improved = true; // スワップを保持
        } else {
          // 元に戻す
          tmp = ni.x; ni.x = nj.x; nj.x = tmp;
          tmp = ni.y; ni.y = nj.y; nj.y = tmp;
        }
      }
    }
    if (!improved) break; // 改善なし → 収束
  }
}

// 1回分のシミュレーションを走らせ、結果の座標マップを返す
function runOneTrial(trialIndex = 0) {
  // 偶数試行: ピボットMDS、奇数試行: BFS円形 (探索空間の多様化)
  if (trialIndex % 2 === 1) {
    seedCircularLayout();
  } else {
    seedPivotMdsPositions();
  }
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('collide').radius(node => node.r + COLLIDE_PADDING);
  simulation.alpha(1);
  simulation.on('tick', null);
  const ticks = getSimulationTickCount(1, 0.001);
  for (let i = 0; i < ticks; i++) simulation.tick();
  simulation.on('tick', ticked);
  const pos = new Map();
  nodes.forEach(n => pos.set(n.id, { x: n.x, y: n.y }));
  return pos;
}

// 座標マップをノードに適用
function applyPositions(positions) {
  nodes.forEach(n => {
    const p = positions.get(n.id);
    if (p) { n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; }
  });
}

const LAYOUT_TRIALS = 5;

function runForceLayout({ fit = true, seed = false } = {}) {
  beginLayout();
  getSvgSize();

  simulation.force('center', d3.forceCenter(width / 2, height / 2));
  simulation.force('radial', d3.forceRadial(node => getForceRadialTarget(node), width / 2, height / 2).strength(0.08));
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('collide').radius(node => node.r + COLLIDE_PADDING);

  // 既存座標が有効かつ seed 不要なら1回だけ走らせる
  const needSeed = seed || nodes.some(n => !Number.isFinite(n.x) || !Number.isFinite(n.y));

  if (!needSeed || links.length < 2) {
    // seed 不要 or リンクが少なくて交差ゼロ確定 → 1回
    if (needSeed) seedPivotMdsPositions();
    simulation.alpha(1);
    simulation.on('tick', null);
    const ticks = getSimulationTickCount(1, 0.001);
    for (let i = 0; i < ticks; i++) simulation.tick();
    simulation.on('tick', ticked);
  } else {
    // 複数回走らせて交差最小の結果を採用
    let bestPos = null;
    let bestCross = Infinity;
    for (let trial = 0; trial < LAYOUT_TRIALS; trial++) {
      const pos = runOneTrial(trial);
      const cross = countCrossings(pos);
      if (cross < bestCross) { bestCross = cross; bestPos = pos; }
      if (cross === 0) break; // 完全に交差なし → 即採用
    }
    applyPositions(bestPos);
    // ノードペアスワップによる局所的な交差削減 (hill-climbing)
    crossingReduceSwaps();
  }

  ticked();
  applySelectionState();
  if (fit) fitView();
}

function applyLayout({ fit = true, seed = false } = {}) {
  if (nodes.length === 0) {
    ticked();
    applySelectionState();
    return;
  }
  runForceLayout({ fit, seed });
}

function restart({ layout = true, fit = layout, seed = false } = {}) {
  getSvgSize();
  rebuildDegreeCache();
  updateAllRadii();
  updateBiDir();
  syncGraphElements();
  if (!layout) {
    ticked();
    applySelectionState();
    if (fit) fitView(0);
    return;
  }
  applyLayout({ fit, seed });
}

function onArrowDragStart(event, node) {
  // ドラッグ開始時に長押しタイマーをキャンセル（コンテキストメニューを抑止）
  if (_longPressTimer !== null) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
  arrowSrc = node;
  dragLine
    .attr('x1', node.x)
    .attr('y1', node.y)
    .attr('x2', node.x)
    .attr('y2', node.y)
    .attr('visibility', 'visible');
  event.sourceEvent.stopPropagation();
}

function onArrowDragMove(event) {
  // event.x/y はD3がタッチ・マウス問わず正しく計算した mainGroup 座標
  dragLine.attr('x2', event.x).attr('y2', event.y);
}

function onArrowDragEnd(event) {
  dragLine.attr('visibility', 'hidden');
  if (!arrowSrc) return;

  const mouseX = event.x, mouseY = event.y;
  const target = nodes.find(node => {
    if (node.id === arrowSrc.id) return false;
    const dx = (node.x ?? 0) - mouseX;
    const dy = (node.y ?? 0) - mouseY;
    return Math.sqrt(dx * dx + dy * dy) <= node.r + 8;
  });

  if (target) {
    const existing = links.find(link =>
      getLinkSourceId(link) === arrowSrc.id && getLinkTargetId(link) === target.id
    );
    openLabelModal(arrowSrc, target, existing ?? null);
  }

  arrowSrc = null;
}

function onNodeClick(event, node) {
  event.stopPropagation();
  hideContextMenu();
  selectedNodeId = selectedNodeId === node.id ? null : node.id;
  applySelectionState();
}

// ---- 長押しによるコンテキストメニュー (タッチ端末対応) ----
let _longPressTimer = null;
const LONG_PRESS_MS = 650;

function onNodePointerDown(event, node) {
  // タッチのみ長押し検出。マウスは contextmenu イベントに任せる
  if (event.pointerType !== 'touch') return;
  // テキスト選択UIが出る前に抑止
  event.preventDefault();
  _longPressTimer = setTimeout(() => {
    _longPressTimer = null;
    showContextMenu(event.clientX, event.clientY, node);
  }, LONG_PRESS_MS);
}

function onNodePointerUp() {
  if (_longPressTimer !== null) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
}

function onNodeRightClick(event, node) {
  event.preventDefault();
  event.stopPropagation();
  showContextMenu(event.clientX, event.clientY, node);
}

function onLinkClick(event, link) {
  event.stopPropagation();
  hideContextMenu();
  openLabelModal(getLinkSourceNode(link), getLinkTargetNode(link), link);
}

function onLinkRightClick(event, link) {
  event.preventDefault();
  event.stopPropagation();
  if (confirm(`「${link.label || '（ラベルなし）'}」の関係を削除しますか？`)) {
    links = links.filter(item => item.id !== link.id);
    broadcastOp('link_delete', { id: link.id });
    scheduleSave();
    restart({ layout: true, fit: true });
  }
}

function openLabelModal(source, target, existing) {
  const overlay = document.getElementById('modal-overlay');
  const desc = document.getElementById('modal-desc');
  const input = document.getElementById('modal-input');

  desc.textContent = `${source.name}  →  ${target.name}`;
  input.value = existing?.label ?? '';
  overlay.classList.remove('hidden');
  input.focus();

  modalCallback = label => {
    if (existing) {
      existing.label = label;
      broadcastOp('link_edit', { id: existing.id, label });
      scheduleSave();
      restart({ layout: false, fit: false });
      return;
    }

    const outCount = links.filter(l => getLinkSourceId(l) === source.id).length;
    if (outCount >= 10) {
      showNotify(`「${source.name}」から出る矢印は最大10本までです。`);
      return;
    }

    const newLink = { id: nextLinkId++, source: source.id, target: target.id, label };
    links.push(newLink);
    broadcastOp('link_add', { link: { id: newLink.id, source: source.id, target: target.id, label } });
    scheduleSave();
    selectedNodeId = source.id;
    restart({ layout: true, fit: false });
    focusNode(nodeById(source.id));
  };
}

function closeModal(ok, label) {
  document.getElementById('modal-overlay').classList.add('hidden');
  if (ok && modalCallback) modalCallback(label ?? '');
  modalCallback = null;
}

function showNotify(message) {
  document.getElementById('notify-message').textContent = message;
  document.getElementById('notify-overlay').classList.remove('hidden');
}

function showContextMenu(clientX, clientY, node) {
  ctxTarget = node;
  const menu = document.getElementById('context-menu');
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  ctxTarget = null;
}

function showTooltip(event, text) {
  const tooltip = document.getElementById('tooltip');
  tooltip.textContent = text;
  tooltip.style.left = `${event.clientX + 12}px`;
  tooltip.style.top = `${event.clientY + 12}px`;
  tooltip.classList.remove('hidden');
}

function hideTooltip() {
  document.getElementById('tooltip').classList.add('hidden');
}

function resizeImage(file, callback) {
  const reader = new FileReader();
  reader.onload = loadEvent => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.getElementById('canvas-resize');
      const context = canvas.getContext('2d');
      const side = Math.min(image.width, image.height);
      const sx = (image.width - side) / 2;
      const sy = (image.height - side) / 2;

      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      context.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
      context.drawImage(image, sx, sy, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
      callback(canvas.toDataURL('image/png'));
    };
    image.src = loadEvent.target.result;
  };
  reader.readAsDataURL(file);
}

document.getElementById('modal-ok').addEventListener('click', () => {
  closeModal(true, document.getElementById('modal-input').value.trim());
});

document.getElementById('modal-cancel').addEventListener('click', () => closeModal(false));

document.getElementById('modal-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('modal-ok').click();
  }
  if (event.key === 'Escape') closeModal(false);
});

document.getElementById('ctx-edit-name').addEventListener('click', () => {
  const target = ctxTarget;
  if (!target) return;
  hideContextMenu();

  const titleEl = document.getElementById('modal-title');
  const descEl  = document.getElementById('modal-desc');
  const inputEl = document.getElementById('modal-input');
  titleEl.textContent = '名前を変更';
  descEl.textContent  = '';
  inputEl.value       = target.name;
  inputEl.placeholder = '名前を入力';

  document.getElementById('modal-overlay').classList.remove('hidden');
  inputEl.focus();
  inputEl.select();

  modalCallback = newName => {
    if (newName.trim()) {
      target.name = newName.trim();
      broadcastOp('node_rename', { id: target.id, name: target.name });
      scheduleSave();
      restart({ layout: false, fit: false });
    }
    // モーダルタイトルを元に戻す
    titleEl.textContent = '関係を入力';
    inputEl.placeholder = '例：友人、同僚、ライバル';
  };
});

document.getElementById('ctx-edit-icon').addEventListener('click', () => {
  const target = ctxTarget;
  if (!target) return;
  hideContextMenu();

  document.getElementById('modal-icon-desc').textContent = target.name;
  document.getElementById('modal-icon-overlay').classList.remove('hidden');

  // 前回のリスナーを確実に除去してから登録
  const fileInput = document.getElementById('input-icon-change');
  fileInput.value = '';
  const newInput = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(newInput, fileInput);

  const onchange = () => {
    const file = newInput.files[0];
    document.getElementById('modal-icon-overlay').classList.add('hidden');
    if (!file) return;
    resizeImage(file, async dataUrl => {
      const displayUrl = await uploadIconToStorage(dataUrl);
      target.dataUrl = displayUrl;
      broadcastOp('node_icon', { id: target.id, dataUrl: displayUrl });
      scheduleSave();
      restart({ layout: false, fit: false });
    });
  };
  newInput.addEventListener('change', onchange, { once: true });
});

document.getElementById('modal-icon-cancel').addEventListener('click', () => {
  const fileInput = document.getElementById('input-icon-change');
  if (fileInput) fileInput.value = '';
  document.getElementById('modal-icon-overlay').classList.add('hidden');
});

document.getElementById('notify-ok').addEventListener('click', () => {
  document.getElementById('notify-overlay').classList.add('hidden');
});

document.getElementById('detail-close').addEventListener('click', () => {
  clearSelection();
});

// ハンバーガー・モバイルオーバーレイ
document.getElementById('btn-hamburger').addEventListener('click', () => {
  const isOpen = document.getElementById('sidebar').classList.contains('drawer-open');
  if (isOpen) closeDrawer(); else openDrawer();
});
document.getElementById('mobile-overlay').addEventListener('click', () => {
  closeDrawer();
  clearSelection(); // 詳細パネルも閉じる
});

document.getElementById('ctx-delete').addEventListener('click', () => {
  if (!ctxTarget) return;
  const targetId = ctxTarget.id;
  nodes = nodes.filter(node => node.id !== targetId);
  links = links.filter(link => getLinkSourceId(link) !== targetId && getLinkTargetId(link) !== targetId);
  if (selectedNodeId === targetId) selectedNodeId = null;
  hideContextMenu();
  broadcastOp('node_delete', { id: targetId });
  scheduleSave();
  restart({ layout: true, fit: true, seed: true });
});

document.getElementById('input-icon').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  resizeImage(file, dataUrl => {
    pendingDataUrl = dataUrl;
    const preview = document.getElementById('icon-preview');
    preview.src = dataUrl;
    preview.style.display = 'block';
    document.getElementById('icon-preview-label').textContent = file.name;
  });
});

document.getElementById('btn-add-person').addEventListener('click', async () => {
  const nameElement = document.getElementById('input-name');
  const name = nameElement.value.trim();
  if (!name) {
    showNotify('名前を入力してください');
    return;
  }

  getSvgSize();
  const rawDataUrl = pendingDataUrl ?? '';
  const displayUrl = rawDataUrl ? await uploadIconToStorage(rawDataUrl) : '';
  const newNode = {
    id: nextNodeId++,
    name,
    dataUrl: displayUrl,
    r: R_BASE,
    x: width / 2 + Math.cos(Math.random() * Math.PI * 2) * 180,
    y: height / 2 + Math.sin(Math.random() * Math.PI * 2) * 180,
  };
  nodes.push(newNode);
  broadcastOp('node_add', { node: { id: newNode.id, name: newNode.name, dataUrl: newNode.dataUrl, x: newNode.x, y: newNode.y } });
  scheduleSave();

  nameElement.value = '';
  pendingDataUrl = null;
  const preview = document.getElementById('icon-preview');
  preview.style.display = 'none';
  preview.src = '';
  document.getElementById('icon-preview-label').textContent = 'アイコン画像を選択';
  document.getElementById('input-icon').value = '';

  restart({ layout: true, fit: true });
});

document.getElementById('btn-relayout').addEventListener('click', () => {
  seedPivotMdsPositions();
  restart({ layout: true, fit: true, seed: true });
});

document.getElementById('btn-save').addEventListener('click', () => {
  const data = {
    nodes: nodes.map(node => ({ id: node.id, name: node.name, dataUrl: node.dataUrl })),
    links: links.map(link => ({
      id: link.id,
      source: getLinkSourceId(link),
      target: getLinkTargetId(link),
      label: link.label,
    })),
    meta: {
      nextNodeId,
      nextLinkId,
    },
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = 'relation-map.json';
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

document.getElementById('input-load').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = loadEvent => {
    try {
      const data = JSON.parse(loadEvent.target.result);
      nodes = data.nodes.map(node => ({ ...node, r: R_BASE }));
      links = data.links.map(link => ({ ...link }));
      nextNodeId = data.meta?.nextNodeId ?? (Math.max(0, ...nodes.map(node => node.id)) + 1);
      nextLinkId = data.meta?.nextLinkId ?? (Math.max(0, ...links.map(link => link.id)) + 1);

      seedPivotMdsPositions();
      restart({ layout: true, fit: true, seed: true });
    } catch {
      showNotify('JSON の読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
  this.value = '';
});

svg.on('click.selection', () => clearSelection());

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('contextmenu', event => {
  if (!event.defaultPrevented) hideContextMenu();
});

// 検索バーイベント
document.getElementById('search-input').addEventListener('input', updateSearch);
document.getElementById('search-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) searchPrev(); else searchNext();
  } else if (event.key === 'Escape') {
    closeSearch();
  }
});
document.getElementById('search-prev').addEventListener('click', searchPrev);
document.getElementById('search-next').addEventListener('click', searchNext);
document.getElementById('search-close').addEventListener('click', closeSearch);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
    event.preventDefault();
    openSearch();
  }
});

document.getElementById('context-menu').addEventListener('click', event => {
  event.stopPropagation();
});

window.addEventListener('resize', () => {
  getSvgSize();
  if (nodes.length === 0) return;
  fitView(0);
});

// ============================================================
//  Supabase / ホスティングモード
// ============================================================

// supabase-client.js が window.sb を設定する（設定値がなければ null）
const sb = window.sb ?? null;

let mapId = null;
let currentUser = null;
let realtimeChannel = null;
let saveTimer = null;
const CLIENT_ID = crypto.randomUUID();

function parseMapId() {
  const m = window.location.pathname.match(
    /^\/map\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
  );
  return m ? m[1] : null;
}

function isHosted() {
  return Boolean(sb && mapId);
}

function updateAuthUI() {
  const btnLogin  = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  const userLabel = document.getElementById('auth-user-label');
  if (!btnLogin) return;
  if (currentUser) {
    btnLogin.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    userLabel.textContent = currentUser.user_metadata?.full_name || currentUser.email || '';
    userLabel.classList.remove('hidden');
  } else {
    btnLogin.classList.remove('hidden');
    btnLogout.classList.add('hidden');
    userLabel.classList.add('hidden');
  }
}

function updateMapModeUI() {
  const sectionJson    = document.getElementById('section-json');
  const sectionMapMode = document.getElementById('section-map-mode');
  if (isHosted()) {
    sectionJson.classList.add('hidden');
    sectionMapMode.classList.remove('hidden');
  } else {
    sectionJson.classList.remove('hidden');
    sectionMapMode.classList.add('hidden');
  }
}

async function loadMapFromDB(id) {
  const { data, error } = await sb.from('maps').select('data').eq('id', id).single();
  if (error || !data) {
    showNotify('マップが見つかりません');
    return;
  }
  const mapData = data.data;
  nodes      = (mapData.nodes ?? []).map(n => ({ ...n, r: R_BASE }));
  links      = (mapData.links ?? []).map(l => ({ ...l }));
  nextNodeId = mapData.meta?.nextNodeId ?? (nodes.length ? Math.max(...nodes.map(n => n.id)) + 1 : 1);
  nextLinkId = mapData.meta?.nextLinkId ?? (links.length ? Math.max(...links.map(l => l.id)) + 1 : 1);
  seedPivotMdsPositions();
  restart({ layout: true, fit: true, seed: true });
}

function buildSaveData() {
  return {
    nodes: nodes.map(n => ({ id: n.id, name: n.name, dataUrl: n.dataUrl ?? '' })),
    links: links.map(l => ({
      id: l.id,
      source: getLinkSourceId(l),
      target: getLinkTargetId(l),
      label: l.label,
    })),
    meta: { nextNodeId, nextLinkId },
  };
}

async function saveMapToDB() {
  if (!isHosted()) return;
  await sb.from('maps')
    .update({ data: buildSaveData(), updated_at: new Date().toISOString() })
    .eq('id', mapId);
}

function scheduleSave() {
  if (!isHosted()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMapToDB, 500);
}

async function createMapInDB() {
  const savedData = localStorage.getItem('pendingMapData');
  const mapData   = savedData ? JSON.parse(savedData) : buildSaveData();
  localStorage.removeItem('pendingMapData');

  const { data, error } = await sb.from('maps')
    .insert({ owner_id: currentUser.id, title: '無題マップ', data: mapData })
    .select('id')
    .single();

  if (error || !data) {
    showNotify('マップの作成に失敗しました');
    return;
  }

  mapId = data.id;
  window.history.pushState({}, '', `/map/${mapId}`);

  // OAuth リダイレクト後に復元したデータを再セット
  if (savedData) {
    const restored = JSON.parse(savedData);
    nodes      = (restored.nodes ?? []).map(n => ({ ...n, r: R_BASE }));
    links      = (restored.links ?? []).map(l => ({ ...l }));
    nextNodeId = restored.meta?.nextNodeId ?? 1;
    nextLinkId = restored.meta?.nextLinkId ?? 1;
    restart({ layout: false, fit: false });
  }

  subscribeRealtime(mapId);
  updateMapModeUI();
}

async function createNewMap() {
  if (!sb) return;
  if (!currentUser) {
    // ログイン前に現在の状態を保存しておき、OAuth 後に復元
    sessionStorage.setItem('pendingCreateMap', '1');
    localStorage.setItem('pendingMapData', JSON.stringify(buildSaveData()));
    await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    return;
  }
  await createMapInDB();
}

function subscribeRealtime(id) {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel(`map:${id}`)
    .on('broadcast', { event: 'op' }, ({ payload }) => {
      if (payload.clientId === CLIENT_ID) return;
      applyRemoteOp(payload);
    })
    .subscribe();
}

function broadcastOp(op, data) {
  if (!realtimeChannel) return;
  realtimeChannel.send({
    type: 'broadcast',
    event: 'op',
    payload: { op, ...data, clientId: CLIENT_ID },
  });
}

function applyRemoteOp(payload) {
  const { op } = payload;
  switch (op) {
    case 'node_add':
      if (!nodes.find(n => n.id === payload.node.id)) {
        nodes.push({ ...payload.node, r: R_BASE });
        if (payload.node.id >= nextNodeId) nextNodeId = payload.node.id + 1;
      }
      break;
    case 'node_delete':
      nodes = nodes.filter(n => n.id !== payload.id);
      links = links.filter(l =>
        getLinkSourceId(l) !== payload.id && getLinkTargetId(l) !== payload.id
      );
      if (selectedNodeId === payload.id) selectedNodeId = null;
      break;
    case 'node_rename': {
      const n = nodeById(payload.id);
      if (n) n.name = payload.name;
      break;
    }
    case 'node_icon': {
      const n = nodeById(payload.id);
      if (n) n.dataUrl = payload.dataUrl;
      break;
    }
    case 'link_add':
      if (!links.find(l => l.id === payload.link.id)) {
        links.push({ ...payload.link });
        if (payload.link.id >= nextLinkId) nextLinkId = payload.link.id + 1;
      }
      break;
    case 'link_delete':
      links = links.filter(l => l.id !== payload.id);
      break;
    case 'link_edit': {
      const l = links.find(l => l.id === payload.id);
      if (l) l.label = payload.label;
      break;
    }
    default: break;
  }
  const needsLayout =
    op === 'node_add' || op === 'node_delete' ||
    op === 'link_add' || op === 'link_delete';
  restart({ layout: needsLayout, fit: false });
}

async function uploadIconToStorage(dataUrl) {
  if (!isHosted()) return dataUrl;
  try {
    const blob = await fetch(dataUrl).then(r => r.blob());
    const path = `${mapId}/${CLIENT_ID}-${Date.now()}.png`;
    const { error } = await sb.storage.from('icons').upload(path, blob, { contentType: 'image/png' });
    if (error) return dataUrl;
    return sb.storage.from('icons').getPublicUrl(path).data.publicUrl;
  } catch {
    return dataUrl;
  }
}

function copyShareLink() {
  navigator.clipboard.writeText(window.location.href).then(() => {
    showNotify('共有リンクをコピーしました');
  });
}

// ---- 認証 UI イベント ----
document.getElementById('btn-login')?.addEventListener('click', async () => {
  if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
});

document.getElementById('btn-logout')?.addEventListener('click', async () => {
  if (!sb) return;
  await sb.auth.signOut();
});

document.getElementById('btn-create-map')?.addEventListener('click', createNewMap);
document.getElementById('btn-copy-share')?.addEventListener('click', copyShareLink);

// ---- 初期化 ----
getSvgSize();
restart({ layout: false, fit: false });

if (sb) {
  sb.auth.getSession().then(({ data: { session } }) => {
    currentUser = session?.user ?? null;
    updateAuthUI();
  });

  sb.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user ?? null;
    updateAuthUI();
    if (event === 'SIGNED_IN' && sessionStorage.getItem('pendingCreateMap') === '1') {
      sessionStorage.removeItem('pendingCreateMap');
      createMapInDB();
    }
  });

  mapId = parseMapId();
  if (mapId) {
    loadMapFromDB(mapId).then(() => subscribeRealtime(mapId));
    updateMapModeUI();
  }
}
