// ============================================================
//  gen-sample.js
//  100人規模のサンプルデータを生成して relation-map.json に出力
//  使い方: node gen-sample.js [人数] [最大関係数]
//  例: node gen-sample.js 100 5
// ============================================================

const fs = require('fs');
const path = require('path');

// ---- パラメータ ----
const NODE_COUNT  = parseInt(process.argv[2]) || 100;
const MAX_DEGREE  = parseInt(process.argv[3]) || 5;   // 1人あたりの最大関係数
const EDGE_PROB   = 0.06;                              // 任意2人が繋がる確率（密度調整）

// ---- 名前素材 ----
const SURNAMES = [
  '佐藤','鈴木','高橋','田中','渡辺','伊藤','山本','中村','小林','加藤',
  '吉田','山田','佐々木','山口','松本','井上','木村','林','斎藤','清水',
  '山崎','阿部','森','池田','橋本','石川','前田','藤田','岡田','後藤',
  '長谷川','石井','近藤','坂本','遠藤','青木','藤井','西村','福田','三浦',
];
const GIVEN = [
  '蓮','陽翔','湊','律','碧','蒼','悠人','大和','朝陽','陸',
  'さくら','陽菜','凛','美咲','結衣','莉子','葵','心春','柚希','桃花',
  '翔','海斗','樹','颯','悠斗','大輝','勇気','颯太','直樹','健太',
  '花','紫苑','詩音','彩','奈々','千夏','涼香','七海','茉莉','杏',
];

// ---- 関係ラベル ----
const LABELS = [
  '友人','親友','幼なじみ','同僚','上司','部下','ライバル','恋人','元恋人',
  '師匠','弟子','兄弟','姉妹','親子','隣人','知人','恩人','宿敵','協力者',
  'チームメイト','クラスメイト','取引先','保護者','指導者','支持者',
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

// ---- ノード生成 ----
const nodes = [];
const usedNames = new Set();
for (let i = 1; i <= NODE_COUNT; i++) {
  let name;
  let tries = 0;
  do {
    name = rand(SURNAMES) + ' ' + rand(GIVEN);
    tries++;
  } while (usedNames.has(name) && tries < 50);
  usedNames.add(name);
  nodes.push({ id: i, name, dataUrl: '' });
}

// ---- エッジ生成 ----
// 各ノードの次数を管理して MAX_DEGREE を超えないようにする
const degree = new Array(NODE_COUNT + 1).fill(0);
const edgeSet = new Set();
const links  = [];
let linkId = 1;

// ランダムな接続（スケールフリー寄りに: 次数が高いほど選ばれやすい）
for (let si = 1; si <= NODE_COUNT; si++) {
  // 自分の接続数が上限に達したらスキップ
  if (degree[si] >= MAX_DEGREE) continue;

  for (let ti = 1; ti <= NODE_COUNT; ti++) {
    if (ti === si) continue;
    if (degree[si] >= MAX_DEGREE || degree[ti] >= MAX_DEGREE) continue;
    if (Math.random() > EDGE_PROB) continue;

    const key = `${si}-${ti}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);

    links.push({
      id: linkId++,
      source: si,
      target: ti,
      label: rand(LABELS),
    });
    degree[si]++;
    degree[ti]++;
  }
}

// 孤立ノード（次数0）が出やすいので最低1本繋ぐ
for (let i = 1; i <= NODE_COUNT; i++) {
  if (degree[i] > 0) continue;
  // ランダムな相手を探す
  for (let tries = 0; tries < 20; tries++) {
    const ti = randInt(1, NODE_COUNT);
    if (ti === i || degree[ti] >= MAX_DEGREE) continue;
    const key = `${i}-${ti}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    links.push({ id: linkId++, source: i, target: ti, label: rand(LABELS) });
    degree[i]++;
    degree[ti]++;
    break;
  }
}

// ---- 出力 ----
const data = {
  nodes,
  links,
  meta: { nextNodeId: NODE_COUNT + 1, nextLinkId: linkId },
};

const outPath = path.join(__dirname, 'relation-map-sample.json');
fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');

// ---- 統計表示 ----
const degArr = nodes.map(n => degree[n.id]).sort((a, b) => b - a);
const isolated = degArr.filter(d => d === 0).length;
const avg = (degArr.reduce((s, d) => s + d, 0) / degArr.length).toFixed(2);
console.log(`✓ 生成完了: ${outPath}`);
console.log(`  ノード数  : ${nodes.length}`);
console.log(`  エッジ数  : ${links.length}`);
console.log(`  平均次数  : ${avg}`);
console.log(`  最大次数  : ${degArr[0]}`);
console.log(`  孤立ノード: ${isolated}`);
