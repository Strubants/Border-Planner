import { dist, polygonArea, centroid, pointInPolygon, bbox, setEdgeLength, rectangle, closestOnPolygon, distToPolygon, polygonsOverlap, insideOrOn } from './geometry.js';
import { loadData, saveData, uid } from './store.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const $ = id => document.getElementById(id);
const main = $('main'), dlg = $('dlg');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const m2 = cm => (cm / 100).toFixed(2);

let data;
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveData(data).catch(e => alert('Saving failed: ' + e.message)), 200);
}

const byName = (a, b) => a.name.localeCompare(b.name);
const FALLBACK_PLANT = { name: '(deleted plant)', color: '#9aa39a', bloomFrom: 0, bloomTo: 0, water: '', sun: '', notes: '' };
// Combines a planting (zone entry) with its library plant data.
const rp = e => ({ ...(data.plants.find(p => p.id === e.plantId) ?? FALLBACK_PLANT), ...e });

// Upgrades data saved before the plant library existed: every distinct plant name becomes a library plant.
function migrate(d) {
  if (!Array.isArray(d.plants)) d.plants = [];
  let changed = false;
  for (const b of d.borders) {
    for (const z of b.zones) {
      z.plants = z.plants.map(e => {
        if (e.plantId) return e;
        changed = true;
        let lib = d.plants.find(p => p.name.toLowerCase() === e.name.toLowerCase());
        if (!lib) {
          lib = { id: uid(), name: e.name, color: e.color || '#e8a2c1', bloomFrom: e.bloomFrom || 0, bloomTo: e.bloomTo || 0, water: e.water || '', sun: e.sun || '', notes: '' };
          d.plants.push(lib);
        }
        return { id: e.id, plantId: lib.id, planted: e.planted || '', note: e.notes || '' };
      });
    }
  }
  d.version = 2;
  return changed;
}

function setHeader(title, { back, actions = [] } = {}) {
  $('title').textContent = title;
  const b = $('back');
  b.hidden = !back;
  b.onclick = back || null;
  const a = $('actions');
  a.innerHTML = '';
  for (const act of actions) {
    const btn = document.createElement('button');
    btn.textContent = act.label;
    btn.onclick = act.onClick;
    a.append(btn);
  }
}

function setNav(active) {
  $('nav').classList.toggle('hidden', !active);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === active));
}

document.querySelectorAll('#nav button').forEach(b => {
  b.onclick = () => ({ list: showList, plants: showPlants, settings: showSettings })[b.dataset.nav]();
});

// ---------- dialogs ----------
function openDialog(html, onMount) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  onMount?.(dlg);
}
const closeDialog = () => dlg.open && dlg.close();

// ---------- landscape ----------
// Fullscreen + orientation lock works in Chrome on Android; otherwise just rotate the phone.
async function toggleLandscape() {
  try {
    if (document.fullscreenElement) { leaveLandscape(); return; }
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock('landscape');
  } catch {
    alert('Could not lock the screen. Turn off rotation lock and rotate your phone sideways instead.');
  }
}

