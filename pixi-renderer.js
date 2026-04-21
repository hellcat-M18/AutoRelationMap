(function () {
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

  function getThemeColors() {
    const root = getComputedStyle(document.documentElement);
    return {
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
  }

  function cloneTextStyle(style) {
    return typeof style.clone === 'function' ? style.clone() : new PIXI.TextStyle(style);
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

  class PixiGraphRenderer {
    constructor({ containerId, overlayId }) {
      this.enabled = false;
      this.container = document.getElementById(containerId);
      this.overlay = document.getElementById(overlayId);
      this.nodeViews = new Map();
      this.linkViews = new Map();
      this.colors = getThemeColors();

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
      this.canvas.setAttribute('aria-hidden', 'true');

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

      this.enabled = true;
    }

    resize(width, height) {
      if (!this.enabled) return;
      this.app.renderer.resize(width, height);
    }

    setViewTransform(transform) {
      if (!this.enabled) return;
      this.world.position.set(transform.x, transform.y);
      this.world.scale.set(transform.k, transform.k);
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
    }

    createNodeView() {
      const root = new PIXI.Container();
      const backdrop = new PIXI.Graphics();
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      const mask = new PIXI.Graphics();
      const ring = new PIXI.Graphics();
      const label = new PIXI.Text('', cloneTextStyle(this.nodeLabelStyle));

      sprite.anchor.set(0.5, 0.5);
      sprite.mask = mask;

      label.anchor.set(0.5, 0);

      root.addChild(backdrop, sprite, ring, label, mask);
      this.nodeLayer.addChild(root);

      return {
        root,
        backdrop,
        sprite,
        mask,
        ring,
        label,
        iconSrc: '',
      };
    }

    createLinkView() {
      const graphics = new PIXI.Graphics();
      const label = new PIXI.Text('', cloneTextStyle(this.linkLabelStyle));
      label.anchor.set(0.5, 0.5);
      this.linkLayer.addChild(graphics);
      this.labelLayer.addChild(label);
      return { graphics, label };
    }

    renderScene(options) {
      if (!this.enabled) return;

      const {
        nodes,
        links,
        selectedNodeId,
        searchMatchSet,
        biDirPrimarySet,
        biDirSecondarySet,
        computeLinkGeometry,
        getLabelMidpoint,
        getLinkSourceId,
        getLinkTargetId,
        isBidirSplit,
        calcLodOpacity,
        linkLodOpacity,
        hoveredNodeId,
        hoveredLinkId,
        lightweightMode,
      } = options;

      this.colors = getThemeColors();
      this.syncGraphElements({ nodes, links });

      const connectedIds = new Set();
      if (selectedNodeId !== null) {
        links.forEach(link => {
          const sourceId = getLinkSourceId(link);
          const targetId = getLinkTargetId(link);
          if (sourceId === selectedNodeId) connectedIds.add(targetId);
          if (targetId === selectedNodeId) connectedIds.add(sourceId);
        });
      }

      const selectionActive = selectedNodeId !== null;

      links.forEach(link => {
        const view = this.linkViews.get(link.id);
        if (!view) return;

        const geometry = computeLinkGeometry(link);
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

        const hover = hoveredLinkId === link.id;
        const baseVisible = !secondary || secondaryVisible;
        const visible = lightweightMode
          ? baseVisible && selectedNodeId !== null && highlightType !== 'none'
          : baseVisible;

        if (!view || !geometry || !visible) {
          view.graphics.visible = false;
          view.label.visible = false;
          return;
        }

        let color = this.colors.graphAccent;
        let width = primaryBidir ? 3 : 1.5;
        let alpha = linkLodOpacity(link);

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
        view.graphics.clear();
        view.graphics.lineStyle({
          width,
          color,
          alpha,
          cap: PIXI.LINE_CAP.ROUND,
          join: PIXI.LINE_JOIN.ROUND,
        });
        view.graphics.moveTo(geometry.sx, geometry.sy);
        view.graphics.lineTo(geometry.ex, geometry.ey);
        drawArrowHead(view.graphics, geometry.sx, geometry.sy, geometry.ex, geometry.ey, width, color, alpha);
        if (primaryBidir && !split) {
          drawArrowHead(view.graphics, geometry.ex, geometry.ey, geometry.sx, geometry.sy, width, color, alpha);
        }

        const labelHighlighted = selectedNodeId !== null
          && (getLinkSourceId(link) === selectedNodeId || getLinkTargetId(link) === selectedNodeId);
        const labelVisible = Boolean(link.label)
          && (!secondary || secondaryVisible)
          && (!lightweightMode || (selectedNodeId !== null && labelHighlighted));

        view.label.visible = labelVisible;
        if (!labelVisible) return;

        const midpoint = getLabelMidpoint(link);
        view.label.text = link.label;
        view.label.position.set(midpoint.x, midpoint.y);
        view.label.style.fill = highlightType === 'out'
          ? this.colors.graphOut
          : highlightType === 'in'
            ? this.colors.graphIn
            : this.colors.graphAccent;
        view.label.alpha = labelHighlighted
          ? 1
          : selectionActive
            ? 0.15
            : linkLodOpacity(link);
      });

      nodes.forEach(node => {
        const view = this.nodeViews.get(node.id);
        if (!view) return;

        const selected = node.id === selectedNodeId;
        const connected = connectedIds.has(node.id);
        const searchMatch = searchMatchSet.has(node.id);
        const hovered = hoveredNodeId === node.id;
        const baseLod = calcLodOpacity(node.r);
        const selectionLod = selectionActive && !selected && !connected && !searchMatch ? 0.18 : 1;
        const alpha = baseLod * selectionLod;

        view.root.visible = true;
        view.root.position.set(node.x ?? 0, node.y ?? 0);

        view.backdrop.clear();
        view.backdrop.beginFill(this.colors.blankNodeFill, alpha);
        view.backdrop.drawCircle(0, 0, node.r);
        view.backdrop.endFill();

        view.mask.clear();
        view.mask.beginFill(this.colors.white, 1);
        view.mask.drawCircle(0, 0, node.r);
        view.mask.endFill();

        const iconSrc = node.dataUrl || '';
        if (view.iconSrc !== iconSrc) {
          view.sprite.texture = iconSrc ? PIXI.Texture.from(iconSrc) : PIXI.Texture.EMPTY;
          view.iconSrc = iconSrc;
        }

        view.sprite.visible = Boolean(iconSrc);
        view.sprite.width = node.r * 2;
        view.sprite.height = node.r * 2;
        view.sprite.alpha = alpha;

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

        view.ring.clear();
        view.ring.lineStyle({
          width: ringWidth,
          color: ringColor,
          alpha,
          cap: PIXI.LINE_CAP.ROUND,
          join: PIXI.LINE_JOIN.ROUND,
        });
        view.ring.drawCircle(0, 0, node.r);

        view.label.text = node.name;
        view.label.position.set(0, node.r + 20);
        view.label.alpha = alpha;
      });
    }
  }

  window.PixiGraphRenderer = PixiGraphRenderer;
})();