import { uid } from './store.js';

const ORTHO_URL = 'https://geo.api.vlaanderen.be/OFW/wmts';
const WFS_URL = 'https://geo.api.vlaanderen.be/GRB/wfs';
const TILE_ORIGIN_X = 9928;
const TILE_ORIGIN_Y = 329072;
const TILE_SIZE = 256;
const TILE_MATRICES = Array.from({ length: 16 }, (_, zoom) => ({
  id: String(zoom),
  resolution: 1024 / (2 ** zoom),
  width: 2 ** zoom,
}));

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function gardenPlanning(garden) {
  garden.planning ??= {};
  garden.planning.showGrid ??= false;
  garden.planning.snapToGrid ??= false;
  if (!['satellite', 'lines'].includes(garden.planning.viewMode)) garden.planning.viewMode = 'satellite';
  garden.planning.placements ??= [];
  garden.planning.imageBoundary ??= null;
  garden.planning.gardenBoundary ??= null;
  garden.planning.showOfficialParcel ??= false;
  return garden.planning;
}

function setToolsOpen(workspace, toolsToggle, open) {
  workspace.classList.toggle('garden-tools-open', open);
  toolsToggle.setAttribute('aria-expanded', String(open));
  toolsToggle.textContent = open ? 'Hide tools' : 'Tools';
}

function parcelBounds(garden) {
  const points = garden.parcel.polygons.flat(2);
  return {
    minX: Math.min(...points.map(point => point[0])),
    maxX: Math.max(...points.map(point => point[0])),
    minY: Math.min(...points.map(point => point[1])),
    maxY: Math.max(...points.map(point => point[1])),
  };
}

function geometryPath(geometry) {
  if (!geometry) return '';
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.flatMap(rings => rings).map(ring => {
    if (!Array.isArray(ring) || !ring.length) return '';
    return `M${ring.map(point => `${point[0]},${-point[1]}`).join('L')}Z`;
  }).join('');
}

function containsPoint(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function featureInsideParcel(geometry, parcelPolygons) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(rings => {
    const points = rings[0] || [];
    if (!points.length) return false;
    const x = (Math.min(...points.map(point => point[0])) + Math.max(...points.map(point => point[0]))) / 2;
    const y = (Math.min(...points.map(point => point[1])) + Math.max(...points.map(point => point[1]))) / 2;
    return parcelPolygons.some(parcelRings => parcelRings.length &&
      containsPoint(parcelRings[0], x, y) && !parcelRings.slice(1).some(ring => containsPoint(ring, x, y)));
  });
}