function leaveLandscape() {
  try { screen.orientation.unlock(); } catch {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------- border list ----------
function showList() {
  setNav('list');
  setHeader('My borders', { actions: [{ label: '+ New', onClick: newBorderDialog }] });
  main.innerHTML = '<div class="pad" id="items"></div>';
  const items = $('items');
  if (!data.borders.length) {
    items.innerHTML = '<p class="muted">No borders yet. Tap “+ New” to add your first border.</p>';
    return;
  }
  for (const b of data.borders) {
    const plants = b.zones.reduce((n, z) => n + z.plants.length, 0);
    const card = document.createElement('div');
    card.className = 'card click';
    card.innerHTML = `<b>${esc(b.name)}</b><div class="muted">${b.points.length ? m2(polygonArea(b.points) / 100) + ' m² · ' : ''}${b.zones.length} zones · ${plants} plants</div>`;
    card.onclick = () => openEditor(b.id);
    items.append(card);
  }
}

function newBorderDialog() {
  openDialog(`
    <h2>New border</h2>
    <label>Name</label><input type="text" id="nb-name" placeholder="e.g. Front border">
    <p class="muted">Optional: start from a rectangle (metres). Leave empty to draw the outline by tapping its corners.</p>
    <div class="row"><div class="grow"><label>Width (m)</label><input type="number" id="nb-w" step="0.01" min="0"></div>
    <div class="grow"><label>Length (m)</label><input type="number" id="nb-h" step="0.01" min="0"></div></div>
    <div class="dlg-btns"><button class="btn alt" id="nb-cancel">Cancel</button><button class="btn" id="nb-ok">Create</button></div>`,
  d => {
    d.querySelector('#nb-cancel').onclick = closeDialog;
    d.querySelector('#nb-ok').onclick = () => {
      const w = parseFloat(d.querySelector('#nb-w').value) * 100;
      const h = parseFloat(d.querySelector('#nb-h').value) * 100;
      const border = {
        id: uid(), name: d.querySelector('#nb-name').value.trim() || 'Border', photo: null,
        points: w > 0 && h > 0 ? rectangle(w, h) : [], zones: [],
      };
      data.borders.push(border);
      save();
      closeDialog();
      openEditor(border.id);
    };
  });
}

// ---------- editor ----------
function openEditor(borderId) {
  const border = data.borders.find(b => b.id === borderId);
  if (!border) return showList();
  setNav(null);
  setHeader(border.name, {
    back: () => { leaveLandscape(); showList(); },
    actions: [{ label: 'Landscape', onClick: toggleLandscape }, { label: '⋮', onClick: () => borderMenu(border) }],
  });
  main.innerHTML = `
    <div id="stage"><svg id="svg"></svg><div id="hint"></div></div>
    <div class="toolbar" id="tools"></div>`;
  const svg = $('svg'), hint = $('hint'), tools = $('tools');

  const st = {
    mode: border.points.length ? 'view' : 'drawBorder', // view | edit | drawBorder | drawZone
    draft: [],
    sel: { kind: 'border' },
    selVertex: -1,
    vb: { x: 0, y: 0, w: 500 },
    snap: localStorage.getItem('snapToBorder') !== '0',
  };

  // Keeps zone points inside the border and outside other zones (and magnetises to nearby corners).
  const constrain = (p, excludeId) => {
    if (!st.snap) return p;
    const others = border.zones.filter(z => z.id !== excludeId);
    const magnet = [...border.points, ...others.flatMap(z => z.points)].find(q => dpx(q, p) < 12);
    if (magnet) return { x: magnet.x, y: magnet.y };
    let q = p;
    for (let n = 0; n < 4; n++) {
      if (border.points.length >= 3 && !insideOrOn(q, border.points)) q = closestOnPolygon(q, border.points);
      const z = others.find(o => pointInPolygon(q, o.points) && distToPolygon(q, o.points) > 0.5);
      if (!z) break;
      q = closestOnPolygon(q, z.points);
    }
    return q;
  };

  const zoneFits = (pts, excludeId) => !st.snap || (
    pts.every(p => border.points.length < 3 || insideOrOn(p, border.points)) &&
    !border.zones.some(z => z.id !== excludeId && polygonsOverlap(pts, z.points)));

  const selZone = () => st.sel.kind === 'zone' ? border.zones.find(z => z.id === st.sel.id) : null;

  const selPts = () => st.sel.kind === 'zone' ? (border.zones.find(z => z.id === st.sel.id)?.points ?? border.points) : border.points;
  const rect = () => svg.getBoundingClientRect();
  const k = () => st.vb.w / rect().width;

  function fit() {
    const r = rect();
    const pts = border.points.length ? border.points : [{ x: 0, y: 0 }, { x: 500, y: 350 }];
    const b = bbox(pts);
    const bw = Math.max(b.maxX - b.minX, 50), bh = Math.max(b.maxY - b.minY, 50);
    const pad = 1.2;
    const w = Math.max(bw * pad, (bh * pad * r.width) / r.height);
    st.vb = { w, x: (b.minX + b.maxX) / 2 - w / 2, y: (b.minY + b.maxY) / 2 - (w * r.height / r.width) / 2 };
  }

  const world = e => {
    const r = rect(), kk = k();
    return { x: st.vb.x + (e.clientX - r.left) * kk, y: st.vb.y + (e.clientY - r.top) * kk };
  };

  function render() {
    const r = rect(), kk = k();
    const { vb } = st;
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.w * r.height / r.width}`);
    const px = n => n * kk;
    const poly = pts => pts.map(p => `${p.x},${p.y}`).join(' ');
    let s = '';
    const minor = vb.w < 600 ? 10 : vb.w < 2500 ? 50 : 100;
    s += `<defs><pattern id="g" width="${minor}" height="${minor}" patternUnits="userSpaceOnUse"><path d="M${minor} 0H0V${minor}" fill="none" stroke="#dfe7d6" stroke-width="${px(1)}"/></pattern>
      <pattern id="g2" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="#c5d1ba" stroke-width="${px(1.2)}"/></pattern></defs>`;
    s += `<rect x="${vb.x - 1e4}" y="${vb.y - 1e4}" width="2e4" height="2e4" fill="url(#g)"/><rect x="${vb.x - 1e4}" y="${vb.y - 1e4}" width="2e4" height="2e4" fill="url(#g2)"/>`;

    if (border.points.length >= 3) {
      const bsel = st.mode === 'edit' && st.sel.kind === 'border';
      s += `<polygon points="${poly(border.points)}" fill="#e3edd2" stroke="${bsel ? '#d6730a' : '#5b7a43'}" stroke-width="${px(bsel ? 3 : 2.5)}" stroke-linejoin="round"/>`;
    }
    for (const z of border.zones) {
      const col = z.plants.map(rp).find(p => p.color)?.color ?? '#9aa39a';
      const zsel = st.mode === 'edit' && st.sel.kind === 'zone' && st.sel.id === z.id;
      s += `<polygon points="${poly(z.points)}" fill="${col}" fill-opacity=".55" stroke="${zsel ? '#d6730a' : col}" stroke-width="${px(zsel ? 3 : 2)}" stroke-linejoin="round"/>`;
      const c = centroid(z.points);
      const label = z.name || z.plants.map(e => rp(e).name).join(', ');
      if (label) s += `<text x="${c.x}" y="${c.y}" font-size="${px(13)}" text-anchor="middle" dominant-baseline="middle" fill="#1d2a1f" stroke="#fff" stroke-width="${px(3)}" paint-order="stroke">${esc(label)}</text>`;
    }
    // edge lengths of the border
    const bp = border.points;
    if (bp.length >= 2 && st.mode !== 'drawBorder') {
      for (let i = 0; i < bp.length; i++) {
        const a = bp[i], b = bp[(i + 1) % bp.length];
        if (bp.length === 2 && i === 1) break;
        s += `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2}" font-size="${px(11)}" text-anchor="middle" fill="#3b4b36" stroke="#fff" stroke-width="${px(3)}" paint-order="stroke">${m2(dist(a, b))} m</text>`;
      }
    }
    // draft
    if (st.draft.length) {
      s += `<polyline points="${poly(st.draft)}" fill="none" stroke="#d6730a" stroke-width="${px(2.5)}" stroke-dasharray="${px(6)}"/>`;
      st.draft.forEach((p, i) => { s += `<circle cx="${p.x}" cy="${p.y}" r="${px(i === 0 ? 9 : 6)}" fill="${i === 0 ? '#2f6b3a' : '#d6730a'}"/>`; });
    }
    // handles
    if (st.mode === 'edit') {
      const pts = selPts();
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        s += `<circle cx="${(p.x + q.x) / 2}" cy="${(p.y + q.y) / 2}" r="${px(6)}" fill="#fff" stroke="#d6730a" stroke-width="${px(1.5)}" opacity=".85"/>`;
      });
      pts.forEach((p, i) => {
        s += `<circle cx="${p.x}" cy="${p.y}" r="${px(i === st.selVertex ? 11 : 9)}" fill="${i === st.selVertex ? '#b3382c' : '#d6730a'}" stroke="#fff" stroke-width="${px(2)}"/>`;
      });
    }
    svg.innerHTML = s;
  }

  function renderTools() {
    const btn = (label, on, fn, disabled, kind) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('on', !!on);
      if (kind) b.classList.add(kind);
      b.disabled = !!disabled;
      b.onclick = fn;
      return b;
    };
    tools.innerHTML = '';
    const hasBorder = border.points.length >= 3;
    const drawing = st.mode === 'drawBorder' || st.mode === 'drawZone';
    const goMode = m => () => { st.mode = m; st.draft = []; st.selVertex = -1; update(); };

    const actions = [];
    if (drawing) {
      actions.push(
        btn('Finish', false, finishDraft, st.draft.length < 3, 'primary'),
        btn('Undo last point', false, () => { st.draft.pop(); update(); }, !st.draft.length),
      );
      if (st.mode === 'drawZone') {
        actions.push(btn(st.snap ? 'Snap: on' : 'Snap: off', st.snap, toggleSnap), btn('Cancel', false, goMode('view')));
      }
    } else if (st.mode === 'edit') {
      const isZone = st.sel.kind === 'zone';
      actions.push(
        btn('Edge lengths', false, lengthsDialog),
        btn('Delete point', false, deleteVertex, st.selVertex < 0 || selPts().length <= 3),
      );
      if (isZone) {
        actions.push(
          btn('Plants', false, () => zoneDialog(border, selZone(), update, false)),
          btn(st.snap ? 'Snap: on' : 'Snap: off', st.snap, toggleSnap),
          btn('Delete zone', false, () => {
            if (confirm('Delete this zone and its plants?')) {
              border.zones = border.zones.filter(z => z.id !== st.sel.id);
              st.sel = { kind: 'border' }; save(); update();
            }
          }, false, 'danger'),
        );
      }
    }
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'tool-actions';
      const label = document.createElement('span');
      label.className = 'tool-label';
      label.textContent = drawing ? (st.mode === 'drawZone' ? 'New zone' : 'Border outline') : st.sel.kind === 'zone' ? 'Selected: zone' : 'Selected: border';
      row.append(label, ...actions);
      tools.append(row);
    }

    const modes = document.createElement('div');
    modes.className = 'tool-modes';
    modes.append(
      btn('View', st.mode === 'view', goMode('view'), !hasBorder),
      btn('Edit', st.mode === 'edit', goMode('edit'), !hasBorder),
      btn('Add zone', st.mode === 'drawZone', goMode('drawZone'), !hasBorder),
    );
    tools.append(modes);
    const hints = {
      view: border.zones.length ? 'Tap a zone to see or edit its plants. Drag to pan, pinch to zoom.' : 'Tap “Add zone” to mark where you planted something.',
      edit: st.sel.kind === 'zone' ? 'Editing a zone: drag its body to move it, drag orange points to reshape, drag a white dot to add a point. Tap empty space to edit the border.' : 'Editing the border. Drag orange points; drag a white dot to add a point. Tap a zone to edit it.',
      drawBorder: 'Tap the corners of the border one by one, then Finish. (Tap the green first point to close.)',
      drawZone: 'Tap the corners of the planted area, then Finish. With snap on, zones stay inside the border and cannot overlap other zones.',
    };
    hint.textContent = hints[st.mode];
  }

  function toggleSnap() {
    st.snap = !st.snap;
    localStorage.setItem('snapToBorder', st.snap ? '1' : '0');
    update();
  }

  function update() { renderTools(); render(); }

  function finishDraft() {
    if (st.draft.length < 3) return;
    if (st.mode === 'drawBorder') {
      border.points = st.draft;
      st.mode = 'view';
      st.draft = [];
      save(); fit(); update();
    } else {
      if (!zoneFits(st.draft, null)) { alert('This zone overlaps another zone or leaves the border. Adjust the points, or turn Snap off.'); return; }
      const zone = { id: uid(), name: '', points: st.draft, plants: [] };
      border.zones.push(zone);
      st.draft = []; st.mode = 'view'; save(); update();
      zoneDialog(border, zone, update, true);
    }
  }

  function deleteVertex() {
    const pts = selPts();
    if (st.selVertex >= 0 && pts.length > 3) { pts.splice(st.selVertex, 1); st.selVertex = -1; save(); update(); }
  }

  function lengthsDialog() {
    const pts = selPts();
    const rows = pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      return `<div class="row"><span class="grow">Point ${i + 1} → ${(i + 1) % pts.length + 1}</span><input type="number" step="0.01" min="0.01" style="width:7em" data-i="${i}" value="${m2(dist(p, q))}"> m</div>`;
    }).join('');
    openDialog(`<h2>Edge lengths</h2>
      <p class="muted">Changing a length moves the next point along that edge. Adjust edges in order for a precise shape.</p>${rows}
      <div class="dlg-btns"><button class="btn alt" id="l-cancel">Cancel</button><button class="btn" id="l-ok">Apply</button></div>`,
    d => {
      d.querySelector('#l-cancel').onclick = closeDialog;
      d.querySelector('#l-ok').onclick = () => {
        d.querySelectorAll('input[data-i]').forEach(inp => {
          const i = +inp.dataset.i, j = (i + 1) % pts.length;
          const len = parseFloat(inp.value) * 100;
          if (len > 0 && Math.abs(len - dist(pts[i], pts[j])) > 0.5) pts[j] = setEdgeLength(pts[i], pts[j], len);
        });
        save(); closeDialog(); update();
      };
    });
  }

  // ----- pointer handling: pan, pinch, drag vertices, tap -----
  const ptrs = new Map();
  let g = null; // current single-pointer gesture
  let pinch = null;

  const dpx = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / k();

  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), w: st.vb.w, anchor: world(mid) };
      g = { type: 'none', moved: true };
      return;
    }
    const pt = world(e);
    g = { type: 'pan', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, t: Date.now(), pt };
    if (st.mode === 'edit') {
      const pts = selPts();
      const zone = selZone();
      g.backup = pts.map(p => ({ ...p }));
      const vi = pts.findIndex(p => dpx(p, pt) < 18);
      if (vi >= 0) { g.type = 'vertex'; g.i = vi; st.selVertex = vi; renderTools(); render(); return; }
      const mi = pts.findIndex((p, i) => dpx({ x: (p.x + pts[(i + 1) % pts.length].x) / 2, y: (p.y + pts[(i + 1) % pts.length].y) / 2 }, pt) < 16);
      if (mi >= 0) {
        const q = pts[(mi + 1) % pts.length];
        pts.splice(mi + 1, 0, { x: (pts[mi].x + q.x) / 2, y: (pts[mi].y + q.y) / 2 });
        g.type = 'vertex'; g.i = mi + 1; st.selVertex = mi + 1; g.moved = true; renderTools(); render();
      } else if (zone && pointInPolygon(pt, zone.points)) {
        g.type = 'move';
      }
    }
  });

  svg.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const r = rect();
      const nd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      st.vb.w = Math.min(Math.max(pinch.w * pinch.d / nd, 30), 50000);
      const kk = st.vb.w / r.width;
      st.vb.x = pinch.anchor.x - ((a.x + b.x) / 2 - r.left) * kk;
      st.vb.y = pinch.anchor.y - ((a.y + b.y) / 2 - r.top) * kk;
      render();
      return;
    }
    if (!g) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) g.moved = true;
    if (g.type === 'vertex') {
      let p = world(e);
      if (st.sel.kind === 'zone') p = constrain(p, st.sel.id);
      selPts()[g.i] = { x: p.x, y: p.y };
      render();
    } else if (g.type === 'move' && g.moved) {
      const p = world(e);
      const dx = p.x - g.pt.x, dy = p.y - g.pt.y;
      const zone = selZone();
      zone.points = g.backup.map(q => ({ x: q.x + dx, y: q.y + dy }));
      render();
    } else if (g.type === 'pan' && g.moved) {
      const kk = k();
      st.vb.x -= (e.clientX - g.lx) * kk;
      st.vb.y -= (e.clientY - g.ly) * kk;
      g.lx = e.clientX; g.ly = e.clientY;
      render();
    }
  });

  const endPtr = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size > 0) { if (g) g.moved = true; return; }
    const done = g; g = null;
    if (!done) return;
    if (done.type === 'vertex' || (done.type === 'move' && done.moved)) {
      const zone = selZone();
      if (zone && !zoneFits(zone.points, zone.id)) {
        zone.points = done.backup;
        alert('A zone cannot overlap another zone or leave the border (turn Snap off to allow it).');
      }
      save(); update(); return;
    }
    if (!done.moved && e.type === 'pointerup') onTap(done.pt);
  };
  svg.addEventListener('pointerup', endPtr);
  svg.addEventListener('pointercancel', endPtr);

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const anchor = world(e), r = rect();
    st.vb.w = Math.min(Math.max(st.vb.w * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 30), 50000);
    const kk = st.vb.w / r.width;
    st.vb.x = anchor.x - (e.clientX - r.left) * kk;
    st.vb.y = anchor.y - (e.clientY - r.top) * kk;
    render();
  }, { passive: false });

  function topZoneAt(pt) {
    for (let i = border.zones.length - 1; i >= 0; i--) if (pointInPolygon(pt, border.zones[i].points)) return border.zones[i];
    return null;
  }

  function onTap(pt) {
    if (st.mode === 'drawBorder' || st.mode === 'drawZone') {
      if (st.draft.length >= 3 && dpx(st.draft[0], pt) < 16) return finishDraft();
      let p = pt;
      if (st.mode === 'drawZone') {
        const near = [...border.points, ...border.zones.flatMap(z => z.points)].find(q => dpx(q, pt) < 14);
        p = near ? { x: near.x, y: near.y } : constrain(pt, null);
      }
      st.draft.push({ x: p.x, y: p.y });
      return update();
    }
    const z = topZoneAt(pt);
    if (st.mode === 'view') {
      if (z) zoneDialog(border, z, update, false);
    } else if (st.mode === 'edit') {
      st.selVertex = -1;
      st.sel = z ? { kind: 'zone', id: z.id } : { kind: 'border' };
      update();
    }
  }

  new ResizeObserver(() => render()).observe(svg);
  requestAnimationFrame(() => { fit(); update(); });
}

