import fs from 'fs';
import path from 'path';

// content="summary" だと画像なしの小さいカード、"summary_large_image" だと横長カード
const TWITTER_CARD = 'summary';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export default async function handler(req, res) {
  const { id } = req.query;

  // UUID バリデーション（インジェクション対策）
  if (!isValidUuid(id)) {
    res.status(404).send('Not found');
    return;
  }

  let title = 'AutoRelationMap';
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/maps?id=eq.${id}&select=title`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );
    const data = await resp.json();
    if (data?.[0]?.title) title = data[0].title;
  } catch {
    // タイトル取得失敗時はデフォルト値を使用
  }

  const siteUrl = `https://${req.headers.host}`;
  const pageUrl = `${siteUrl}/map/${id}`;
  const fullTitle = `${escapeHtml(title)} - AutoRelationMap`;
  const description = '相関図マップ';

  const ogTags = `
    <meta property="og:title" content="${fullTitle}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${escapeHtml(pageUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="AutoRelationMap" />
    <meta name="twitter:card" content="${TWITTER_CARD}" />
    <meta name="twitter:title" content="${fullTitle}" />
    <meta name="twitter:description" content="${description}" />`;

  // index.html を読み込んでタイトル + OGP タグを注入
  const indexPath = path.join(process.cwd(), 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');
  html = html.replace(/<title>.*?<\/title>/, `<title>${fullTitle}</title>`);
  html = html.replace('</head>', `${ogTags}\n</head>`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.send(html);
}
