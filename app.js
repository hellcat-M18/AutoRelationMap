// ============================================================
//  AutoRelationMap – app.js
// ============================================================

const SVG_ID = 'map-svg';
const ICON_SIZE = 120;
const R_BASE = 32;
const R_MIN = 28;
const R_MAX = 110;
const CURVE_AMOUNT = 55;
const CURVE_BASE = 30;
const FORCE_LINK_GAP = 220;
const COLLIDE_PADDING = 90;

let nodes = [];
let links = [];
let nextNodeId = 1;
let nextLinkId = 1;
let biDirSet = new Set();
let pendingDataUrl = null;
let selectedNodeId = null;
let arrowSrc = null;
let ctxTarget = null;
let modalCallback = null;
let width = 0;
let height = 0;
let layoutRunId = 0;
let currentZoomK = 1;

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
    currentZoomK = event.transform.k;
    updateLodStyles();
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

const simulation = d3.forceSimulation()
  .alphaDecay(0.0228)
  .force('link', d3.forceLink().id(node => node.id).distance(link => {
    const source = getLinkSourceNode(link);
    const target = getLinkTargetNode(link);
    return (source?.r ?? R_BASE) + (target?.r ?? R_BASE) + FORCE_LINK_GAP;
  }).strength(0.25))
  .force('charge', d3.forceManyBody().strength(-2200).distanceMax(1200))
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

// ---- LOD: サイズ基準の濃度（2乗 + ズーム連動） ----
function calcLodOpacity(r) {
  // ズームアウトしても減衰しない (k<1 は k=1 として扱う)
  const effectiveK = Math.max(1, currentZoomK);
  const effectiveR = r * effectiveK;
  const t = Math.max(0, Math.min(1, (effectiveR - R_MIN) / (R_MAX - R_MIN)));
  // 2乗で大小の差を強調（小: 0.15、大: 1.0）
  return 0.15 + 0.85 * t * t;
}

function linkLodOpacity(link) {
  const s = getLinkSourceNode(link);
  const tg = getLinkTargetNode(link);
  return Math.min(calcLodOpacity(s?.r ?? R_BASE), calcLodOpacity(tg?.r ?? R_BASE));
}

function updateLodStyles() {
  nodeGroup.selectAll('g.node-group')
    .style('--lod', node => calcLodOpacity(node.r));
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
  const pairSet = new Set();
  links.forEach(link => pairSet.add(`${getLinkSourceId(link)}-${getLinkTargetId(link)}`));
  links.forEach(link => {
    if (pairSet.has(`${getLinkTargetId(link)}-${getLinkSourceId(link)}`)) {
      biDirSet.add(link.id);
    }
  });
}