function borderMenu(border) {
  openDialog(`<h2>${esc(border.name)}</h2>
    <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
      <button class="btn alt" id="m-rename">Rename</button>
      <button class="btn alt" id="m-photo">${border.photo ? 'View / replace photo' : 'Add photo'}</button>
      <button class="btn alt" id="m-cal">Colour calendar</button>
      <button class="btn danger" id="m-del">Delete border</button>
      <button class="btn alt" id="m-close">Close</button>
    </div>`,
  d => {
    d.querySelector('#m-close').onclick = closeDialog;
    d.querySelector('#m-rename').onclick = () => {
      openDialog(`<h2>Rename border</h2><input type="text" id="rn-name" value="${esc(border.name)}">
        <div class="dlg-btns"><button class="btn alt" id="rn-cancel">Cancel</button><button class="btn" id="rn-ok">Save</button></div>`,
      r => {
        r.querySelector('#rn-cancel').onclick = closeDialog;
        r.querySelector('#rn-ok').onclick = () => {
          const n = r.querySelector('#rn-name').value.trim();
          if (n) { border.name = n; save(); closeDialog(); openEditor(border.id); }
        };
      });
    };
    d.querySelector('#m-photo').onclick = () => photoDialog(border);
    d.querySelector('#m-cal').onclick = () => calendarDialog([border]);
    d.querySelector('#m-del').onclick = () => {
      if (confirm(`Delete “${border.name}” and everything in it?`)) {
        data.borders = data.borders.filter(b => b !== border);
        save(); closeDialog(); showList();
      }
    };
  });
}

