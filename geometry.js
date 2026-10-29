// Pure geometry helpers. All coordinates are in centimetres.

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function centroid(pts) {
  if (!pts.length) return { x: 0, y: 0 };
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-6) {
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(pt, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Nearest point on the polygon outline to pt.
export function closestOnPolygon(pt, pts) {
  let best = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2)) : 0;
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(pt, p);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

const EPS = 0.5;

export function distToPolygon(pt, pts) {
  return dist(pt, closestOnPolygon(pt, pts));
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

// True only for edges that properly cross (touching/collinear edges do not count).
function segmentsCross(a, b, c, d) {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  const tol = EPS * Math.max(dist(a, b), dist(c, d));
  return ((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol)) && ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol));
}

// Two polygons overlap if their edges cross or a vertex lies clearly inside the other.
export function polygonsOverlap(A, B) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segmentsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  const inside = (P, Q) => P.some(p => pointInPolygon(p, Q) && distToPolygon(p, Q) > EPS);
  if (inside(A, B) || inside(B, A)) return true;
  // identical shapes
  return A.length === B.length && A.every(p => B.some(q => dist(p, q) < EPS));
}

export function insideOrOn(pt, pts) {
  return pointInPolygon(pt, pts) || distToPolygon(pt, pts) <= EPS;
}

export function bbox(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// Moves point `to` along the direction from `from` so the distance becomes `length`.
export function setEdgeLength(from, to, length) {
  const d = dist(from, to);
  if (d < 1e-6) return { x: from.x + length, y: from.y };
  const f = length / d;
  return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
}

export const rectangle = (w, h) => [
  { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
];
