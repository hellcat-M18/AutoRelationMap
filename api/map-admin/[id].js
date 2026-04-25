import fs from 'fs';
import path from 'path';

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

  const adminPath = path.join(process.cwd(), 'admin.html');
  const html = fs.readFileSync(adminPath, 'utf-8');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}
