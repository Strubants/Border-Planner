import { pointInPolygon, distToPolygon, polygonArea, bbox } from './geometry.js';

const DEFAULT_HEIGHT = 30;
const SIDES = 8;
const MAX_PLANTS = 600;
const LIGHT = norm([-0.5, -0.6, 0.8]);

function norm(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x9aa39a;
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Fills each zone with a grid of plants whose height comes from the plant library.
function buildPlants(border, plantsOf) {
  const out = [];
  for (const z of border.zones) {
    const plants = plantsOf(z);
    if (!plants.length || z.points.length < 3) continue;
    const area = polygonArea(z.points);
    const counted = plants.reduce((s, p) => s + (p.count || 0), 0);
    let s = counted > 0 ? Math.sqrt(area / counted) : Math.min(60, Math.max(20, Math.sqrt(area / 12)));
    s = Math.max(s, Math.sqrt(area / MAX_PLANTS * 1.5));
    const b = bbox(z.points);
    let i = 0;
    for (let y = b.minY + s / 2, row = 0; y < b.maxY; y += s, row++) {
      for (let x = b.minX + s / 2 + (row % 2 ? s / 2 : 0); x < b.maxX; x += s) {
        const p = { x, y };
        if (!pointInPolygon(p, z.points) || distToPolygon(p, z.points) < s * 0.3) continue;
        const pl = plants[(i * 7 + row * 3) % plants.length];
        i++;
        const h = pl.height > 0 ? pl.height : DEFAULT_HEIGHT;
        out.push({ x, y, h, r: Math.min(s * 0.5, Math.max(6, h * 0.3)), color: pl.color });
      }
    }
  }
  return out;
}

export function open3D({ border, plantsOf, onClose }) {
  const root = document.createElement('div');
  root.className = 'view3d';
  root.innerHTML = `<div class="v3-bar"><button class="v3-btn" id="v3-close" aria-label="Close">←</button><span class="v3-title"></span><button class="v3-btn" id="v3-reset" aria-label="Reset view">⟲</button></div>
    <canvas></canvas><div class="v3-hint">Drag to rotate · pinch or scroll to zoom</div>`;
  root.querySelector('.v3-title').textContent = `${border.name} · 3D`;
  document.body.appendChild(root);
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  const plants = buildPlants(border, plantsOf);
  const b = bbox(border.points);
  const target = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0];
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 50);
  const tallest = Math.max(0, ...plants.map(p => p.h));
  const home = { yaw: -Math.PI / 2 - 0.5, pitch: 0.7, dist: span * 1.8 + tallest };
  const cam = { ...home };
  let W = 0, H = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#cfe3f0'); g.addColorStop(1, '#eef4e6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const pos = [target[0] + cam.dist * cp * Math.cos(cam.yaw), target[1] + cam.dist * cp * Math.sin(cam.yaw), cam.dist * sp];
    const fwd = norm(sub(target, pos));
    const right = norm(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    const f = Math.min(W, H) * 1.1;
    const proj = p => {
      const v = sub(p, pos), z = dot(v, fwd);
      const k = f / Math.max(z, 1);
      return [W / 2 + dot(v, right) * k, H * 0.52 - dot(v, up) * k, z];
    };
    const face = (pts3, fill, stroke) => {
      const q = pts3.map(proj);
      if (q.some(p => p[2] <= 1)) return;
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    };

    const pts = border.points;
    if (pts.length >= 3) {
      const lift = (p, z = 0) => [p.x, p.y, z];
      face(pts.map(p => lift(p)), '#d9e6c5', '#5b7a43');
      for (const z of border.zones) {
        const pl = plantsOf(z);
        face(z.points.map(p => lift(p)), shade(pl[0]?.color, 1.05), null);
      }
    }

    // painter's algorithm: far objects first
    const items = [];
    const dist2 = (x, y) => (x - pos[0]) ** 2 + (y - pos[1]) ** 2;
    for (const p of plants) items.push({ d: dist2(p.x, p.y), plant: p });
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      items.push({ d: dist2((a.x + c.x) / 2, (a.y + c.y) / 2) - 1, wall: [a, c] });
    }
    items.sort((a, c) => c.d - a.d);

    for (const it of items) {
      if (it.wall) {
        const [a, c] = it.wall, h = 8;
        face([[a.x, a.y, 0], [c.x, c.y, 0], [c.x, c.y, h], [a.x, a.y, h]], '#8a6a4a', '#5e4630');
        continue;
      }
      const p = it.plant;
      const top = p.r * 0.75;
      const ring = (r, z) => Array.from({ length: SIDES }, (_, i) => {
        const t = (i / SIDES) * Math.PI * 2;
        return [p.x + Math.cos(t) * r, p.y + Math.sin(t) * r, z];
      });
      const lo = ring(p.r, 0), hi = ring(top, p.h);
      const faces = [];
      for (let i = 0; i < SIDES; i++) {
        const j = (i + 1) % SIDES;
        const t = ((i + 0.5) / SIDES) * Math.PI * 2;
        const n = norm([Math.cos(t), Math.sin(t), (p.r - top) / p.h]);
        const mid = [(lo[i][0] + lo[j][0]) / 2, (lo[i][1] + lo[j][1]) / 2, p.h / 2];
        if (dot(n, norm(sub(pos, mid))) <= 0) continue;
        faces.push({ d: dist2(mid[0], mid[1]), pts: [lo[i], lo[j], hi[j], hi[i]], k: 0.55 + 0.45 * Math.max(0, dot(n, LIGHT)) });
      }
      faces.sort((a, c) => c.d - a.d);
      for (const fc of faces) face(fc.pts, shade(p.color, fc.k), null);
      face(hi, shade(p.color, 1.12), 'rgba(0,0,0,.12)');
    }
  }

  // gestures: one finger rotates, two fingers pinch-zoom
  const ptrs = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
  canvas.addEventListener('pointermove', e => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) {
      cam.yaw -= (e.clientX - prev[0]) * 0.008;
      cam.pitch = Math.max(0.08, Math.min(1.5, cam.pitch + (e.clientY - prev[1]) * 0.006));
    } else if (ptrs.size === 2) {
      const [a, c] = [...ptrs.values()];
      const d = Math.hypot(a[0] - c[0], a[1] - c[1]);
      if (pinch) zoom(pinch / d);
      pinch = d;
    }
    draw();
  });
  const release = e => { ptrs.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  const zoom = k => { cam.dist = Math.max(span * 0.3, Math.min(span * 8, cam.dist * k)); };
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.001)); draw(); }, { passive: false });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const close = () => { ro.disconnect(); root.remove(); onClose?.(); };
  root.querySelector('#v3-close').onclick = close;
  root.querySelector('#v3-reset').onclick = () => { Object.assign(cam, home); draw(); };
  resize();
  return close;
}