export function mountGardenMap(container, garden, { borders, plants, onChange }) {
  const planning = gardenPlanning(garden);
  const bounds = parcelBounds(garden);
  const maskId = `garden-mask-${uid()}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('garden-map');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Interactive garden map. Tap to add outline points, drag to pan, and pinch to zoom.');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const parcelMask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
  parcelMask.id = maskId;
  parcelMask.setAttribute('maskUnits', 'userSpaceOnUse');
  parcelMask.setAttribute('mask-type', 'luminance');
  defs.append(parcelMask);
  const [tileLayer, parcelLayer, imageBoundaryLayer, gardenBoundaryLayer, buildingLayer, borderLayer] =
    ['tiles', 'parcel', 'image-boundary', 'garden-boundary', 'buildings', 'borders']
    .map(name => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.layer = name;
      return group;
    });
  tileLayer.setAttribute('mask', `url(#${maskId})`);
  svg.append(defs, tileLayer, parcelLayer, imageBoundaryLayer, gardenBoundaryLayer, buildingLayer, borderLayer);
  container.innerHTML = `
    <div class="garden-workspace">
      <section class="garden-map-stage" aria-label="Garden map workspace">
        <div class="garden-map-controls">
          <button class="btn alt garden-mobile-exit" type="button" id="garden-exit" aria-label="Back to app">‹</button>
          <button class="btn alt garden-mobile-tools" type="button" id="garden-toggle-tools" aria-expanded="false">Tools</button>
          <div class="garden-view-switch" role="group" aria-label="Map style">
            <button type="button" class="on" data-garden-view="satellite" aria-pressed="true">Satellite</button>
            <button type="button" data-garden-view="lines" aria-pressed="false">Clean lines</button>
          </div>
          <button class="btn alt" type="button" id="garden-fit">Fit garden</button>
          <label class="garden-map-toggle" id="garden-grid-control"><input type="checkbox" id="garden-grid"><span id="garden-grid-label">Distance grid</span></label>
          <label class="garden-map-toggle" id="garden-snap-control"><input type="checkbox" id="garden-snap-grid"> Snap to grid</label>
          <span class="garden-zoom-controls"><button type="button" id="garden-zoom-out" aria-label="Zoom out">−</button><button type="button" id="garden-zoom-in" aria-label="Zoom in">+</button></span>
        </div>
        <div class="garden-map-wrap"><div class="garden-map-status" id="garden-map-status" role="status" aria-live="polite"></div></div>
        <div class="garden-map-legend">
          <span class="legend-official-parcel"><i class="garden-parcel-key"></i>Official parcel</span>
          <span class="legend-image-boundary"><i class="garden-image-boundary-key"></i>Image area</span>
          <span class="legend-garden-boundary"><i class="garden-boundary-key"></i>Garden edge</span>
          <span><i class="garden-house-key"></i>House</span>
          <span><i class="garden-border-key"></i>Placed borders</span>
        </div>
      </section>
      <aside class="garden-tools-panel" aria-label="Garden drawing tools">
        <details class="garden-tool-section" open>
          <summary><span>1</span> Satellite image area</summary>
          <p>Draw the area to keep in view. Satellite imagery outside it is hidden.</p>
          <div class="garden-tool-actions">
            <button class="btn alt" type="button" id="garden-draw-image-area">Draw image area</button>
            <button class="btn alt" type="button" id="garden-edit-image-area">Edit points</button>
            <button class="btn" type="button" id="garden-finish-image-area" hidden>Save area</button>
            <button class="btn alt" type="button" id="garden-undo-image-area" hidden>Undo point</button>
            <button class="btn alt" type="button" id="garden-remove-image-point" hidden disabled>Remove selected point</button>
            <button class="btn" type="button" id="garden-done-edit-image-area" hidden>Done editing</button>
            <button class="btn alt" type="button" id="garden-cancel-image-area" hidden>Cancel</button>
            <button class="btn alt" type="button" id="garden-reset-image-area" hidden>Use official parcel</button>
          </div>
          <p class="garden-tool-hint" id="garden-image-area-status"></p>
        </details>
        <details class="garden-tool-section" open>
          <summary><span>2</span> Garden perimeter</summary>
          <p>Trace the outer edge over your fences or hedges. Drag points to adjust; click a line to add a point.</p>
          <div class="garden-tool-actions">
            <button class="btn alt" type="button" id="garden-draw-perimeter">Draw perimeter</button>
            <button class="btn alt" type="button" id="garden-edit-perimeter">Edit points</button>
            <button class="btn" type="button" id="garden-finish-perimeter" hidden>Save perimeter</button>
            <button class="btn alt" type="button" id="garden-undo-perimeter" hidden>Undo point</button>
            <button class="btn alt" type="button" id="garden-remove-perimeter-point" hidden disabled>Remove selected point</button>
            <button class="btn" type="button" id="garden-done-edit-perimeter" hidden>Done editing</button>
            <button class="btn alt" type="button" id="garden-cancel-perimeter" hidden>Cancel</button>
            <button class="btn alt" type="button" id="garden-clear-perimeter" hidden>Clear perimeter</button>
          </div>
          <label class="garden-parcel-toggle"><input type="checkbox" id="garden-show-official-parcel"> Show official parcel in Clean Lines</label>
          <p class="garden-tool-hint" id="garden-perimeter-status"></p>
        </details>
        <details class="garden-tool-section" open>
          <summary><span>3</span> Place saved borders</summary>
          <p>Tap the map to place a border. Drag the map to pan or a placed border to move it; pinch to zoom.</p>
          <div class="garden-tool-actions garden-place-row">
            <select id="garden-border-select" aria-label="Border to place"></select>
            <button class="btn" type="button" id="garden-place-border">Place</button>
          </div>
          <div id="garden-placements"></div>
        </details>
        <p class="garden-attribution">Aerial imagery: <a href="https://metadata.vlaanderen.be/srv/api/records/50134be3-f0cd-47c5-8f6e-4a0936287947" target="_blank" rel="noreferrer">Digitaal Vlaanderen orthophoto service</a>. House outlines: Digitaal Vlaanderen GRB.</p>
      </aside>
    </div>
  `;
  const mapWrap = container.querySelector('.garden-map-wrap');
  mapWrap.append(svg);

  const status = container.querySelector('#garden-map-status');
  tileLayer.addEventListener('error', () => {
    status.textContent = 'Aerial imagery could not be loaded. Check your connection and try again.';
  }, true);
  const placementsList = container.querySelector('#garden-placements');
  const gridInput = container.querySelector('#garden-grid');
  const snapGridInput = container.querySelector('#garden-snap-grid');
  const borderSelect = container.querySelector('#garden-border-select');
  const imageAreaStatus = container.querySelector('#garden-image-area-status');
  const perimeterStatus = container.querySelector('#garden-perimeter-status');
  const officialParcelInput = container.querySelector('#garden-show-official-parcel');
  const workspace = container.querySelector('.garden-workspace');
  const toolsToggle = container.querySelector('#garden-toggle-tools');
  const view = { x: 0, y: 0, w: 1, h: 1 };
  let initialFrame;
  const state = {
    mode: 'pan',
    selectedPlacement: null,
    gesture: null,
    activePointers: new Map(),
    shapeDraft: null,
    editingKind: null,
    editSnapshot: null,
    selectedVertex: -1,
    tileKey: '',
    featureMarkup: '',
    featureController: null,
    featureSequence: 0,
    resizeObserver: null,
    hasFitted: false,
  };

  function outlinePoints(kind) {
    if (state.shapeDraft?.kind === kind) return state.shapeDraft.points;
    return kind === 'image' ? planning.imageBoundary : planning.gardenBoundary;
  }

  function imageRings() {
    const draft = state.shapeDraft?.kind === 'image' ? state.shapeDraft.points : null;
    const points = draft?.length >= 3 ? draft : planning.imageBoundary;
    return points?.length >= 3
      ? [[points.map(point => [point.x, point.y])]]
      : garden.parcel.polygons;
  }

  function activeAreaBounds() {
    const points = outlinePoints('image');
    if (points?.length >= 3) {
      return {
        minX: Math.min(...points.map(point => point.x)),
        maxX: Math.max(...points.map(point => point.x)),
        minY: Math.min(...points.map(point => point.y)),
        maxY: Math.max(...points.map(point => point.y)),
      };
    }
    return bounds;
  }

  const resizeView = () => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    view.h = view.w * rect.height / rect.width;
  };

  function fitGarden() {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const margin = 5;
    const footprint = activeAreaBounds();
    const width = Math.max(footprint.maxX - footprint.minX + margin * 2, 10);
    const height = Math.max(footprint.maxY - footprint.minY + margin * 2, 10);
    view.w = Math.max(width, height * rect.width / rect.height);
    view.h = view.w * rect.height / rect.width;
    view.x = (footprint.minX + footprint.maxX) / 2 - view.w / 2;
    view.y = -(footprint.minY + footprint.maxY) / 2 - view.h / 2;
    state.hasFitted = true;
    draw();
  }

  const pointAt = event => {
    const rect = svg.getBoundingClientRect();
    const scale = view.w / rect.width;
    return {
      x: view.x + (event.clientX - rect.left) * scale,
      y: -(view.y + (event.clientY - rect.top) * scale),
    };
  };

  function beginPinch() {
    const pointers = [...state.activePointers.values()];
    if (pointers.length < 2) return;
    if (state.gesture && !['add', 'add-outline-point', 'pan'].includes(state.gesture.type)) return;
    const [first, second] = pointers;
    const rect = svg.getBoundingClientRect();
    const centerX = (first.clientX + second.clientX) / 2;
    const centerY = (first.clientY + second.clientY) / 2;
    state.gesture = {
      type: 'pinch',
      startDistance: Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)),
      startView: { ...view },
      anchorX: view.x + (centerX - rect.left) * view.w / rect.width,
      anchorY: -(view.y + (centerY - rect.top) * view.h / rect.height),
    };
  }

  function updatePinch() {
    const gesture = state.gesture;
    const pointers = [...state.activePointers.values()];
    if (gesture?.type !== 'pinch' || pointers.length < 2) return;
    const [first, second] = pointers;
    const rect = svg.getBoundingClientRect();
    const centerX = (first.clientX + second.clientX) / 2;
    const centerY = (first.clientY + second.clientY) / 2;
    const distance = Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY));
    view.w = Math.min(20000, Math.max(8, gesture.startView.w * gesture.startDistance / distance));
    view.h = view.w * rect.height / rect.width;
    view.x = gesture.anchorX - (centerX - rect.left) * view.w / rect.width;
    view.y = -gesture.anchorY - (centerY - rect.top) * view.h / rect.height;
    draw();
  }

  function tileImages() {
    const desiredResolution = view.w / Math.max(svg.clientWidth, 1);
    const tileCount = matrix => {
      const size = TILE_SIZE * matrix.resolution;
      const north = -view.y, south = -(view.y + view.h);
      const minCol = Math.max(0, Math.floor((view.x - TILE_ORIGIN_X) / size));
      const maxCol = Math.min(matrix.width - 1, Math.floor((view.x + view.w - TILE_ORIGIN_X) / size));
      const minRow = Math.max(0, Math.floor((TILE_ORIGIN_Y - north) / size));
      const maxRow = Math.min(matrix.width - 1, Math.floor((TILE_ORIGIN_Y - south) / size));
      return Math.max(0, maxCol - minCol + 1) * Math.max(0, maxRow - minRow + 1);
    };
    const availableMatrices = TILE_MATRICES.filter(matrix => tileCount(matrix) <= 16);
    const matrix = (availableMatrices.length ? availableMatrices : TILE_MATRICES).reduce((best, candidate) =>
      Math.abs(Math.log(candidate.resolution / desiredResolution)) <
      Math.abs(Math.log(best.resolution / desiredResolution)) ? candidate : best);
    const tileWorldSize = TILE_SIZE * matrix.resolution;
    const west = view.x, east = view.x + view.w;
    const north = -view.y, south = -(view.y + view.h);
    const minCol = Math.max(0, Math.floor((west - TILE_ORIGIN_X) / tileWorldSize));
    const maxCol = Math.min(matrix.width - 1, Math.floor((east - TILE_ORIGIN_X) / tileWorldSize));
    const minRow = Math.max(0, Math.floor((TILE_ORIGIN_Y - north) / tileWorldSize));
    const maxRow = Math.min(matrix.width - 1, Math.floor((TILE_ORIGIN_Y - south) / tileWorldSize));
    const images = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const left = TILE_ORIGIN_X + col * tileWorldSize;
        const top = TILE_ORIGIN_Y - row * tileWorldSize;
        const query = new URLSearchParams({
          SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile',
          LAYER: 'ofw', STYLE: 'default', FORMAT: 'image/png',
          TILEMATRIXSET: 'BPL72VL', TILEMATRIX: matrix.id,
          TILEROW: String(row), TILECOL: String(col),
        });
        images.push(`<image href="${ORTHO_URL}?${query}" x="${left}" y="${-top}" width="${tileWorldSize}" height="${tileWorldSize}" preserveAspectRatio="none"/>`);
      }
    }
    return {
      key: `${matrix.id}/${minCol}/${maxCol}/${minRow}/${maxRow}`,
      markup: images.join(''),
    };
  }

  function draw() {
    resizeView();
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const stroke = Math.max(view.w * 0.002, 0.15);
    const satelliteView = planning.viewMode !== 'lines';
    svg.classList.toggle('line-view', !satelliteView);
    mapWrap.classList.toggle('line-view', !satelliteView);
    container.querySelector('#garden-grid-control').hidden = !satelliteView;
    container.querySelector('#garden-snap-control').hidden = !satelliteView;
    tileLayer.style.display = satelliteView ? '' : 'none';
    buildingLayer.innerHTML = satelliteView ? '' : state.featureMarkup;
    container.querySelector('#garden-grid-label').textContent = `Distance grid (${gridStep()} m)`;
    if (satelliteView) {
      const tiles = tileImages();
      if (tiles.key !== state.tileKey) {
        tileLayer.innerHTML = tiles.markup;
        state.tileKey = tiles.key;
      }
    } else {
      tileLayer.replaceChildren();
      state.tileKey = '';
    }
    const parcelPolygons = garden.parcel.polygons.map(rings => rings.map(ring =>
      `M${ring.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join('')).join('');
    const activeRings = imageRings();
    const imageryBoundary = activeRings.map(rings => rings.map(ring =>
      `M${ring.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join('')).join('');
    parcelMask.setAttribute('x', String(view.x));
    parcelMask.setAttribute('y', String(view.y));
    parcelMask.setAttribute('width', String(view.w));
    parcelMask.setAttribute('height', String(view.h));
    parcelMask.innerHTML = `<rect x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}" fill="black"/>
      <path d="${imageryBoundary}" fill="white" fill-rule="evenodd"/>
      <path d="${imageryBoundary}" fill="none" stroke="white" stroke-width="10" stroke-linejoin="round"/>`;
    const gridPath = satelliteView && planning.showGrid ? gridMarkup(stroke) : '';
    const showOfficialParcel = satelliteView || planning.showOfficialParcel;
    parcelLayer.innerHTML = showOfficialParcel
      ? `<path d="${parcelPolygons}" class="garden-parcel-casing" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>
        <path d="${parcelPolygons}" class="garden-parcel-outline" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>`
      : '';
    imageBoundaryLayer.innerHTML = satelliteView ? outlineMarkup('image', stroke) : '';
    gardenBoundaryLayer.innerHTML = outlineMarkup('garden', stroke);
    container.querySelector('.legend-official-parcel').hidden = !showOfficialParcel;
    container.querySelector('.legend-image-boundary').hidden = !satelliteView;

    let markup = '';
    for (const placement of planning.placements) {
      const border = borders.find(item => item.id === placement.borderId);
      if (!border || border.points.length < 3) continue;
      const xs = border.points.map(point => point.x), ys = border.points.map(point => point.y);
      const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
      const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
      const selected = placement.id === state.selectedPlacement;
      const zones = border.zones.map(zone => {
        const path = `${zone.points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join('')}Z`;
        const color = zone.plants.map(entry => dataPlantColor(entry)).find(Boolean) || '#c3d6af';
        return `<path d="${path}" fill="${esc(color)}" fill-opacity=".68" stroke="#42543c" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
      }).join('');
      const outline = `${border.points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join('')}Z`;
      const labelFontSize = 14 * view.w / svg.clientWidth;
      const labelHeight = 20 * view.w / svg.clientWidth;
      const labelWidth = (border.name.length * 7.5 + 16) * view.w / svg.clientWidth;
      const labelY = -placement.y - labelHeight - 8 * view.w / svg.clientWidth;
      markup += `<g data-placement="${esc(placement.id)}" transform="translate(${placement.x},${-placement.y}) rotate(${placement.rotation || 0}) scale(0.01) translate(${-centerX},${-centerY})" class="garden-placed-border${selected ? ' selected' : ''}">
        ${zones}<path d="${outline}" fill="${selected ? '#e5a944' : '#f2d57c'}" fill-opacity=".35" stroke="${selected ? '#b54b19' : '#8a6122'}" stroke-width="3" vector-effect="non-scaling-stroke"/>
      </g>
      <g class="garden-border-label" pointer-events="none">
        <rect x="${placement.x - labelWidth / 2}" y="${labelY}" width="${labelWidth}" height="${labelHeight}" rx="${labelHeight / 2}" vector-effect="non-scaling-stroke"/>
        <text x="${placement.x}" y="${labelY + labelHeight * 0.68}" font-size="${labelFontSize}">${esc(border.name)}</text>
      </g>`;
    }

    borderLayer.innerHTML = markup;
  }

  function gridStep() {
    const desired = view.w / 12;
    const power = 10 ** Math.floor(Math.log10(desired));
    return [1, 2, 5, 10].map(multiplier => multiplier * power)
      .find(value => value >= desired) || power * 10;
  }

  function gridMarkup(stroke) {
    const step = gridStep();
    const north = -view.y, south = -(view.y + view.h);
    const firstX = Math.floor(view.x / step) * step;
    const firstY = Math.floor(south / step) * step;
    const lines = [];
    for (let x = firstX; x <= view.x + view.w; x += step) lines.push(`M${x},${-north}V${-south}`);
    for (let y = firstY; y <= north; y += step) lines.push(`M${view.x},${-y}H${view.x + view.w}`);
    return `<path d="${lines.join('')}" class="garden-grid" stroke-width="${stroke * 0.7}" vector-effect="non-scaling-stroke"/>`;
  }

  function outlineMarkup(kind, stroke) {
    const points = outlinePoints(kind);
    if (!points?.length) return '';
    const isDraft = state.shapeDraft?.kind === kind;
    const editable = isDraft || state.editingKind === kind;
    const pointList = points.map(point => `${point.x},${-point.y}`).join(' ');
    const className = kind === 'image' ? 'garden-image-boundary' : 'garden-boundary';
    const closed = points.length >= 3;
    const shapeClass = `${className}${isDraft ? ' garden-outline-draft' : ''}`;
    const path = closed
      ? `<polygon points="${pointList}" class="${shapeClass}" stroke-width="${stroke * 2}" vector-effect="non-scaling-stroke"/>`
      : `<polyline points="${pointList}" class="${shapeClass} garden-outline-draft" stroke-width="${stroke * 2}" vector-effect="non-scaling-stroke"/>`;
    const handles = editable
      ? points.map((point, index) => {
        const selected = index === state.selectedVertex && state.editingKind === kind;
        return `<circle cx="${point.x}" cy="${-point.y}" r="${stroke * 3}" class="garden-outline-handle garden-outline-handle-${kind}${selected ? ' selected' : ''}" data-outline-vertex="${kind}:${index}" vector-effect="non-scaling-stroke"/>`;
      }).join('')
      : '';
    return path + handles;
  }

  function dataPlantColor(entry) {
    return dataPlants.find(plant => plant.id === entry.plantId)?.color || '';
  }

  const dataPlants = plants;

  function mapPoint(event, allowSnap = true) {
    const point = pointAt(event);
    if (!allowSnap || planning.viewMode === 'lines' || !planning.snapToGrid) return point;
    const step = gridStep();
    return { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step };
  }

  function renderPlacementControls() {
    placementsList.replaceChildren();
    for (const placement of planning.placements) {
      const border = borders.find(item => item.id === placement.borderId);
      if (!border) continue;
      const row = document.createElement('div');
      row.className = 'garden-placement-row';
      row.classList.toggle('selected', placement.id === state.selectedPlacement);
      row.dataset.placement = placement.id;
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'garden-placement-name';
      name.textContent = border.name;
      name.onclick = () => { state.selectedPlacement = placement.id; renderPlacementControls(); draw(); };
      const rotation = document.createElement('input');
      rotation.type = 'range'; rotation.min = '-180'; rotation.max = '180'; rotation.step = '1'; rotation.value = String(placement.rotation || 0);
      rotation.setAttribute('aria-label', `${border.name} rotation in degrees`);
      const rotationLabel = document.createElement('span');
      rotationLabel.className = 'garden-rotation-value';
      rotationLabel.textContent = `${Number(placement.rotation || 0)}°`;
      rotation.oninput = () => {
        placement.rotation = Number(rotation.value);
        rotationLabel.textContent = `${placement.rotation}°`;
        draw(); onChange();
      };
      const turnLeft = document.createElement('button');
      turnLeft.type = 'button'; turnLeft.className = 'btn alt garden-turn'; turnLeft.textContent = '↶ 15°';
      turnLeft.setAttribute('aria-label', `Rotate ${border.name} 15 degrees counterclockwise`);
      const turnRight = document.createElement('button');
      turnRight.type = 'button'; turnRight.className = 'btn alt garden-turn'; turnRight.textContent = '↷ 15°';
      turnRight.setAttribute('aria-label', `Rotate ${border.name} 15 degrees clockwise`);
      const rotateBy = degrees => {
        const current = Number(placement.rotation);
        rotation.value = String(Math.max(-180, Math.min(180, (Number.isFinite(current) ? current : 0) + degrees)));
        rotation.dispatchEvent(new Event('input'));
      };
      turnLeft.onclick = () => rotateBy(-15);
      turnRight.onclick = () => rotateBy(15);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn alt'; remove.textContent = 'Remove';
      remove.onclick = () => {
        planning.placements = planning.placements.filter(item => item.id !== placement.id);
        if (state.selectedPlacement === placement.id) state.selectedPlacement = null;
        renderPlacementControls(); draw(); onChange();
      };
      const rotationControls = document.createElement('div');
      rotationControls.className = 'garden-rotation-controls';
      rotationControls.append(turnLeft, rotation, turnRight, rotationLabel);
      row.append(name, rotationControls, remove);
      placementsList.append(row);
    }
    if (!planning.placements.length) {
      const hint = document.createElement('p');
      hint.className = 'muted'; hint.textContent = 'No borders placed on this map yet.';
      placementsList.append(hint);
    }
  }

  function populateBorderSelect() {
    borderSelect.replaceChildren();
    const available = borders.filter(border => border.points.length >= 3);
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = available.length ? 'Select a saved border' : 'Create a border first';
    borderSelect.append(placeholder);
    for (const border of available) {
      const option = document.createElement('option');
      option.value = border.id; option.textContent = border.name;
      borderSelect.append(option);
    }
    container.querySelector('#garden-place-border').disabled = !available.length;
  }

  async function loadBuildingFootprints() {
    state.featureController?.abort();
    const controller = new AbortController();
    state.featureController = controller;
    const sequence = ++state.featureSequence;
    const url = new URL(WFS_URL);
    url.search = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'GetFeature',
      typeNames: 'GRB:GBG', outputFormat: 'application/json',
      srsName: 'EPSG:31370', count: '100',
      bbox: (() => {
        const footprint = activeAreaBounds();
        return `${footprint.minX - 5},${footprint.minY - 5},${footprint.maxX + 5},${footprint.maxY + 5},EPSG:31370`;
      })(),
    });
    status.textContent = 'Loading house outline…';
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`GRB returned HTTP ${response.status}.`);
      const collection = await response.json();
      if (sequence !== state.featureSequence) return;
      if (!Array.isArray(collection.features)) throw new Error('GRB returned an invalid feature collection.');
      const houseFeatures = collection.features.filter(feature =>
        featureInsideParcel(feature.geometry, imageRings()));
      state.featureMarkup = houseFeatures.map(feature => {
        const path = geometryPath(feature.geometry);
        return path ? `<path d="${path}" class="garden-building-feature"/>` : '';
      }).join('');
      draw();
      status.textContent = houseFeatures.length
        ? 'House and parcel outlines shown.'
        : 'No house outline is available for this parcel.';
    } catch (error) {
      if (error.name !== 'AbortError' && sequence === state.featureSequence) {
        status.textContent = `House outline unavailable: ${error.message}`;
      }
    }
  }

  function beginPlacement() {
    if (state.shapeDraft || state.editingKind) {
      status.textContent = 'Save or cancel the current outline edit before placing a border.';
      return;
    }
    if (!borderSelect.value) {
      status.textContent = 'Select a saved border first.';
      return;
    }
    state.mode = 'place';
    setToolsOpen(workspace, toolsToggle, false);
    svg.classList.add('placing');
    status.textContent = 'Tap to place the border. Drag the map to pan and pinch to zoom.';
  }

  function shapeStorageKey(kind) {
    return kind === 'image' ? 'imageBoundary' : 'gardenBoundary';
  }

  function shapeLabel(kind) {
    return kind === 'image' ? 'satellite image area' : 'garden perimeter';
  }

  function updateOutlineControls() {
    for (const kind of ['image', 'garden']) {
      const suffix = kind === 'image' ? 'image-area' : 'perimeter';
      const drawing = state.shapeDraft?.kind === kind;
      const editing = state.editingKind === kind;
      const points = drawing ? state.shapeDraft.points : planning[shapeStorageKey(kind)];
      const prefix = kind === 'image' ? 'garden' : 'garden';
      container.querySelector(`#${prefix}-draw-${suffix === 'image-area' ? 'image-area' : 'perimeter'}`).hidden = drawing || editing;
      container.querySelector(`#${kind === 'image' ? 'garden-edit-image-area' : 'garden-edit-perimeter'}`).hidden = drawing || editing || !planning[shapeStorageKey(kind)]?.length;
      container.querySelector(`#garden-finish-${suffix}`).hidden = !drawing;
      container.querySelector(`#garden-undo-${suffix}`).hidden = !drawing;
      container.querySelector(`#garden-remove-${kind === 'image' ? 'image' : 'perimeter'}-point`).hidden = !editing;
      container.querySelector(`#garden-remove-${kind === 'image' ? 'image' : 'perimeter'}-point`).disabled =
        !editing || state.selectedVertex < 0 || !points || points.length <= 3;
      container.querySelector(`#garden-done-edit-${kind === 'image' ? 'image-area' : 'perimeter'}`).hidden = !editing;
      container.querySelector(`#garden-cancel-${suffix}`).hidden = !drawing && !editing;
      const reset = container.querySelector(`#garden-${kind === 'image' ? 'reset-image-area' : 'clear-perimeter'}`);
      reset.hidden = drawing || editing || !planning[shapeStorageKey(kind)]?.length;
      container.querySelector(`#garden-finish-${suffix}`).disabled = (points?.length ?? 0) < 3;
      container.querySelector(`#garden-undo-${suffix}`).disabled = !points?.length;
      const text = kind === 'image'
        ? planning.imageBoundary?.length ? 'Custom image area saved. Satellite imagery is clipped to it with a 5 m buffer.' : 'No image area drawn yet; the official parcel is shown until you draw one.'
        : planning.gardenBoundary?.length ? 'Garden perimeter saved. Clean Lines uses your drawn edge.' : 'No garden perimeter yet. Draw around your fences or hedges to add your real garden edge.';
      const hint = kind === 'image' ? imageAreaStatus : perimeterStatus;
      hint.textContent = drawing
        ? `${points.length} points. Add at least 3, then save the ${shapeLabel(kind)}.`
        : editing ? 'Drag a point to move it. Click an edge to add a point; select a point to remove it.'
          : text;
    }
  }

  function startDrawing(kind) {
    if (state.shapeDraft || state.editingKind) cancelOutline();
    setViewMode('satellite');
    state.mode = 'boundary';
    state.editingKind = null;
    state.selectedVertex = -1;
    state.shapeDraft = { kind, points: [] };
    setToolsOpen(workspace, toolsToggle, false);
    svg.classList.add('placing');
    status.textContent = `Tap to add points. Drag the map to pan and pinch to zoom while drawing your ${shapeLabel(kind)}.`;
    updateOutlineControls();
    draw();
  }

  function startEditing(kind) {
    if (state.shapeDraft) cancelOutline();
    if (state.editingKind && state.editingKind !== kind) finishEditing();
    const points = planning[shapeStorageKey(kind)];
    if (!points?.length) {
      status.textContent = `Draw and save a ${shapeLabel(kind)} first.`;
      return;
    }
    state.mode = 'edit-outline';
    setToolsOpen(workspace, toolsToggle, false);
    state.editingKind = kind;
    state.editSnapshot = points.map(point => ({ ...point }));
    state.selectedVertex = -1;
    setViewMode('satellite');
    svg.classList.remove('placing');
    status.textContent = 'Drag a point to reshape the outline. Tap an edge to add a point; drag the map to pan and pinch to zoom.';
    updateOutlineControls();
    draw();
  }

  function setViewMode(mode) {
    if (mode === 'lines' && state.shapeDraft) {
      status.textContent = 'Save or cancel the outline before switching to Clean Lines.';
      return;
    }
    if (mode === 'lines' && state.editingKind) finishEditing();
    planning.viewMode = mode;
    container.querySelectorAll('[data-garden-view]').forEach(button => {
      const active = button.dataset.gardenView === mode;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (mode === 'lines') {
      draw();
      loadBuildingFootprints();
    } else {
      state.featureController?.abort();
      state.featureMarkup = '';
      state.featureSequence++;
      status.textContent = '';
      draw();
    }
    onChange();
  }

  function cancelOutline() {
    if (state.editingKind && state.editSnapshot) {
      planning[shapeStorageKey(state.editingKind)] = state.editSnapshot.map(point => ({ ...point }));
      onChange();
    }
    state.shapeDraft = null;
    state.editingKind = null;
    state.editSnapshot = null;
    state.selectedVertex = -1;
    state.mode = 'pan';
    svg.classList.remove('placing');
    status.textContent = 'Outline editing canceled. Saved outlines are unchanged.';
    updateOutlineControls();
    draw();
  }

  function finishEditing() {
    if (!state.editingKind) return;
    state.editingKind = null;
    state.editSnapshot = null;
    state.selectedVertex = -1;
    state.mode = 'pan';
    updateOutlineControls();
    draw();
    status.textContent = 'Outline edits saved.';
  }

  function finishOutline(kind) {
    if (state.shapeDraft?.kind !== kind || state.shapeDraft.points.length < 3) return;
    planning[shapeStorageKey(kind)] = state.shapeDraft.points.map(point => ({ ...point }));
    state.shapeDraft = null;
    state.editingKind = null;
    state.editSnapshot = null;
    state.selectedVertex = -1;
    state.mode = 'pan';
    svg.classList.remove('placing');
    updateOutlineControls();
    status.textContent = `${kind === 'image' ? 'Satellite image area' : 'Garden perimeter'} saved.`;
    if (kind === 'image') {
      fitGarden();
      if (planning.viewMode === 'lines') loadBuildingFootprints();
    } else draw();
    onChange();
  }

  function insertOutlinePoint(kind, point) {
    const points = planning[shapeStorageKey(kind)];
    if (!points || points.length < 3) return;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      const x = a.x + t * dx, y = a.y + t * dy;
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index + 1;
      }
    }
    points.splice(bestIndex, 0, point);
    state.selectedVertex = bestIndex;
    updateOutlineControls();
    draw();
    onChange();
  }

  function removeSelectedOutlinePoint(kind) {
    const points = planning[shapeStorageKey(kind)];
    if (!points || points.length <= 3 || state.selectedVertex < 0) return;
    points.splice(state.selectedVertex, 1);
    state.selectedVertex = -1;
    updateOutlineControls();
    draw();
    onChange();
  }

  function finishPlacement(event) {
    const point = mapPoint(event);
    const border = borders.find(item => item.id === borderSelect.value);
    if (!border) return;
    const id = uid();
    planning.placements.push({ id, borderId: border.id, x: point.x, y: point.y, rotation: 0 });
    state.selectedPlacement = id;
    renderPlacementControls();
    state.mode = 'pan'; svg.classList.remove('placing');
    status.textContent = `${border.name} placed at its measured size. Drag it to adjust its position.`;
    draw(); onChange();
  }

  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    svg.setPointerCapture(event.pointerId);
    state.activePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (state.activePointers.size > 1) {
      beginPinch();
      return;
    }
    const point = pointAt(event);
    if (state.mode === 'place' || state.mode === 'boundary') {
      state.gesture = {
        type: 'add', mode: state.mode, kind: state.shapeDraft?.kind,
        pointerId: event.pointerId, start: point, clientX: event.clientX, clientY: event.clientY,
      };
      return;
    }
    if (state.mode === 'edit-outline') {
      const handle = event.target.closest?.('[data-outline-vertex]');
      if (handle) {
        const [kind, index] = handle.dataset.outlineVertex.split(':');
        state.editingKind = kind;
        state.selectedVertex = Number(index);
        state.gesture = {
          type: 'move-outline-point', pointerId: event.pointerId, kind, index: Number(index), startX: point.x, startY: point.y,
          point: { ...planning[shapeStorageKey(kind)][Number(index)] },
        };
        updateOutlineControls();
        draw();
      } else {
        state.gesture = {
          type: 'add-outline-point', pointerId: event.pointerId, kind: state.editingKind,
          clientX: event.clientX, clientY: event.clientY,
        };
      }
      return;
    }
    const target = event.target.closest?.('[data-placement]');
    if (target) {
      const id = target.dataset.placement;
      const placement = planning.placements.find(item => item.id === id);
      if (placement) {
        state.selectedPlacement = id;
        state.gesture = { type: 'move-border', pointerId: event.pointerId, id, start: point, x: placement.x, y: placement.y };
        renderPlacementControls();
      }
    } else {
      state.gesture = { type: 'pan', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
    }
    draw();
  });

  svg.addEventListener('pointermove', event => {
    const activePointer = state.activePointers.get(event.pointerId);
    if (activePointer) {
      activePointer.clientX = event.clientX;
      activePointer.clientY = event.clientY;
    }
    let gesture = state.gesture;
    if (!gesture || !svg.hasPointerCapture(event.pointerId)) return;
    if (gesture.type === 'pinch') {
      updatePinch();
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    if (gesture.type === 'add' || gesture.type === 'add-outline-point') {
      if (Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 8) return;
      gesture = {
        type: 'pan', pointerId: event.pointerId, clientX: gesture.clientX, clientY: gesture.clientY,
        x: view.x, y: view.y,
      };
      state.gesture = gesture;
    }
    if (gesture.type === 'move-outline-point') {
      const point = pointAt(event);
      const points = planning[shapeStorageKey(gesture.kind)];
      const vertex = points?.[gesture.index];
      if (vertex) {
        vertex.x = gesture.point.x + point.x - gesture.startX;
        vertex.y = gesture.point.y + point.y - gesture.startY;
        draw();
      }
    } else if (gesture.type === 'move-border') {
      const point = pointAt(event);
      const placement = planning.placements.find(item => item.id === gesture.id);
      if (placement) {
        placement.x = gesture.x + point.x - gesture.start.x;
        placement.y = gesture.y + point.y - gesture.start.y;
        draw();
      }
    } else if (gesture.type === 'pan') {
      const scale = view.w / svg.getBoundingClientRect().width;
      view.x = gesture.x - (event.clientX - gesture.clientX) * scale;
      view.y = gesture.y - (event.clientY - gesture.clientY) * scale;
      draw();
    }
  });

  const endGesture = event => {
    state.activePointers.delete(event.pointerId);
    const gesture = state.gesture;
    if (gesture?.type === 'pinch') {
      if (state.activePointers.size > 1) {
        updatePinch();
      } else if (state.activePointers.size) {
        const [pointerId, point] = state.activePointers.entries().next().value;
        state.gesture = {
          type: 'pan', pointerId, clientX: point.clientX, clientY: point.clientY,
          x: view.x, y: view.y,
        };
      } else {
        state.gesture = null;
      }
      return;
    }
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    state.gesture = null;
    if (gesture.type === 'add') {
      if (event.type === 'pointerup' && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 8) {
        if (gesture.mode === 'boundary') {
          state.shapeDraft.points.push(mapPoint(event, false));
          updateOutlineControls();
          draw();
        } else {
          finishPlacement(event);
        }
      }
    } else if (gesture.type === 'add-outline-point') {
      if (event.type === 'pointerup' && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 8) {
        insertOutlinePoint(gesture.kind, mapPoint(event, false));
      }
    } else if (gesture.type === 'move-outline-point') {
      if (event.type === 'pointerup') {
        updateOutlineControls();
        onChange();
      }
    } else if (gesture.type === 'move-border') {
      onChange();
      status.textContent = 'Border moved.';
    }
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    const point = pointAt(event);
    const rect = svg.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    view.w = Math.min(20000, Math.max(8, view.w * (event.deltaY > 0 ? 1.2 : 1 / 1.2)));
    view.h = view.w * rect.height / rect.width;
    view.x = point.x - fx * view.w;
    view.y = -point.y - fy * view.h;
    draw();
  }, { passive: false });

  container.querySelectorAll('[data-garden-view]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.gardenView === planning.viewMode));
    button.classList.toggle('on', button.dataset.gardenView === planning.viewMode);
    button.onclick = () => setViewMode(button.dataset.gardenView);
  });

  gridInput.checked = planning.showGrid;
  gridInput.onchange = () => {
    planning.showGrid = gridInput.checked;
    if (!planning.showGrid) {
      planning.snapToGrid = false;
      snapGridInput.checked = false;
    }
    draw(); onChange();
  };
  snapGridInput.checked = planning.snapToGrid ?? false;
  snapGridInput.onchange = () => {
    planning.snapToGrid = snapGridInput.checked;
    if (planning.snapToGrid) {
      planning.showGrid = true;
      gridInput.checked = true;
    }
    draw(); onChange();
  };
  officialParcelInput.checked = planning.showOfficialParcel;
  officialParcelInput.onchange = () => {
    planning.showOfficialParcel = officialParcelInput.checked;
    draw();
    onChange();
  };
  container.querySelector('#garden-fit').onclick = fitGarden;
  container.querySelector('#garden-exit').onclick = () => {
    document.querySelector('#nav [data-nav="list"]')?.click();
  };
  toolsToggle.onclick = () => setToolsOpen(workspace, toolsToggle, !workspace.classList.contains('garden-tools-open'));
  container.querySelector('#garden-zoom-in').onclick = () => zoomAt(1 / 1.4);
  container.querySelector('#garden-zoom-out').onclick = () => zoomAt(1.4);
  container.querySelector('#garden-place-border').onclick = beginPlacement;
  container.querySelector('#garden-draw-image-area').onclick = () => startDrawing('image');
  container.querySelector('#garden-draw-perimeter').onclick = () => startDrawing('garden');
  container.querySelector('#garden-edit-image-area').onclick = () =>
    state.editingKind === 'image' ? cancelOutline() : startEditing('image');
  container.querySelector('#garden-edit-perimeter').onclick = () =>
    state.editingKind === 'garden' ? cancelOutline() : startEditing('garden');
  container.querySelector('#garden-finish-image-area').onclick = () => finishOutline('image');
  container.querySelector('#garden-finish-perimeter').onclick = () => finishOutline('garden');
  container.querySelector('#garden-undo-image-area').onclick = () => {
    state.shapeDraft?.kind === 'image' && state.shapeDraft.points.pop();
    updateOutlineControls(); draw();
  };
  container.querySelector('#garden-undo-perimeter').onclick = () => {
    state.shapeDraft?.kind === 'garden' && state.shapeDraft.points.pop();
    updateOutlineControls(); draw();
  };
  container.querySelector('#garden-remove-image-point').onclick = () => removeSelectedOutlinePoint('image');
  container.querySelector('#garden-remove-perimeter-point').onclick = () => removeSelectedOutlinePoint('garden');
  container.querySelector('#garden-done-edit-image-area').onclick = finishEditing;
  container.querySelector('#garden-done-edit-perimeter').onclick = finishEditing;
  container.querySelector('#garden-cancel-image-area').onclick = cancelOutline;
  container.querySelector('#garden-cancel-perimeter').onclick = cancelOutline;
  container.querySelector('#garden-reset-image-area').onclick = () => {
    planning.imageBoundary = null;
    updateOutlineControls();
    fitGarden();
    if (planning.viewMode === 'lines') loadBuildingFootprints();
    onChange();
  };
  container.querySelector('#garden-clear-perimeter').onclick = () => {
    planning.gardenBoundary = null;
    updateOutlineControls();
    draw();
    onChange();
  };

  function zoomAt(factor) {
    const centerX = view.x + view.w / 2;
    const centerY = view.y + view.h / 2;
    const rect = svg.getBoundingClientRect();
    view.w = Math.min(20000, Math.max(8, view.w * factor));
    view.h = view.w * rect.height / rect.width;
    view.x = centerX - view.w / 2;
    view.y = centerY - view.h / 2;
    draw();
  }

  function resizeMap() {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (!state.hasFitted) {
      fitGarden();
      return;
    }
    const centerY = view.y + view.h / 2;
    view.h = view.w * rect.height / rect.width;
    view.y = centerY - view.h / 2;
    draw();
  }

  populateBorderSelect();
  renderPlacementControls();
  updateOutlineControls();
  state.resizeObserver = new ResizeObserver(resizeMap);
  state.resizeObserver.observe(svg);
  initialFrame = requestAnimationFrame(fitGarden);
  if (planning.viewMode === 'lines') loadBuildingFootprints();
  return () => {
    cancelAnimationFrame(initialFrame);
    state.resizeObserver.disconnect();
    state.featureController?.abort();
  };
}
