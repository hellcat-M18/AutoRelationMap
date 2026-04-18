// Vercel Edge Function
// GET /config.js → window.SUPABASE_URL と window.SUPABASE_ANON_KEY を JS として返す
export default function handler(req, res) {
  // 値にダブルクォートや改行が入らないよう最低限サニタイズ
  const sanitize = v => (v || '').replace(/["\\]/g, '');
  const url = sanitize(process.env.SUPABASE_URL);
  const key = sanitize(process.env.SUPABASE_ANON_KEY);

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`window.SUPABASE_URL="${url}";window.SUPABASE_ANON_KEY="${key}";`);
}