function photoDialog(border) {
  openDialog(`<h2>Photo</h2>
    ${border.photo ? `<img src="${border.photo}" style="width:100%;border-radius:8px">` : '<p class="muted">No photo yet.</p>'}
    <label>Take or choose a photo</label><input type="file" accept="image/*" id="ph-file">
    <div class="dlg-btns">${border.photo ? '<button class="btn danger" id="ph-del">Remove</button>' : ''}<button class="btn alt" id="ph-close">Close</button></div>`,
  d => {
    d.querySelector('#ph-close').onclick = closeDialog;
    d.querySelector('#ph-del')?.addEventListener('click', () => { border.photo = null; save(); photoDialog(border); });
    d.querySelector('#ph-file').onchange = async ev => {
      const f = ev.target.files[0];
      if (!f) return;
      border.photo = await downscale(f, 1600);
      save();
      photoDialog(border);
    };
  });
}

function downscale(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- zone / plants popup ----------
function zoneDialog(border, zone, onClose, isNew) {
  const today = new Date().toISOString().slice(0, 10);
  const newEntry = () => ({ id: uid(), plantId: '', planted: today, note: '' });
  const plantOptions = sel => '<option value="">Choose a plant…</option>' +
    [...data.plants].sort(byName).map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('') +
    '<option value="__new__">＋ Create new plant…</option>';
  const plantHtml = e => {
    const p = data.plants.find(x => x.id === e.plantId);
    return `
    <div class="plant" data-id="${e.id}">
      <label>Plant</label><select class="p-plant">${plantOptions(e.plantId)}</select>
      ${p ? `<div class="muted" style="margin-top:4px"><span class="dot" style="background:${esc(p.color)}"></span>${esc(plantSummary(p))}</div>` : ''}
      <label>Planted on</label><input type="date" class="p-date" value="${esc(e.planted)}">
      <label>Note (optional)</label><input type="text" class="p-note" value="${esc(e.note)}" placeholder="e.g. 20 bulbs">
      <div class="dlg-btns" style="margin-top:6px">${p ? '<button class="btn alt p-edit">Edit plant</button>' : ''}<button class="btn danger p-del">Remove</button></div>
    </div>`;
  };
  const work = zone.plants.map(e => ({ ...e }));
  const sources = data.borders.flatMap(b => b.zones.filter(z => z !== zone && z.plants.length).map(z => ({
    zone: z,
    label: `${b.name} – ${z.name || z.plants.map(e => rp(e).name).join(', ')} (${z.plants.length})`,
  })));
  if (!work.length) work.push(newEntry());

  const readAll = d => [...d.querySelectorAll('.plant')].map(el => ({
    id: el.dataset.id,
    plantId: el.querySelector('.p-plant').value === '__new__' ? '' : el.querySelector('.p-plant').value,
    planted: el.querySelector('.p-date').value,
    note: el.querySelector('.p-note').value.trim(),
  }));

  function draw(plants) {
    openDialog(`<h2>${isNew ? 'New zone' : 'Zone'}</h2>
      <div class="muted">${m2(polygonArea(zone.points) / 100)} m²</div>
      <label>Zone name (optional)</label><input type="text" id="z-name" value="${esc(zone.name)}">
      <div id="plants">${plants.map(plantHtml).join('')}</div>
      <button class="btn alt" id="z-add">+ Add plant</button>
      ${sources.length ? `<label>Copy plants from another zone</label>
      <div class="row"><select id="z-src" class="grow">${sources.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join('')}</select>
      <button class="btn alt" id="z-copy">Copy</button></div>` : ''}
      <div class="dlg-btns"><button class="btn danger" id="z-del">Delete zone</button><button class="btn alt" id="z-cancel">${isNew ? 'Skip' : 'Cancel'}</button><button class="btn" id="z-save">Save</button></div>`,
    d => {
      d.querySelector('#z-copy')?.addEventListener('click', () => {
        const src = sources[+d.querySelector('#z-src').value];
        const cur = readAll(d).filter(e => e.plantId);
        draw([...cur, ...src.zone.plants.map(e => ({ ...e, id: uid() }))]);
      });
      d.querySelector('#z-add').onclick = () => { const cur = readAll(d); cur.push(newEntry()); draw(cur); };
      d.querySelectorAll('.p-plant').forEach(sel => sel.onchange = () => {
        const cur = readAll(d);
        if (sel.value !== '__new__') return draw(cur);
        const id = sel.closest('.plant').dataset.id;
        plantDialog(null, np => { cur.find(e => e.id === id).plantId = np.id; draw(cur); }, () => draw(cur));
      });
      d.querySelectorAll('.p-edit').forEach(bt => bt.onclick = () => {
        const cur = readAll(d);
        const entry = cur.find(e => e.id === bt.closest('.plant').dataset.id);
        plantDialog(data.plants.find(p => p.id === entry.plantId), () => draw(cur), () => draw(cur));
      });
      d.querySelectorAll('.p-del').forEach(bt => bt.onclick = () => {
        const id = bt.closest('.plant').dataset.id;
        draw(readAll(d).filter(e => e.id !== id));
      });
      d.querySelector('#z-cancel').onclick = () => { closeDialog(); onClose?.(); };
      d.querySelector('#z-del').onclick = () => {
        if (confirm('Delete this zone?')) { border.zones = border.zones.filter(z => z !== zone); save(); closeDialog(); onClose?.(); }
      };
      d.querySelector('#z-save').onclick = () => {
        zone.name = d.querySelector('#z-name').value.trim();
        zone.plants = readAll(d).filter(e => e.plantId);
        save(); closeDialog(); onClose?.();
      };
    });
  }
  draw(work);
}

const monthOptions = sel => '<option value="0">—</option>' + MONTHS.map((m, i) => `<option value="${i + 1}"${sel === i + 1 ? ' selected' : ''}>${m}</option>`).join('');

function plantSummary(p) {
  return [
    p.bloomFrom && p.bloomTo ? `blooms ${MONTHS[p.bloomFrom - 1]}–${MONTHS[p.bloomTo - 1]}` : '',
    p.water && 'water: ' + label(WATER, p.water),
    p.sun && label(SUN, p.sun),
  ].filter(Boolean).join(' · ') || 'No details yet';
}

// Create (plant = null) or edit a library plant. Calls onDone(plant) after saving; closes itself first.
function plantDialog(plant, onDone, onCancel, canDelete = false) {
  const p = plant ?? { id: uid(), name: '', color: '#e8a2c1', bloomFrom: 0, bloomTo: 0, water: '', sun: '', notes: '' };
  openDialog(`<h2>${plant ? 'Edit plant' : 'New plant'}</h2>
    ${plant ? '<p class="muted">Changes apply to every zone that uses this plant.</p>' : ''}
    <label>Name</label><input type="text" id="pl-name" value="${esc(p.name)}" placeholder="e.g. Tulip ‘Queen of Night’">
    <div class="row"><div class="grow"><label>Blooms from</label><select id="pl-from">${monthOptions(p.bloomFrom)}</select></div>
    <div class="grow"><label>until</label><select id="pl-to">${monthOptions(p.bloomTo)}</select></div>
    <div><label>Colour</label><input type="color" id="pl-color" value="${esc(p.color)}"></div></div>
    <div class="row"><div class="grow"><label>Water</label><select id="pl-water">${opts(WATER, p.water)}</select></div>
    <div class="grow"><label>Sun / shade</label><select id="pl-sun">${opts(SUN, p.sun)}</select></div></div>
    <label>Notes</label><textarea id="pl-notes" rows="2">${esc(p.notes)}</textarea>
    <div class="dlg-btns">${plant && canDelete ? '<button class="btn danger" id="pl-del">Delete</button>' : ''}<button class="btn alt" id="pl-cancel">Cancel</button><button class="btn" id="pl-save">Save</button></div>`,
  d => {
    d.querySelector('#pl-cancel').onclick = () => { closeDialog(); onCancel?.(); };
    d.querySelector('#pl-del')?.addEventListener('click', () => {
      const uses = data.borders.flatMap(b => b.zones).filter(z => z.plants.some(e => e.plantId === p.id)).length;
      if (!confirm(uses ? `“${p.name}” is planted in ${uses} zone(s). Delete it from the library and from those zones?` : `Delete “${p.name}”?`)) return;
      data.plants = data.plants.filter(x => x.id !== p.id);
      data.borders.forEach(b => b.zones.forEach(z => { z.plants = z.plants.filter(e => e.plantId !== p.id); }));
      save(); closeDialog(); onDone(null);
    });
    d.querySelector('#pl-save').onclick = () => {
      const name = d.querySelector('#pl-name').value.trim();
      if (!name) { alert('Please enter a name.'); return; }
      Object.assign(p, {
        name,
        color: d.querySelector('#pl-color').value,
        bloomFrom: +d.querySelector('#pl-from').value,
        bloomTo: +d.querySelector('#pl-to').value,
        water: d.querySelector('#pl-water').value,
        sun: d.querySelector('#pl-sun').value,
        notes: d.querySelector('#pl-notes').value.trim(),
      });
      if (!plant) data.plants.push(p);
      save(); closeDialog(); onDone(p);
    };
  });
}

const WATER = [['', '—'], ['low', 'Low (dry)'], ['medium', 'Medium'], ['high', 'High (moist)']];
const SUN = [['', '—'], ['sun', 'Full sun'], ['partial', 'Partial shade'], ['shade', 'Full shade']];
const opts = (list, sel) => list.map(([v, l]) => `<option value="${v}"${(sel || '') === v ? ' selected' : ''}>${l}</option>`).join('');
const label = (list, v) => list.find(([k]) => k === v)?.[1];

// ---------- colour calendar ----------
function blooms(p, month) {
  if (!p.bloomFrom || !p.bloomTo) return false;
  return p.bloomFrom <= p.bloomTo ? month >= p.bloomFrom && month <= p.bloomTo : month >= p.bloomFrom || month <= p.bloomTo;
}

function calendarDialog(borders) {
  const plants = [...new Map(borders.flatMap(b => b.zones.flatMap(z => z.plants.map(rp))).map(p => [p.plantId, p])).values()];
  const cells = MONTHS.map((m, i) => {
    const list = plants.filter(p => blooms(p, i + 1));
    const dots = [...new Set(list.map(p => p.color))].map(c => `<span class="dot" style="background:${esc(c)}"></span>`).join('');
    const names = list.map(p => `<small>${esc(p.name)}</small>`).join('');
    return `<div class="m"><b>${m}</b>${dots || '<small>—</small>'}${names}</div>`;
  }).join('');
  openDialog(`<h2>Colour calendar</h2>
    <p class="muted">Based on the bloom months you entered for each plant.</p>
    <div class="cal">${cells}</div>
    <div class="dlg-btns"><button class="btn alt" id="c-close">Close</button></div>`,
  d => { d.querySelector('#c-close').onclick = closeDialog; });
}

// ---------- plants overview ----------
function showPlants() {
  setNav('plants');
  setHeader('Plants', { actions: [
    { label: 'Colours', onClick: () => calendarDialog(data.borders) },
    { label: '+ Add', onClick: () => plantDialog(null, showPlants) },
  ] });
  main.innerHTML = '<div class="pad"><input type="text" id="q" placeholder="Search plants…"><div id="res" style="margin-top:10px"></div></div>';
  const draw = () => {
    const q = $('q').value.trim().toLowerCase();
    const rows = data.plants.filter(p => !q || p.name.toLowerCase().includes(q)).sort(byName);
    $('res').innerHTML = rows.length ? '' : `<p class="muted">${data.plants.length ? 'No plants found.' : 'No plants yet. Tap “+ Add” to add your first plant.'}</p>`;
    for (const p of rows) {
      const places = data.borders.flatMap(b => b.zones.flatMap(z => z.plants.filter(e => e.plantId === p.id)
        .map(e => `${b.name} – ${z.name || 'Unnamed zone'}${e.planted ? ' (planted ' + e.planted + ')' : ''}`)));
      const c = document.createElement('div');
      c.className = 'card click';
      c.innerHTML = `<span class="dot" style="background:${esc(p.color)}"></span><b>${esc(p.name)}</b>
        <div class="muted">${esc(plantSummary(p))}</div>
        <div class="muted" style="margin-top:4px">${places.length ? 'Planted in:<br>' + places.map(esc).join('<br>') : 'Not planted yet'}</div>`;
      c.onclick = () => plantDialog(p, showPlants, null, true);
      $('res').append(c);
    }
  };
  $('q').oninput = draw;
  draw();
}

// ---------- backup ----------
function showSettings() {
  setNav('settings');
  setHeader('Backup');
  main.innerHTML = `<div class="pad">
    <p class="muted">Your data lives only on this phone. Export a backup file regularly (browser data can be cleared).</p>
    <div class="row"><button class="btn" id="exp">Export backup</button>
    <label class="btn alt" style="margin:0">Import backup<input type="file" id="imp" accept="application/json" hidden></label></div></div>`;
  $('exp').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `border-planner-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('imp').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const imported = JSON.parse(await f.text());
      if (!Array.isArray(imported.borders)) throw new Error('Not a Border Planner backup');
      if (!confirm('Replace all current data with this backup?')) return;
      migrate(imported);
      data = imported; save(); showList();
    } catch (err) { alert('Import failed: ' + err.message); }
  };
}

// ---------- start ----------
(async () => {
  data = await loadData();
  if (migrate(data)) save();
  showList();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