function clearLinkRouting() {
  links.forEach(link => {
    delete link.routePoints;
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
      return getLinkSourceId(link) === selectedNodeId;
    })
    .classed('highlighted-in', link => {
      if (!selectedNodeId) return false;
      return getLinkTargetId(link) === selectedNodeId;
    });

  labelGroup.selectAll('text.link-label')
    .classed('highlighted', link => {
      if (!selectedNodeId) return false;
      return getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId;
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

function openDetailPanel(node) {
  renderDetailPanel(node);
  document.getElementById('detail-panel').classList.add('open');
}

function closeDetailPanel() {
  document.getElementById('detail-panel').classList.remove('open');
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

function seedCircularPositions() {
  getSvgSize();
  const radius = Math.min(width, height) * 0.3;
  const ordered = [...nodes].sort((a, b) => getInDegree(b.id) - getInDegree(a.id) || a.id - b.id);

  ordered.forEach((node, index) => {
    const angle = (index / Math.max(ordered.length, 1)) * Math.PI * 2;
    node.x = width / 2 + Math.cos(angle) * radius;
    node.y = height / 2 + Math.sin(angle) * radius;
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
  clearLinkRouting();
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

function computeCurve(link) {
  const sourceId = getLinkSourceId(link);
  const targetId = getLinkTargetId(link);
  const sign = ((sourceId * 7 + targetId * 13) % 2 === 0) ? 1 : -1;
  if (biDirSet.has(link.id)) return CURVE_AMOUNT;
  return CURVE_BASE * sign;
}

function computeCurvedGeometry(link) {
  const cached = geometryCache.get(link.id);
  if (cached !== undefined) return cached;

  const source = getLinkSourceNode(link);
  const target = getLinkTargetNode(link);
  if (!source || !target) { geometryCache.set(link.id, null); return null; }

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / distance;
  const ny = dx / distance;
  const curve = computeCurve(link);
  const cpx = (source.x + target.x) / 2 + nx * curve;
  const cpy = (source.y + target.y) / 2 + ny * curve;

  const sourceDx = cpx - source.x;
  const sourceDy = cpy - source.y;
  const sourceDistance = Math.sqrt(sourceDx * sourceDx + sourceDy * sourceDy) || 1;
  const sx = source.x + sourceDx / sourceDistance * source.r;
  const sy = source.y + sourceDy / sourceDistance * source.r;

  const targetDx = cpx - target.x;
  const targetDy = cpy - target.y;
  const targetDistance = Math.sqrt(targetDx * targetDx + targetDy * targetDy) || 1;
  const ex = target.x + targetDx / targetDistance * (target.r + 12);
  const ey = target.y + targetDy / targetDistance * (target.r + 12);

  const result = { sx, sy, cpx, cpy, ex, ey };
  geometryCache.set(link.id, result);
  return result;
}

function computePath(link) {
  const geometry = computeCurvedGeometry(link);
  if (!geometry) return '';
  return `M ${geometry.sx} ${geometry.sy} Q ${geometry.cpx} ${geometry.cpy} ${geometry.ex} ${geometry.ey}`;
}

function getLabelMidpoint(link) {
  const geometry = computeCurvedGeometry(link);
  if (!geometry) return { x: 0, y: 0 };
  return {
    x: 0.25 * geometry.sx + 0.5 * geometry.cpx + 0.25 * geometry.ex,
    y: 0.25 * geometry.sy + 0.5 * geometry.cpy + 0.25 * geometry.ey - 8,
  };
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

  const labelSelection = labelGroup.selectAll('text.link-label')
    .data(links, link => link.id);

  labelSelection.exit().remove();

  labelSelection.enter()
    .append('text')
    .attr('class', 'link-label')
    .merge(labelSelection)
    .text(link => link.label);

  const nodeSelection = nodeGroup.selectAll('g.node-group')
    .data(nodes, node => node.id);

  nodeSelection.exit().remove();

  const nodeEnter = nodeSelection.enter()
    .append('g')
    .attr('class', 'node-group')
    .attr('data-id', node => node.id)
    .on('click', onNodeClick)
    .on('contextmenu', onNodeRightClick)
    .on('mouseover', (event, node) => showTooltip(event, node.name))
    .on('mouseout', hideTooltip);

  nodeEnter.append('clipPath')
    .attr('id', node => `clip-${node.id}`)
    .append('circle');

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
  const maxRadius = Math.min(width, height) * 0.38;
  if (nodes.length <= 1) return 0;
  if (inDeg === 0) return maxRadius;
  const maxInDeg = getMaxInDegree();
  return maxRadius * (1 - inDeg / (maxInDeg + 1)) * 0.85;
}

function runForceLayout({ fit = true, seed = false } = {}) {
  beginLayout();
  if (seed || nodes.some(node => !Number.isFinite(node.x) || !Number.isFinite(node.y))) {
    seedCircularPositions();
  }

  simulation.force('center', d3.forceCenter(width / 2, height / 2));
  simulation.force('radial', d3.forceRadial(node => getForceRadialTarget(node), width / 2, height / 2).strength(0.18));
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('collide').radius(node => node.r + COLLIDE_PADDING);
  simulation.alpha(1);

  // レイアウト計算中は DOM 更新を止めて高速化
  simulation.on('tick', null);
  const ticks = getSimulationTickCount(1, 0.001);
  for (let index = 0; index < ticks; index += 1) {
    simulation.tick();
  }
  simulation.on('tick', ticked);

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
  const [mouseX, mouseY] = d3.pointer(event.sourceEvent, mainGroup.node());
  dragLine.attr('x2', mouseX).attr('y2', mouseY);
}

function onArrowDragEnd(event) {
  dragLine.attr('visibility', 'hidden');
  if (!arrowSrc) return;

  const [mouseX, mouseY] = d3.pointer(event.sourceEvent, mainGroup.node());
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

// ============================================================
//  クロップ機能
// ============================================================

const CROP_MAX    = 400;
const HANDLE_R    = 8;
const MIN_CROP_SZ = 40;

let cropImage        = null;
let cropDisplayScale = 1;
let cropRect         = { x: 0, y: 0, size: 0 };
let cropDragState    = null;
let cropCallback     = null;

function openCropModal(file, callback) {
  cropCallback = callback;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      cropImage = img;
      initCropCanvas();
      document.getElementById('modal-crop-overlay').classList.remove('hidden');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function initCropCanvas() {
  const canvas = document.getElementById('crop-canvas');
  const img    = cropImage;
  const scale  = Math.min(CROP_MAX / img.width, CROP_MAX / img.height, 1);
  canvas.width  = Math.round(img.width  * scale);
  canvas.height = Math.round(img.height * scale);
  cropDisplayScale = scale;
  const size = Math.min(canvas.width, canvas.height);
  cropRect = { x: (canvas.width - size) / 2, y: (canvas.height - size) / 2, size };
  renderCropCanvas();
}

function renderCropCanvas() {
  const canvas = document.getElementById('crop-canvas');
  const ctx    = canvas.getContext('2d');
  const { x, y, size } = cropRect;

  ctx.drawImage(cropImage, 0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.drawImage(cropImage, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(x + 0.75, y + 0.75, size - 1.5, size - 1.5);

  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth   = 0.75;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(x + size * i / 3, y);      ctx.lineTo(x + size * i / 3, y + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x,      y + size * i / 3); ctx.lineTo(x + size, y + size * i / 3); ctx.stroke();
  }

  cropCornerPositions().forEach(([cx, cy]) => {
    ctx.beginPath();
    ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle   = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#1a6fa5';
    ctx.lineWidth   = 2;
    ctx.stroke();
  });
}

function cropCornerPositions() {
  const { x, y, size } = cropRect;
  return [[x, y], [x + size, y], [x, y + size], [x + size, y + size]];
}

function cropHitCorner(px, py) {
  return cropCornerPositions().findIndex(([cx, cy]) => {
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= (HANDLE_R + 4) * (HANDLE_R + 4);
  });
}

function cropInsideRect(px, py) {
  return px >= cropRect.x && px <= cropRect.x + cropRect.size &&
         py >= cropRect.y && py <= cropRect.y + cropRect.size;
}

function cropEventPos(e) {
  const canvas = document.getElementById('crop-canvas');
  const r = canvas.getBoundingClientRect();
  return [
    (e.clientX - r.left) * (canvas.width  / r.width),
    (e.clientY - r.top)  * (canvas.height / r.height),
  ];
}

function resizeImage(file, callback) {
  openCropModal(file, callback);
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

  // 選択済みファイルをリセット
  const fileInput = document.getElementById('input-icon-change');
  fileInput.value = '';

  // ファイル選択後の処理をセット（one-time）
  const onchange = () => {
    const file = fileInput.files[0];
    fileInput.removeEventListener('change', onchange);
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
  fileInput.addEventListener('change', onchange);
});

document.getElementById('modal-icon-cancel').addEventListener('click', () => {
  document.getElementById('input-icon-change').value = '';
  document.getElementById('modal-icon-overlay').classList.add('hidden');
});

document.getElementById('notify-ok').addEventListener('click', () => {
  document.getElementById('notify-overlay').classList.add('hidden');
});

document.getElementById('detail-close').addEventListener('click', () => {
  clearSelection();
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
  seedCircularPositions();
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

      seedCircularPositions();
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

document.getElementById('context-menu').addEventListener('click', event => {
  event.stopPropagation();
});

window.addEventListener('resize', () => {
  getSvgSize();
  if (nodes.length === 0) return;
  fitView(0);
});

// ---- クロップモーダル イベント ----
{
  const cc = document.getElementById('crop-canvas');

  cc.addEventListener('mousedown', e => {
    e.preventDefault();
    const [px, py] = cropEventPos(e);
    const ci = cropHitCorner(px, py);
    if (ci >= 0) {
      cropDragState = { type: 'corner', cornerIdx: ci, origRect: { ...cropRect } };
    } else if (cropInsideRect(px, py)) {
      cropDragState = { type: 'move', startX: px, startY: py, origRect: { ...cropRect } };
    }
  });

  cc.addEventListener('mousemove', e => {
    const [px, py] = cropEventPos(e);
    const cw = cc.width, ch = cc.height;
    if (!cropDragState) {
      const ci = cropHitCorner(px, py);
      cc.style.cursor = ci >= 0
        ? ['nw-resize', 'ne-resize', 'sw-resize', 'se-resize'][ci]
        : cropInsideRect(px, py) ? 'move' : 'crosshair';
      return;
    }
    if (cropDragState.type === 'move') {
      const dx = px - cropDragState.startX;
      const dy = py - cropDragState.startY;
      const s  = cropDragState.origRect.size;
      cropRect.x = Math.max(0, Math.min(cw - s, cropDragState.origRect.x + dx));
      cropRect.y = Math.max(0, Math.min(ch - s, cropDragState.origRect.y + dy));
    } else {
      const orig = cropDragState.origRect;
      const fps  = [
        [orig.x + orig.size, orig.y + orig.size],
        [orig.x,             orig.y + orig.size],
        [orig.x + orig.size, orig.y            ],
        [orig.x,             orig.y            ],
      ];
      const [fx, fy] = fps[cropDragState.cornerIdx];
      const calc = [
        () => { const s = Math.min(Math.max(MIN_CROP_SZ, Math.max(fx - px, fy - py)), fx,      fy     ); cropRect = { x: fx - s, y: fy - s, size: s }; },
        () => { const s = Math.min(Math.max(MIN_CROP_SZ, Math.max(px - fx, fy - py)), cw - fx, fy     ); cropRect = { x: fx,     y: fy - s, size: s }; },
        () => { const s = Math.min(Math.max(MIN_CROP_SZ, Math.max(fx - px, py - fy)), fx,      ch - fy); cropRect = { x: fx - s, y: fy,     size: s }; },
        () => { const s = Math.min(Math.max(MIN_CROP_SZ, Math.max(px - fx, py - fy)), cw - fx, ch - fy); cropRect = { x: fx,     y: fy,     size: s }; },
      ];
      calc[cropDragState.cornerIdx]();
    }
    renderCropCanvas();
  });

  const endCropDrag = () => { cropDragState = null; };
  cc.addEventListener('mouseup',    endCropDrag);
  cc.addEventListener('mouseleave', endCropDrag);
}

document.getElementById('crop-ok').addEventListener('click', () => {
  document.getElementById('modal-crop-overlay').classList.add('hidden');
  if (!cropCallback || !cropImage) return;
  const canvas = document.getElementById('canvas-resize');
  const ctx    = canvas.getContext('2d');
  const srcX   = cropRect.x    / cropDisplayScale;
  const srcY   = cropRect.y    / cropDisplayScale;
  const srcS   = cropRect.size / cropDisplayScale;
  canvas.width  = ICON_SIZE;
  canvas.height = ICON_SIZE;
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.drawImage(cropImage, srcX, srcY, srcS, srcS, 0, 0, ICON_SIZE, ICON_SIZE);
  const dataUrl = canvas.toDataURL('image/png');
  const cb = cropCallback;
  cropCallback = null;
  cropImage    = null;
  cb(dataUrl);
});

document.getElementById('crop-cancel').addEventListener('click', () => {
  document.getElementById('modal-crop-overlay').classList.add('hidden');
  cropCallback = null;
  cropImage    = null;
});

// ============================================================
//  Supabase / ホスティングモード
// ============================================================

// supabase-client.js が window.sb を設定する（設定値がなければ null）
const sb = window.sb ?? null;

let mapId = null;
let mapTitle = '無題マップ';
let realtimeChannel = null;
let realtimeReady = false;
let broadcastQueue = [];
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
  const { data, error } = await sb.from('maps').select('title, data').eq('id', id).single();
  if (error || !data) {
    showNotify('マップが見つかりません');
    return;
  }
  mapTitle = data.title ?? '無題マップ';
  const titleInput = document.getElementById('input-map-title');
  if (titleInput) titleInput.value = mapTitle;
  document.title = `${mapTitle} - AutoRelationMap`;
  const mapData = data.data;
  nodes      = (mapData.nodes ?? []).map(n => ({ ...n, r: R_BASE }));
  links      = (mapData.links ?? []).map(l => ({ ...l }));
  nextNodeId = mapData.meta?.nextNodeId ?? (nodes.length ? Math.max(...nodes.map(n => n.id)) + 1 : 1);
  nextLinkId = mapData.meta?.nextLinkId ?? (links.length ? Math.max(...links.map(l => l.id)) + 1 : 1);
  seedCircularPositions();
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
    .update({ title: mapTitle, data: buildSaveData(), updated_at: new Date().toISOString() })
    .eq('id', mapId);
}

function scheduleSave() {
  if (!isHosted()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMapToDB, 500);
}

async function createMapInDB() {
  const { data, error } = await sb.from('maps')
    .insert({ title: '無題マップ', data: buildSaveData() })
    .select('id')
    .single();

  if (error || !data) {
    showNotify('マップの作成に失敗しました');
    return;
  }

  mapId = data.id;
  window.history.pushState({}, '', `/map/${mapId}`);
  subscribeRealtime(mapId);
  updateMapModeUI();
}

async function createNewMap() {
  if (!sb) return;
  await createMapInDB();
}

function subscribeRealtime(id) {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeReady = false;
  realtimeChannel = sb.channel(`map:${id}`)
    .on('broadcast', { event: 'op' }, ({ payload }) => {
      if (payload.clientId === CLIENT_ID) return;
      applyRemoteOp(payload);
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        realtimeReady = true;
        broadcastQueue.forEach(item => realtimeChannel.send(item));
        broadcastQueue = [];
      }
    });
}

function broadcastOp(op, data) {
  if (!realtimeChannel) return;
  const msg = { type: 'broadcast', event: 'op', payload: { op, ...data, clientId: CLIENT_ID } };
  if (realtimeReady) {
    realtimeChannel.send(msg);
  } else {
    broadcastQueue.push(msg);
  }
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

document.getElementById('btn-create-map')?.addEventListener('click', createNewMap);
document.getElementById('btn-copy-share')?.addEventListener('click', copyShareLink);

document.getElementById('input-map-title')?.addEventListener('input', function () {
  mapTitle = this.value.trim() || '無題マップ';
  document.title = `${mapTitle} - AutoRelationMap`;
  scheduleSave();
});

// ---- 初期化 ----
getSvgSize();
restart({ layout: false, fit: false });

if (sb) {
  mapId = parseMapId();
  if (mapId) {
    loadMapFromDB(mapId).then(() => subscribeRealtime(mapId));
    updateMapModeUI();
  }
}
