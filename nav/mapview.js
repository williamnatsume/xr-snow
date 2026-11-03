// SVG 雪场示意图（不依赖在线地图）。
// 坐标：局部米制，SVG 中 y 轴翻转（北在上）。

const NS = 'http://www.w3.org/2000/svg';
const RUN_COLOR = { 1: 'var(--run-green)', 2: 'var(--run-red)', 3: 'var(--run-black)', 4: 'var(--run-expert)' };

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export class MapView {
  constructor(svg) {
    this.svg = svg;
    this.follow = false;
    this.view = null; // { x, y, w, h }（SVG 坐标）
    this.layers = {};
    this.bindPan();
  }

  setResort(resort) {
    this.resort = resort;
    const svg = this.svg;
    svg.innerHTML = '';
    const defs = el('defs', {}, svg);
    const mk = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--lift)' }, mk);
    const mkr = el('marker', { id: 'arrowRun', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto' }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }, mkr);

    for (const name of ['base', 'route', 'labels', 'marks', 'pos']) this.layers[name] = el('g', { class: 'layer-' + name }, svg);

    const xs = [], ys = [];
    for (const n of resort.nodes.values()) { xs.push(n.x); ys.push(n.y); }
    this.bounds = { x0: Math.min(...xs) - 80, x1: Math.max(...xs) + 80, y0: -Math.max(...ys) - 80, y1: -Math.min(...ys) + 80 };
    const span = Math.max(this.bounds.x1 - this.bounds.x0, this.bounds.y1 - this.bounds.y0);
    this.unit = span / 600; // 线宽、字号随雪场大小缩放

    const u = this.unit;
    for (const e of resort.edges.values()) {
      const d = 'M' + e.pts.map((p) => `${p.x.toFixed(1)},${(-p.y).toFixed(1)}`).join(' L');
      if (e.type === 'lift') {
        el('path', { d, class: 'lift', 'stroke-width': 1.4 * u, 'stroke-dasharray': `${4 * u} ${3 * u}`, 'marker-end': 'url(#arrow)' }, this.layers.base);
      } else {
        const color = e.type === 'connector' ? 'var(--connector)' : (RUN_COLOR[e.difficulty] || 'var(--run-unknown)');
        const p = el('path', { d, class: 'run', stroke: color, 'stroke-width': (e.type === 'connector' ? 2 : 3.2) * u }, this.layers.base);
        if (e.open === false) { p.setAttribute('stroke-dasharray', `${3 * u} ${3 * u}`); p.classList.add('closed'); }
        if (e.flat === true) el('path', { d, class: 'flat', 'stroke-width': 1 * u, 'stroke-dasharray': `${1 * u} ${2.5 * u}` }, this.layers.base);
        // 方向箭头（每条雪道中点）
        const mid = e.pts[Math.floor(e.pts.length / 2)], prev = e.pts[Math.max(0, Math.floor(e.pts.length / 2) - 1)];
        if (mid !== prev) el('path', { d: `M${prev.x},${-prev.y} L${mid.x},${-mid.y}`, stroke: color, 'stroke-width': 3.2 * u, 'marker-end': 'url(#arrowRun)', fill: 'none' }, this.layers.base);
      }
      // 编号标签
      const label = e.ref || (e.type !== 'connector' && e.name && resort.edges.size < 40 ? e.name : null);
      if (label) {
        const mid = e.pts[Math.floor((e.pts.length - 1) / 2)];
        const t = el('text', { x: mid.x + 5 * u, y: -mid.y, class: 'edge-label' + (e.open === false ? ' closed' : ''), 'font-size': 9 * u }, this.layers.labels);
        t.textContent = e.type === 'lift' ? `🚡${e.ref || ''}` : (e.ref ? e.ref : label) + (e.open === false ? ' ✕' : '');
      }
    }
    for (const p of resort.pois) {
      const n = resort.nodes.get(p.node);
      el('circle', { cx: n.x, cy: -n.y, r: 3 * u, class: 'poi' }, this.layers.labels);
      if (resort.pois.length <= 12) {
        const t = el('text', { x: n.x + 5 * u, y: -n.y - 4 * u, class: 'poi-label', 'font-size': 10 * u }, this.layers.labels);
        t.textContent = p.name;
      }
    }
    this.fit();
  }

  setRoute(edges) {
    const g = this.layers.route; g.innerHTML = '';
    if (!edges) return;
    const u = this.unit;
    for (const e of edges) {
      const d = 'M' + e.pts.map((p) => `${p.x.toFixed(1)},${(-p.y).toFixed(1)}`).join(' L');
      el('path', { d, class: e.type === 'lift' ? 'route lift-route' : 'route', 'stroke-width': 9 * u }, g);
    }
  }

  setMarks({ next, dest }) {
    const g = this.layers.marks; g.innerHTML = '';
    const u = this.unit;
    if (next) {
      const n = this.resort.nodes.get(next.nodeId);
      if (n) el('circle', { cx: n.x, cy: -n.y, r: 9 * u, class: 'next-mark', 'stroke-width': 2.5 * u }, g);
    }
    if (dest) {
      const n = this.resort.nodes.get(dest);
      if (n) {
        const t = el('text', { x: n.x, y: -n.y, class: 'dest-mark', 'font-size': 18 * u, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
        t.textContent = '🏁';
      }
    }
  }

  setPosition({ fix, stale, truth }) {
    const g = this.layers.pos; g.innerHTML = '';
    const u = this.unit;
    if (truth) el('circle', { cx: truth.x, cy: -truth.y, r: 3 * u, class: 'truth' }, g);
    if (fix) {
      el('circle', { cx: fix.x, cy: -fix.y, r: Math.max(fix.acc || 0, 2), class: 'acc' + (stale ? ' stale' : '') }, g);
      el('circle', { cx: fix.x, cy: -fix.y, r: 5 * u, class: 'me' + (stale ? ' stale' : ''), 'stroke-width': 2 * u }, g);
      if (this.follow) this.centerOn(fix.x, -fix.y);
    }
  }

  /* ---------- 视图 ---------- */

  apply() {
    const v = this.view;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  }
  fit() {
    const b = this.bounds;
    this.view = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
    this.apply();
  }
  zoom(f) {
    const v = this.view, cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    v.w *= f; v.h *= f; v.x = cx - v.w / 2; v.y = cy - v.h / 2;
    this.apply();
  }
  centerOn(x, y) {
    const v = this.view;
    v.x = x - v.w / 2; v.y = y - v.h / 2;
    this.apply();
  }
  bindPan() {
    let start = null;
    this.svg.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, v: { ...this.view } };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!start) return;
      const r = this.svg.getBoundingClientRect();
      const k = Math.max(start.v.w / r.width, start.v.h / r.height);
      this.view.x = start.v.x - (e.clientX - start.x) * k;
      this.view.y = start.v.y - (e.clientY - start.y) * k;
      this.follow = false;
      this.apply();
    });
    const end = () => { start = null; };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  }
}
