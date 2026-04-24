(function () {
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 5;
  const POINTER_DRAG_THRESHOLD = 6;
  const TOUCH_DRAG_THRESHOLD = 14;
  const LINK_HIT_WIDTH = 16;

  function parseCssColor(value, fallback) {
    if (!value) return fallback;
    const text = String(value).trim();
    if (text.startsWith('#')) {
      const hex = text.slice(1);
      const normalized = hex.length === 3
        ? hex.split('').map(part => part + part).join('')
        : hex;
      const parsed = Number.parseInt(normalized, 16);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    const match = text.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return fallback;
    const red = Number.parseInt(match[1], 10);
    const green = Number.parseInt(match[2], 10);
    const blue = Number.parseInt(match[3], 10);
    return (red << 16) + (green << 8) + blue;
  }

  let _themeColorsCache = null;

  function getThemeColors() {
    if (_themeColorsCache) return _themeColorsCache;
    const root = getComputedStyle(document.documentElement);
    _themeColorsCache = {
      mapBg: parseCssColor(root.getPropertyValue('--map-bg'), 0xf0f4f8),
      graphAccent: parseCssColor(root.getPropertyValue('--graph-accent'), 0x1a6fa5),
      graphHover: parseCssColor(root.getPropertyValue('--graph-hover'), 0xe03060),
      graphOut: parseCssColor(root.getPropertyValue('--graph-out'), 0xff7043),
      graphIn: parseCssColor(root.getPropertyValue('--graph-in'), 0x42a5f5),
      blankNodeFill: 0xdde8f5,
      nodeText: 0x1a1a2e,
      nodeConnected: 0x00968a,
      nodeHover: 0xd4900a,
      nodeSearch: 0xe0820c,
      white: 0xffffff,
    };
    return _themeColorsCache;
  }

  // テーマ変更時（ダークモード切替など）にキャッシュを破棄
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    _themeColorsCache = null;
  });

  function cloneTextStyle(style) {
    return typeof style.clone === 'function' ? style.clone() : new PIXI.TextStyle(style);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function distancePointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
    const closestX = ax + dx * t;
    const closestY = ay + dy * t;
    return Math.hypot(px - closestX, py - closestY);
  }

  function pointOnQuadraticBezier(sx, sy, cpx, cpy, ex, ey, t) {
    const u = 1 - t;
    return {
      x: u * u * sx + 2 * u * t * cpx + t * t * ex,
      y: u * u * sy + 2 * u * t * cpy + t * t * ey,
    };
  }

  function distancePointToQuadratic(px, py, sx, sy, cpx, cpy, ex, ey, segments = 20) {
    let minDistance = Infinity;
    let previousPoint = { x: sx, y: sy };

    for (let index = 1; index <= segments; index += 1) {
      const currentPoint = pointOnQuadraticBezier(sx, sy, cpx, cpy, ex, ey, index / segments);
      minDistance = Math.min(
        minDistance,
        distancePointToSegment(px, py, previousPoint.x, previousPoint.y, currentPoint.x, currentPoint.y)
      );
      previousPoint = currentPoint;
    }

    return minDistance;
  }

  function drawArrowHead(graphics, fromX, fromY, toX, toY, width, color, alpha) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.hypot(dx, dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    const nx = -uy;
    const ny = ux;
    const arrowLength = Math.max(8, width * 4.5);
    const arrowWidth = Math.max(5, width * 2.8);
    const baseX = toX - ux * arrowLength;
    const baseY = toY - uy * arrowLength;

    graphics.beginFill(color, alpha);
    graphics.moveTo(toX, toY);
    graphics.lineTo(baseX + nx * arrowWidth * 0.5, baseY + ny * arrowWidth * 0.5);
    graphics.lineTo(baseX - nx * arrowWidth * 0.5, baseY - ny * arrowWidth * 0.5);
    graphics.closePath();
    graphics.endFill();
  }

  function drawOccluderCircle(graphics, radius, color) {
    graphics.clear();
    graphics.beginFill(color, 1);
    graphics.drawCircle(0, 0, radius);
    graphics.endFill();
  }

  class PixiGraphRenderer {
    constructor({ containerId, overlayId }) {
      this.enabled = false;
      this.container = document.getElementById(containerId);
      this.overlay = document.getElementById(overlayId);
      this.nodeViews = new Map();
      this.linkViews = new Map();
      this.colors = getThemeColors();
      this.sceneState = null;
      this.interactionHandlers = {};
      this.viewTransform = { x: 0, y: 0, k: 1 };
      this.hoverTarget = null;
      this.pointerSession = null;
      this.touchPoints = new Map();
      this.pinchSession = null;
      this.graphStructureState = {
        nodesRef: null,
        linksRef: null,
        nodeCount: 0,
        linkCount: 0,
      };
      this.sceneDerivedState = null;

      if (!window.PIXI || !this.container) return;

      try {
        this.app = new PIXI.Application({
          width: this.container.clientWidth || 800,
          height: this.container.clientHeight || 600,
          antialias: true,
          backgroundAlpha: 0,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
        });
      } catch (error) {
        console.error('Pixi initialization failed:', error);
        return;
      }

      this.canvas = this.app.view;
      this.canvas.id = 'pixi-layer';
      this.canvas.style.webkitTapHighlightColor = 'transparent';
      this.canvas.style.outline = 'none';

      if (this.overlay?.parentNode === this.container) {
        this.container.insertBefore(this.canvas, this.overlay);
      } else {
        this.container.prepend(this.canvas);
      }

      this.world = new PIXI.Container();
      this.linkLayer = new PIXI.Container();
      this.labelLayer = new PIXI.Container();
      this.nodeLayer = new PIXI.Container();
      this.dragLayer = new PIXI.Container();
      this.dragGraphics = new PIXI.Graphics();

      this.dragLayer.addChild(this.dragGraphics);
      this.world.addChild(this.linkLayer, this.labelLayer, this.nodeLayer, this.dragLayer);
      this.app.stage.addChild(this.world);

      this.nodeLabelStyle = new PIXI.TextStyle({
        fill: this.colors.nodeText,
        fontSize: 13,
        fontWeight: '700',
        align: 'center',
        stroke: this.colors.white,
        strokeThickness: 5,
        lineJoin: 'round',
      });
      this.linkLabelStyle = new PIXI.TextStyle({
        fill: this.colors.graphAccent,
        fontSize: 11,
        fontWeight: '700',
        align: 'center',
        stroke: this.colors.white,
        strokeThickness: 5,
        lineJoin: 'round',
      });

      this.handleCanvasPointerDown = this.handleCanvasPointerDown.bind(this);
      this.handleCanvasPointerMove = this.handleCanvasPointerMove.bind(this);
      this.handleCanvasPointerLeave = this.handleCanvasPointerLeave.bind(this);
      this.handleCanvasContextMenu = this.handleCanvasContextMenu.bind(this);
      this.handleWheel = this.handleWheel.bind(this);
      this.handleWindowPointerMove = this.handleWindowPointerMove.bind(this);
      this.handleWindowPointerUp = this.handleWindowPointerUp.bind(this);

      this.installInteractionListeners();
      this.enabled = true;
      this.updateCanvasCursor();
    }

    installInteractionListeners() {
      this.canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
      this.canvas.addEventListener('pointermove', this.handleCanvasPointerMove);
      this.canvas.addEventListener('pointerleave', this.handleCanvasPointerLeave);
      this.canvas.addEventListener('contextmenu', this.handleCanvasContextMenu);
      this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    }

    setInteractionHandlers(handlers) {
      this.interactionHandlers = handlers ?? {};
    }

    resize(width, height) {
      if (!this.enabled) return;
      this.app.renderer.resize(width, height);
    }

    setViewTransform(transform) {
      if (!this.enabled) return;
      const previousTransform = this.viewTransform;
      const nextTransform = {
        x: Number.isFinite(transform?.x) ? transform.x : 0,
        y: Number.isFinite(transform?.y) ? transform.y : 0,
        k: clamp(Number.isFinite(transform?.k) ? transform.k : 1, MIN_SCALE, MAX_SCALE),
      };
      this.viewTransform = nextTransform;
      this.world.position.set(this.viewTransform.x, this.viewTransform.y);
      this.world.scale.set(this.viewTransform.k, this.viewTransform.k);
      if (this.sceneState && previousTransform.k !== nextTransform.k) {
        this.refreshZoomScaledNodeVisuals();
      }
    }

    setDragLine({ visible, x1, y1, x2, y2 }) {
      if (!this.enabled) return;
      this.colors = getThemeColors();
      this.dragGraphics.clear();
      if (!visible) return;
      this.dragGraphics.lineStyle({
        width: 2,
        color: this.colors.graphAccent,
        alpha: 0.95,
        cap: PIXI.LINE_CAP.ROUND,
        join: PIXI.LINE_JOIN.ROUND,
      });
      this.dragGraphics.moveTo(x1, y1);
      this.dragGraphics.lineTo(x2, y2);
    }

    syncGraphElements({ nodes, links }) {
      if (!this.enabled) return;
      if (
        this.graphStructureState.nodesRef === nodes
        && this.graphStructureState.linksRef === links
        && this.graphStructureState.nodeCount === nodes.length
        && this.graphStructureState.linkCount === links.length
      ) {
        return;
      }

      const liveNodeIds = new Set(nodes.map(node => node.id));
      for (const [id, view] of this.nodeViews) {
        if (liveNodeIds.has(id)) continue;
        view.root.destroy({ children: true });
        this.nodeViews.delete(id);
      }
      nodes.forEach(node => {
        if (!this.nodeViews.has(node.id)) {
          this.nodeViews.set(node.id, this.createNodeView());
        }
      });

      const liveLinkIds = new Set(links.map(link => link.id));
      for (const [id, view] of this.linkViews) {
        if (liveLinkIds.has(id)) continue;
        view.graphics.destroy();
        view.label.destroy();
        this.linkViews.delete(id);
      }
      links.forEach(link => {
        if (!this.linkViews.has(link.id)) {
          this.linkViews.set(link.id, this.createLinkView());
        }
      });

      this.graphStructureState = {
        nodesRef: nodes,
        linksRef: links,
        nodeCount: nodes.length,
        linkCount: links.length,
      };
    }

    createNodeView() {
      const root = new PIXI.Container();
      const occluder = new PIXI.Graphics();
      const backdrop = new PIXI.Graphics();
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      const mask = new PIXI.Graphics();
      const ring = new PIXI.Graphics();
      const label = new PIXI.Text('', cloneTextStyle(this.nodeLabelStyle));

      sprite.anchor.set(0.5, 0.5);
      sprite.mask = mask;
      label.anchor.set(0.5, 0);

      root.addChild(occluder, backdrop, sprite, ring, label, mask);
      this.nodeLayer.addChild(root);

      return {
        root,
        occluder,
        backdrop,
        sprite,
        mask,
        ring,
        label,
        iconSrc: '',
        visibleForHit: false,
        labelText: '',
        lastX: NaN,
        lastY: NaN,
        lastRadius: NaN,
        lastAlpha: NaN,
        lastOccluderColor: null,
        lastBackdropColor: null,
        lastRingColor: null,
        lastRingRadius: NaN,
        lastRingWidth: NaN,
        lastLabelY: NaN,
      };
    }

    createLinkView() {
      const graphics = new PIXI.Graphics();
      const label = new PIXI.Text('', cloneTextStyle(this.linkLabelStyle));
      label.anchor.set(0.5, 0.5);
      this.linkLayer.addChild(graphics);
      this.labelLayer.addChild(label);
      return {
        graphics,
        label,
        lastGeometry: null,
        visibleForHit: false,
        labelText: '',
        lastStrokeColor: null,
        lastStrokeWidth: NaN,
        lastPrimaryBidir: false,
        lastSplit: false,
        lastGraphicsAlpha: NaN,
        lastLabelX: NaN,
        lastLabelY: NaN,
        lastLabelFill: null,
        lastLabelAlpha: NaN,
      };
    }

    buildSceneDerivedState(options) {
      const {
        nodes,
        links,
        selectedNodeId,
        getLinkSourceId,
        getLinkTargetId,
      } = options;

      const maxNodeR = nodes.reduce((m, n) => Math.max(m, n.r), 1);
      const lodThreshold = maxNodeR * 0.8;
      const sceneLod = r => {
        if (r >= lodThreshold) return 1;
        const t = Math.max(0, r / lodThreshold);
        return 0.15 + 0.85 * t;
      };
      const nodeRMap = new Map(nodes.map(node => [node.id, node.r]));
      const connectedIds = new Set();

      if (selectedNodeId !== null) {
        links.forEach(link => {
          const sourceId = getLinkSourceId(link);
          const targetId = getLinkTargetId(link);
          if (sourceId === selectedNodeId) connectedIds.add(targetId);
          if (targetId === selectedNodeId) connectedIds.add(sourceId);
        });
      }

      return {
        maxNodeR,
        nodeRMap,
        sceneLod,
        connectedIds,
        selectionActive: selectedNodeId !== null,
      };
    }

    updateNodeAlpha(view, alpha) {
      if (view.lastAlpha === alpha) return;
      view.backdrop.alpha = alpha;
      view.sprite.alpha = alpha;
      view.ring.alpha = alpha;
      view.label.alpha = alpha;
      view.lastAlpha = alpha;
    }

    refreshZoomScaledNodeVisuals() {
      if (!this.sceneState || !this.sceneDerivedState) return;

      const {
        nodes,
        selectedNodeId,
        searchMatchSet,
        hoveredNodeId,
        arrowDragSourceId,
        arrowDragTargetId,
        lightweightMode,
      } = this.sceneState;
      const { connectedIds, sceneLod, selectionActive } = this.sceneDerivedState;

      nodes.forEach(node => {
        const view = this.nodeViews.get(node.id);
        if (!view) return;

        const selected = node.id === selectedNodeId;
        const connected = connectedIds.has(node.id);
        const searchMatch = searchMatchSet.has(node.id);
        const hovered = hoveredNodeId === node.id
          || arrowDragSourceId === node.id
          || arrowDragTargetId === node.id;
        const visible = !lightweightMode || !selectionActive || selected || connected;
        const screenR = node.r * Math.max(1, this.viewTransform.k);
        const baseLod = sceneLod(screenR);
        const selectionLod = selectionActive && !selected && !connected && !searchMatch ? 0.18 : 1;
        const alpha = baseLod * selectionLod;

        view.visibleForHit = visible;
        view.root.visible = visible;
        if (!visible) return;

        this.updateNodeAlpha(view, alpha);
      });
    }

    redrawLinkGraphics(view, geometry, color, width, primaryBidir, split) {
      view.graphics.clear();
      view.graphics.lineStyle({
        width,
        color,
        alpha: 1,
        cap: PIXI.LINE_CAP.ROUND,
        join: PIXI.LINE_JOIN.ROUND,
      });
      view.graphics.moveTo(geometry.sx, geometry.sy);
      if (geometry.curved) {
        view.graphics.quadraticCurveTo(geometry.cpx, geometry.cpy, geometry.ex, geometry.ey);
      } else {
        view.graphics.lineTo(geometry.ex, geometry.ey);
      }
      drawArrowHead(
        view.graphics,
        geometry.arrowFromX,
        geometry.arrowFromY,
        geometry.ex,
        geometry.ey,
        width,
        color,
        1
      );
      if (primaryBidir && !split) {
        drawArrowHead(view.graphics, geometry.ex, geometry.ey, geometry.sx, geometry.sy, width, color, 1);
      }

      view.lastGeometry = geometry;
      view.lastStrokeColor = color;
      view.lastStrokeWidth = width;
      view.lastPrimaryBidir = primaryBidir;
      view.lastSplit = split;
    }

    redrawNodeBase(view, node) {
      if (view.lastRadius !== node.r || view.lastOccluderColor !== this.colors.mapBg) {
        drawOccluderCircle(view.occluder, node.r + 2, this.colors.mapBg);
        view.lastOccluderColor = this.colors.mapBg;
      }

      if (view.lastRadius !== node.r || view.lastBackdropColor !== this.colors.blankNodeFill) {
        view.backdrop.clear();
        view.backdrop.beginFill(this.colors.blankNodeFill, 1);
        view.backdrop.drawCircle(0, 0, node.r);
        view.backdrop.endFill();
        view.lastBackdropColor = this.colors.blankNodeFill;
      }

      if (view.lastRadius !== node.r) {
        view.mask.clear();
        view.mask.beginFill(this.colors.white, 1);
        view.mask.drawCircle(0, 0, node.r);
        view.mask.endFill();
      }

      if (view.lastRadius !== node.r) {
        const spriteSize = node.r * 2;
        view.sprite.width = spriteSize;
        view.sprite.height = spriteSize;
        view.label.position.set(0, node.r + 20);
        view.lastLabelY = node.r + 20;
        view.lastRadius = node.r;
      }
    }

    redrawNodeRing(view, node, ringColor, ringWidth) {
      if (
        view.lastRingRadius === node.r
        && view.lastRingColor === ringColor
        && view.lastRingWidth === ringWidth
      ) {
        return;
      }

      view.ring.clear();
      view.ring.lineStyle({
        width: ringWidth,
        color: ringColor,
        alpha: 1,
        cap: PIXI.LINE_CAP.ROUND,
        join: PIXI.LINE_JOIN.ROUND,
      });
      view.ring.drawCircle(0, 0, node.r);
      view.lastRingRadius = node.r;
      view.lastRingColor = ringColor;
      view.lastRingWidth = ringWidth;
    }

    getLinkVisualState(link, state = this.sceneState) {
      if (!state) {
        return { highlightType: 'none', primaryBidir: false, secondaryVisible: false, split: false, visible: false };
      }

      const {
        selectedNodeId,
        biDirPrimarySet,
        biDirSecondarySet,
        getLinkSourceId,
        getLinkTargetId,
        isBidirSplit,
        lightweightMode,
      } = state;

      const secondary = biDirSecondarySet.has(link.id);
      const split = isBidirSplit(link);
      const secondaryVisible = secondary && split;
      const primaryBidir = biDirPrimarySet.has(link.id);

      let highlightType = 'none';
      if (selectedNodeId !== null) {
        if (primaryBidir && !split) {
          if (getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId) {
            highlightType = 'bidir';
          }
        } else if (getLinkSourceId(link) === selectedNodeId) {
          highlightType = 'out';
        } else if (getLinkTargetId(link) === selectedNodeId) {
          highlightType = 'in';
        }
      }

      const baseVisible = !secondary || secondaryVisible;
      const visible = lightweightMode
        ? baseVisible && selectedNodeId !== null && highlightType !== 'none'
        : baseVisible;

      return { highlightType, primaryBidir, secondaryVisible, split, visible };
    }

    renderScene(options) {
      if (!this.enabled) return;

      const {
        nodes,
        links,
        selectedNodeId,
        searchMatchSet,
        computeLinkGeometry,
        getLabelMidpoint,
        getLinkSourceId,
        getLinkTargetId,
        calcLodOpacity,
        linkLodOpacity,
        hoveredNodeId,
        hoveredLinkId,
        arrowDragSourceId,
        arrowDragTargetId,
        lightweightMode,
      } = options;

      this.sceneState = options;
      this.colors = getThemeColors();
      this.syncGraphElements({ nodes, links });

      const derivedState = this.buildSceneDerivedState(options);
      this.sceneDerivedState = derivedState;
      const { maxNodeR, nodeRMap, sceneLod, connectedIds, selectionActive } = derivedState;

      links.forEach(link => {
        const view = this.linkViews.get(link.id);
        if (!view) return;

        const geometry = computeLinkGeometry(link);
        const { highlightType, primaryBidir, secondaryVisible, split, visible } = this.getLinkVisualState(link, options);
        const hover = hoveredLinkId === link.id;

        view.visibleForHit = Boolean(geometry && visible);

        if (!geometry || !visible) {
          view.graphics.visible = false;
          view.label.visible = false;
          return;
        }

        let color = this.colors.graphAccent;
        let width = primaryBidir ? 3 : 1.5;
        let alpha = sceneLod(Math.min(
          nodeRMap.get(getLinkSourceId(link)) ?? maxNodeR,
          nodeRMap.get(getLinkTargetId(link)) ?? maxNodeR
        ));

        if (selectionActive && highlightType === 'none') alpha = 0.2;

        if (highlightType === 'out') {
          color = this.colors.graphOut;
          width = 2.5;
          alpha = 1;
        } else if (highlightType === 'in') {
          color = this.colors.graphIn;
          width = 2.5;
          alpha = 1;
        } else if (highlightType === 'bidir') {
          color = this.colors.graphAccent;
          width = 4;
          alpha = 1;
        } else if (hover) {
          color = this.colors.graphHover;
          width = 2.5;
          alpha = 1;
        }

        view.graphics.visible = true;
        if (
          view.lastGeometry !== geometry
          || view.lastStrokeColor !== color
          || view.lastStrokeWidth !== width
          || view.lastPrimaryBidir !== primaryBidir
          || view.lastSplit !== split
        ) {
          this.redrawLinkGraphics(view, geometry, color, width, primaryBidir, split);
        }
        if (view.lastGraphicsAlpha !== alpha) {
          view.graphics.alpha = alpha;
          view.lastGraphicsAlpha = alpha;
        }

        const labelHighlighted = selectedNodeId !== null
          && (getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId);
        const labelVisible = Boolean(link.label)
          && (!options.biDirSecondarySet.has(link.id) || secondaryVisible)
          && (!options.lightweightMode || (selectedNodeId !== null && labelHighlighted));

        view.label.visible = labelVisible;
        if (!labelVisible) return;

        const midpoint = getLabelMidpoint(link);
        const labelText = link.label ?? '';
        if (view.labelText !== labelText) {
          view.label.text = labelText;
          view.labelText = labelText;
        }
        if (view.lastLabelX !== midpoint.x || view.lastLabelY !== midpoint.y) {
          view.label.position.set(midpoint.x, midpoint.y);
          view.lastLabelX = midpoint.x;
          view.lastLabelY = midpoint.y;
        }
        const labelFill = highlightType === 'out'
          ? this.colors.graphOut
          : highlightType === 'in'
            ? this.colors.graphIn
            : this.colors.graphAccent;
        if (view.lastLabelFill !== labelFill) {
          view.label.style.fill = labelFill;
          view.lastLabelFill = labelFill;
        }
        const labelAlpha = labelHighlighted
          ? 1
          : selectionActive
            ? 0.15
            : sceneLod(Math.min(
                nodeRMap.get(getLinkSourceId(link)) ?? maxNodeR,
                nodeRMap.get(getLinkTargetId(link)) ?? maxNodeR
              ));
        if (view.lastLabelAlpha !== labelAlpha) {
          view.label.alpha = labelAlpha;
          view.lastLabelAlpha = labelAlpha;
        }
      });

      nodes.forEach(node => {
        const view = this.nodeViews.get(node.id);
        if (!view) return;

        const selected = node.id === selectedNodeId;
        const connected = connectedIds.has(node.id);
        const searchMatch = searchMatchSet.has(node.id);
        const hovered = hoveredNodeId === node.id
          || arrowDragSourceId === node.id
          || arrowDragTargetId === node.id;
        const visible = !lightweightMode || !selectionActive || selected || connected;
        // スクリーン上の見かけのサイズでLODを計算（ズームイン時は濃く、ズームアウト時は初期視点より薄くしない）
        const screenR = node.r * Math.max(1, this.viewTransform.k);
        const baseLod = sceneLod(screenR);
        const selectionLod = selectionActive && !selected && !connected && !searchMatch ? 0.18 : 1;
        const alpha = baseLod * selectionLod;

        view.visibleForHit = visible;
        view.root.visible = visible;
        if (!visible) return;

        const x = node.x ?? 0;
        const y = node.y ?? 0;
        if (view.lastX !== x || view.lastY !== y) {
          view.root.position.set(x, y);
          view.lastX = x;
          view.lastY = y;
        }

        this.redrawNodeBase(view, node);

        const iconSrc = node.dataUrl || '';
        if (view.iconSrc !== iconSrc) {
          view.sprite.texture = iconSrc ? PIXI.Texture.from(iconSrc) : PIXI.Texture.EMPTY;
          view.iconSrc = iconSrc;
        }

        view.sprite.visible = Boolean(iconSrc);

        let ringColor = this.colors.graphAccent;
        let ringWidth = 2.5;
        if (connected) {
          ringColor = this.colors.nodeConnected;
          ringWidth = 3.5;
        }
        if (searchMatch) {
          ringColor = this.colors.nodeSearch;
          ringWidth = Math.max(ringWidth, 3);
        }
        if (selected || hovered) {
          ringColor = this.colors.nodeHover;
          ringWidth = 3.5;
        }

        this.redrawNodeRing(view, node, ringColor, ringWidth);

        if (view.labelText !== node.name) {
          view.label.text = node.name;
          view.labelText = node.name;
        }

        this.updateNodeAlpha(view, alpha);
      });

      this.updateCanvasCursor();
    }

    emitViewTransformChange(transform) {
      const nextTransform = {
        x: Number.isFinite(transform?.x) ? transform.x : this.viewTransform.x,
        y: Number.isFinite(transform?.y) ? transform.y : this.viewTransform.y,
        k: clamp(Number.isFinite(transform?.k) ? transform.k : this.viewTransform.k, MIN_SCALE, MAX_SCALE),
      };
      this.setViewTransform(nextTransform);
      this.interactionHandlers.onViewTransformChange?.(nextTransform);
    }

    getPointerDataFromClient(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      return {
        clientX,
        clientY,
        screenX,
        screenY,
        worldX: (screenX - this.viewTransform.x) / this.viewTransform.k,
        worldY: (screenY - this.viewTransform.y) / this.viewTransform.k,
        rect,
      };
    }

    getPointerData(nativeEvent) {
      return this.getPointerDataFromClient(nativeEvent.clientX, nativeEvent.clientY);
    }

    isPointerInsideCanvas(pointerData) {
      return pointerData.screenX >= 0
        && pointerData.screenY >= 0
        && pointerData.screenX <= pointerData.rect.width
        && pointerData.screenY <= pointerData.rect.height;
    }

    buildSyntheticPointerEvent(nativeEvent, pointerData) {
      return {
        clientX: pointerData.clientX,
        clientY: pointerData.clientY,
        x: pointerData.worldX,
        y: pointerData.worldY,
        button: nativeEvent.button,
        pointerType: nativeEvent.pointerType,
        preventDefault: () => nativeEvent.preventDefault(),
        stopPropagation: () => nativeEvent.stopPropagation(),
        sourceEvent: nativeEvent,
      };
    }

    invokeInteractionHandler(name, subject, nativeEvent, pointerData) {
      const handler = this.interactionHandlers[name];
      if (typeof handler !== 'function') return;
      handler(this.buildSyntheticPointerEvent(nativeEvent, pointerData), subject);
    }

    findNodeAtPointer(pointerData) {
      const nodes = this.sceneState?.nodes ?? [];
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        const view = this.nodeViews.get(node.id);
        if (!view?.visibleForHit) continue;
        const dx = (node.x ?? 0) - pointerData.worldX;
        const dy = (node.y ?? 0) - pointerData.worldY;
        if (Math.hypot(dx, dy) <= node.r + 10) return node;
      }
      return null;
    }

    findLinkAtPointer(pointerData) {
      const links = this.sceneState?.links ?? [];
      const threshold = (LINK_HIT_WIDTH * 0.5) / this.viewTransform.k;
      for (let index = links.length - 1; index >= 0; index -= 1) {
        const link = links[index];
        const view = this.linkViews.get(link.id);
        if (!view?.visibleForHit || !view.lastGeometry) continue;
        const distance = view.lastGeometry.curved
          ? distancePointToQuadratic(
              pointerData.worldX,
              pointerData.worldY,
              view.lastGeometry.sx,
              view.lastGeometry.sy,
              view.lastGeometry.cpx,
              view.lastGeometry.cpy,
              view.lastGeometry.ex,
              view.lastGeometry.ey
            )
          : distancePointToSegment(
              pointerData.worldX,
              pointerData.worldY,
              view.lastGeometry.sx,
              view.lastGeometry.sy,
              view.lastGeometry.ex,
              view.lastGeometry.ey
            );
        if (distance <= threshold) return link;
      }
      return null;
    }

    hitTestPointer(pointerData) {
      if (!this.sceneState || !this.isPointerInsideCanvas(pointerData)) return null;
      const node = this.findNodeAtPointer(pointerData);
      if (node) return { type: 'node', node };
      const link = this.findLinkAtPointer(pointerData);
      if (link) return { type: 'link', link };
      return null;
    }

    clearHoverTarget() {
      if (!this.hoverTarget) {
        this.updateCanvasCursor();
        return;
      }

      const previous = this.hoverTarget;
      this.hoverTarget = null;

      if (previous.type === 'node') {
        this.interactionHandlers.onNodePointerLeave?.();
      } else if (previous.type === 'link') {
        this.interactionHandlers.onLinkPointerLeave?.();
      }

      this.updateCanvasCursor();
    }

    updateHoverFromPointer(pointerData, nativeEvent) {
      const hit = this.hitTestPointer(pointerData);

      if (hit?.type === 'node') {
        if (this.hoverTarget?.type === 'node' && this.hoverTarget.id === hit.node.id) {
          this.invokeInteractionHandler('onNodePointerMove', hit.node, nativeEvent, pointerData);
          this.updateCanvasCursor();
          return;
        }

        this.clearHoverTarget();
        this.hoverTarget = { type: 'node', id: hit.node.id };
        this.invokeInteractionHandler('onNodePointerEnter', hit.node, nativeEvent, pointerData);
        this.updateCanvasCursor();
        return;
      }

      if (hit?.type === 'link') {
        if (this.hoverTarget?.type === 'link' && this.hoverTarget.id === hit.link.id) {
          this.invokeInteractionHandler('onLinkPointerMove', hit.link, nativeEvent, pointerData);
          this.updateCanvasCursor();
          return;
        }

        this.clearHoverTarget();
        this.hoverTarget = { type: 'link', id: hit.link.id };
        this.invokeInteractionHandler('onLinkPointerEnter', hit.link, nativeEvent, pointerData);
        this.updateCanvasCursor();
        return;
      }

      this.clearHoverTarget();
    }

    updateCanvasCursor() {
      if (!this.canvas) return;
      if (this.pinchSession) {
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      if (this.pointerSession?.draggingLink) {
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      if (this.pointerSession?.panning) {
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      if (this.hoverTarget) {
        this.canvas.style.cursor = 'pointer';
        return;
      }
      this.canvas.style.cursor = this.sceneState ? 'grab' : 'default';
    }

    attachGlobalPointerListeners() {
      window.addEventListener('pointermove', this.handleWindowPointerMove);
      window.addEventListener('pointerup', this.handleWindowPointerUp);
      window.addEventListener('pointercancel', this.handleWindowPointerUp);
    }

    releaseGlobalPointerListenersIfIdle() {
      if (this.pointerSession || this.pinchSession || this.touchPoints.size > 0) return;
      window.removeEventListener('pointermove', this.handleWindowPointerMove);
      window.removeEventListener('pointerup', this.handleWindowPointerUp);
      window.removeEventListener('pointercancel', this.handleWindowPointerUp);
    }

    clearPointerSession({ cancelArrowDrag = false } = {}) {
      if (cancelArrowDrag && this.pointerSession?.draggingLink) {
        this.interactionHandlers.onArrowDragCancel?.();
      }
      this.pointerSession = null;
      this.releaseGlobalPointerListenersIfIdle();
      this.updateCanvasCursor();
    }

    updateTouchPoint(nativeEvent) {
      this.touchPoints.set(nativeEvent.pointerId, {
        pointerId: nativeEvent.pointerId,
        clientX: nativeEvent.clientX,
        clientY: nativeEvent.clientY,
      });
    }

    removeTouchPoint(pointerId) {
      this.touchPoints.delete(pointerId);
    }

    getTouchPair() {
      const points = Array.from(this.touchPoints.values());
      if (points.length < 2) return null;
      return [points[0], points[1]];
    }

    getTouchDistance(pointA, pointB) {
      return Math.hypot(pointB.clientX - pointA.clientX, pointB.clientY - pointA.clientY) || 1;
    }

    getTouchMidpoint(pointA, pointB) {
      return {
        clientX: (pointA.clientX + pointB.clientX) / 2,
        clientY: (pointA.clientY + pointB.clientY) / 2,
      };
    }

    startPinchSession() {
      const pair = this.getTouchPair();
      if (!pair) return;

      const [pointA, pointB] = pair;
      const midpoint = this.getTouchMidpoint(pointA, pointB);
      const midpointData = this.getPointerDataFromClient(midpoint.clientX, midpoint.clientY);

      this.clearPointerSession({ cancelArrowDrag: true });
      this.clearHoverTarget();
      this.pinchSession = {
        pointerIds: [pointA.pointerId, pointB.pointerId],
        startDistance: this.getTouchDistance(pointA, pointB),
        startTransform: { ...this.viewTransform },
        startWorldMidpoint: {
          x: midpointData.worldX,
          y: midpointData.worldY,
        },
      };
      this.updateCanvasCursor();
    }

    updatePinchSession() {
      if (!this.pinchSession) return;

      const activePoints = this.pinchSession.pointerIds
        .map(pointerId => this.touchPoints.get(pointerId))
        .filter(Boolean);

      if (activePoints.length < 2) {
        this.clearPinchSession();
        return;
      }

      const [pointA, pointB] = activePoints;
      const midpoint = this.getTouchMidpoint(pointA, pointB);
      const midpointData = this.getPointerDataFromClient(midpoint.clientX, midpoint.clientY);
      const scaleRatio = this.getTouchDistance(pointA, pointB) / this.pinchSession.startDistance;
      const nextScale = clamp(this.pinchSession.startTransform.k * scaleRatio, MIN_SCALE, MAX_SCALE);

      this.emitViewTransformChange({
        x: midpointData.screenX - this.pinchSession.startWorldMidpoint.x * nextScale,
        y: midpointData.screenY - this.pinchSession.startWorldMidpoint.y * nextScale,
        k: nextScale,
      });
    }

    clearPinchSession() {
      this.pinchSession = null;
      this.releaseGlobalPointerListenersIfIdle();
      this.updateCanvasCursor();
    }

    handleCanvasPointerDown(nativeEvent) {
      if (!this.sceneState) return;
      const isPrimaryButton = nativeEvent.button === 0 || nativeEvent.pointerType === 'touch' || nativeEvent.pointerType === 'pen';
      if (!isPrimaryButton) return;

      const pointerData = this.getPointerData(nativeEvent);
      const hit = this.hitTestPointer(pointerData);

      if (nativeEvent.pointerType === 'touch') {
        this.updateTouchPoint(nativeEvent);
        this.attachGlobalPointerListeners();
        if (this.touchPoints.size >= 2) {
          this.startPinchSession();
          nativeEvent.preventDefault();
          return;
        }
      }

      if (!hit) {
        this.clearHoverTarget();
      }

      this.clearPointerSession();
      this.pointerSession = {
        pointerId: nativeEvent.pointerId,
        type: hit?.type ?? 'background',
        node: hit?.node ?? null,
        link: hit?.link ?? null,
        startClientX: nativeEvent.clientX,
        startClientY: nativeEvent.clientY,
        startTransform: { ...this.viewTransform },
        draggingLink: false,
        moved: false,
        panning: false,
      };

      this.attachGlobalPointerListeners();
      nativeEvent.preventDefault();
      this.updateCanvasCursor();
    }

    handleCanvasPointerMove(nativeEvent) {
      if (nativeEvent.pointerType === 'touch' && this.touchPoints.has(nativeEvent.pointerId)) {
        this.updateTouchPoint(nativeEvent);
      }

      if (this.pinchSession) {
        this.updatePinchSession();
        nativeEvent.preventDefault();
        return;
      }

      if (this.pointerSession) return;
      if (nativeEvent.pointerType === 'touch') return;
      this.updateHoverFromPointer(this.getPointerData(nativeEvent), nativeEvent);
    }

    handleCanvasPointerLeave(nativeEvent) {
      if (nativeEvent?.pointerType === 'touch') return;
      if (this.pointerSession || this.pinchSession) return;
      this.clearHoverTarget();
    }

    handleWindowPointerMove(nativeEvent) {
      if (nativeEvent.pointerType === 'touch' && this.touchPoints.has(nativeEvent.pointerId)) {
        this.updateTouchPoint(nativeEvent);
      }

      if (this.pinchSession) {
        this.updatePinchSession();
        nativeEvent.preventDefault();
        return;
      }

      const session = this.pointerSession;
      if (!session || nativeEvent.pointerId !== session.pointerId) return;

      const pointerData = this.getPointerData(nativeEvent);
      const moveX = nativeEvent.clientX - session.startClientX;
      const moveY = nativeEvent.clientY - session.startClientY;
      const movedDistance = Math.hypot(moveX, moveY);

      if (session.type === 'node') {
        const nodeDragThreshold = nativeEvent.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : POINTER_DRAG_THRESHOLD;
        if (!session.draggingLink && movedDistance >= nodeDragThreshold) {
          session.draggingLink = true;
          this.clearHoverTarget();
          this.invokeInteractionHandler('onArrowDragStart', session.node, nativeEvent, pointerData);
        }
        if (session.draggingLink) {
          this.invokeInteractionHandler('onArrowDragMove', session.node, nativeEvent, pointerData);
        }
        this.updateCanvasCursor();
        return;
      }

      if (session.type === 'background') {
        if (!session.panning && movedDistance >= POINTER_DRAG_THRESHOLD) {
          session.panning = true;
        }
        if (session.panning) {
          this.emitViewTransformChange({
            x: session.startTransform.x + moveX,
            y: session.startTransform.y + moveY,
            k: session.startTransform.k,
          });
        }
        this.updateCanvasCursor();
        return;
      }

      if (session.type === 'link') {
        if (!session.panning && movedDistance >= POINTER_DRAG_THRESHOLD) {
          session.panning = true;
          session.moved = true;
          this.clearHoverTarget();
        }
        if (session.panning) {
          this.emitViewTransformChange({
            x: session.startTransform.x + moveX,
            y: session.startTransform.y + moveY,
            k: session.startTransform.k,
          });
        }
        this.updateCanvasCursor();
      }
    }

    handleWindowPointerUp(nativeEvent) {
      if (nativeEvent.pointerType === 'touch') {
        this.removeTouchPoint(nativeEvent.pointerId);
        if (this.pinchSession) {
          if (this.touchPoints.size >= 2) {
            this.startPinchSession();
          } else {
            this.clearPinchSession();
          }
          nativeEvent.preventDefault();
          return;
        }
      }

      const session = this.pointerSession;
      if (!session || nativeEvent.pointerId !== session.pointerId) return;

      const pointerData = this.getPointerData(nativeEvent);
      const hit = this.hitTestPointer(pointerData);

      if (session.type === 'node') {
        if (session.draggingLink) {
          this.invokeInteractionHandler('onArrowDragEnd', session.node, nativeEvent, pointerData);
        } else if (hit?.type === 'node' && hit.node.id === session.node?.id) {
          this.invokeInteractionHandler('onNodeClick', session.node, nativeEvent, pointerData);
        }
      } else if (!session.panning) {
        this.interactionHandlers.onBackgroundClick?.();
      }

      this.clearPointerSession();
      if (nativeEvent.pointerType !== 'touch') {
        if (this.isPointerInsideCanvas(pointerData)) {
          this.updateHoverFromPointer(pointerData, nativeEvent);
        } else {
          this.clearHoverTarget();
        }
      }
    }

    handleCanvasContextMenu(nativeEvent) {
      if (!this.sceneState) return;

      const pointerData = this.getPointerData(nativeEvent);
      const hit = this.hitTestPointer(pointerData);
      nativeEvent.preventDefault();

      if (hit?.type === 'node') {
        this.invokeInteractionHandler('onNodeContextMenu', hit.node, nativeEvent, pointerData);
        return;
      }

      if (hit?.type === 'link') {
        this.invokeInteractionHandler('onLinkContextMenu', hit.link, nativeEvent, pointerData);
        return;
      }

      this.interactionHandlers.onBackgroundContextMenu?.();
    }

    handleWheel(nativeEvent) {
      if (!this.sceneState) return;

      const pointerData = this.getPointerData(nativeEvent);
      if (!this.isPointerInsideCanvas(pointerData)) return;

      nativeEvent.preventDefault();

      const speed = nativeEvent.deltaMode === 1 ? 0.08 : 0.0015;
      const nextScale = clamp(this.viewTransform.k * Math.exp(-nativeEvent.deltaY * speed), MIN_SCALE, MAX_SCALE);
      if (nextScale === this.viewTransform.k) return;

      this.emitViewTransformChange({
        x: pointerData.screenX - pointerData.worldX * nextScale,
        y: pointerData.screenY - pointerData.worldY * nextScale,
        k: nextScale,
      });
    }
  }

  window.PixiGraphRenderer = PixiGraphRenderer;
})();