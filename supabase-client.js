// supabase-client.js
// 依存: config.js (window.SUPABASE_URL / window.SUPABASE_ANON_KEY を設定)
//       @supabase/supabase-js UMD (window.supabase を設定)
// 結果: window.sb に Supabase クライアントを設定（設定値がなければ null）
window.sb = (() => {
  const url = window.SUPABASE_URL;
  const key = window.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return window.supabase.createClient(url, key);
})();
