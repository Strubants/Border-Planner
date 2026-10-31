import { uid } from './store.js';

const ORTHO_URL = 'https://geo.api.vlaanderen.be/OFW/wmts';
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
  garden.planning.mapMargin ??= 5;
  garden.planning.placements ??= [];
  garden.planning.referencePoints ??= [];
  garden.planning.gardenBoundary ??= null;
  return garden.planning;
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

export function mountGardenMap(container, garden, { borders, plants, onChange }) {
  const planning = gardenPlanning(garden);
  const bounds = parcelBounds(garden);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('garden-map');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Interactive garden map. Drag to move the map; use the mouse wheel to zoom.');
  const [tileLayer, parcelLayer, borderLayer, pointLayer] = ['tiles', 'parcel', 'borders', 'points']
    .map(name => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.layer = name;
      return group;
    });
  svg.append(tileLayer, parcelLayer, borderLayer, pointLayer);
  container.innerHTML = `
    <div class="garden-map-controls">
      <label class="garden-margin-label">Minimum margin
        <select id="garden-map-margin">
          <option value="5">5 m</option>
          <option value="10">10 m</option>
          <option value="20">20 m</option>
        </select>
      </label>
      <button class="btn alt" type="button" id="garden-fit">Fit parcel</button>
      <label class="garden-map-toggle"><input type="checkbox" id="garden-grid"><span id="garden-grid-label">Distance grid</span></label>
      <label class="garden-map-toggle"><input type="checkbox" id="garden-snap-grid"> Snap to grid</label>
      <span class="garden-zoom-controls"><button type="button" id="garden-zoom-out" aria-label="Zoom out">−</button><button type="button" id="garden-zoom-in" aria-label="Zoom in">+</button></span>
    </div>
    <div class="garden-map-wrap"><div class="garden-map-status" id="garden-map-status" role="status" aria-live="polite"></div></div>
    <div class="garden-map-legend">
      <span><i class="garden-parcel-key"></i>Your parcel</span>
      <span><i class="garden-boundary-key"></i>Your garden outline</span>
      <span><i class="garden-border-key"></i>Placed borders</span>
    </div>
    <p class="muted">Aerial imagery is for visual reference; the parcel line is administrative data and may not match your actual garden boundary.</p>
    <div class="garden-boundary-tools">
      <h3>Garden outline</h3>
      <p class="muted">The parcel can include more than your garden. Draw your actual usable garden boundary to make this overview your own.</p>
      <div class="row">
        <button class="btn alt" type="button" id="garden-draw-boundary">Draw / redraw outline</button>
        <button class="btn" type="button" id="garden-finish-boundary" hidden>Finish outline</button>
        <button class="btn alt" type="button" id="garden-undo-boundary" hidden>Undo point</button>
        <button class="btn alt" type="button" id="garden-cancel-boundary" hidden>Cancel</button>
        <button class="btn alt" type="button" id="garden-remove-boundary" hidden>Remove outline</button>
      </div>
      <p id="garden-boundary-status" class="muted"></p>
    </div>
    <div class="garden-border-tools">
      <h3>Place borders</h3>
      <p class="muted">Choose a saved border, then tap the map to place it. Drag a placed border to move it. Scale 1× preserves its measured dimensions.</p>
      <div class="row">
        <select id="garden-border-select" aria-label="Border to place"></select>
        <button class="btn" type="button" id="garden-place-border">Place border</button>
      </div>
      <div id="garden-placements"></div>
    </div>
    <div class="garden-reference-tools">
      <h3>My reference points</h3>
      <p class="muted">Add a point for a patio corner, tree, gate, or another feature. Tap the map to mark its approximate location.</p>
      <div class="row">
        <input type="text" id="garden-reference-name" maxlength="60" placeholder="e.g. Patio corner" aria-label="Reference point name">
        <button class="btn alt" type="button" id="garden-add-reference">Add point</button>
      </div>
      <div id="garden-reference-list"></div>
    </div>
    <p class="garden-attribution">Aerial imagery: <a href="https://metadata.vlaanderen.be/srv/api/records/50134be3-f0cd-47c5-8f6e-4a0936287947" target="_blank" rel="noreferrer">Digitaal Vlaanderen orthophoto service</a>.</p>`;
  const mapWrap = container.querySelector('.garden-map-wrap');
  mapWrap.append(svg);

  const status = container.querySelector('#garden-map-status');
  tileLayer.addEventListener('error', () => {
    status.textContent = 'Aerial imagery could not be loaded. Check your connection and try again.';
  }, true);
  const placementsList = container.querySelector('#garden-placements');
  const referencesList = container.querySelector('#garden-reference-list');
  const marginInput = container.querySelector('#garden-map-margin');
  const gridInput = container.querySelector('#garden-grid');
  const snapGridInput = container.querySelector('#garden-snap-grid');
  const boundaryStatus = container.querySelector('#garden-boundary-status');
  const borderSelect = container.querySelector('#garden-border-select');
  const refNameInput = container.querySelector('#garden-reference-name');
  const view = { x: 0, y: 0, w: 1, h: 1 };
  let initialFrame;
  const state = {
    mode: 'pan',
    selectedPlacement: null,
    gesture: null,
    boundaryDraft: null,
    tileKey: '',
    resizeObserver: null,
    hasFitted: false,
  };

  const resizeView = () => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    view.h = view.w * rect.height / rect.width;
  };

  function fitParcel() {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const margin = Number(marginInput.value);
    const width = Math.max(bounds.maxX - bounds.minX + margin * 2, 10);
    const height = Math.max(bounds.maxY - bounds.minY + margin * 2, 10);
    view.w = Math.max(width, height * rect.width / rect.height);
    view.h = view.w * rect.height / rect.width;
    view.x = (bounds.minX + bounds.maxX) / 2 - view.w / 2;
    view.y = -(bounds.minY + bounds.maxY) / 2 - view.h / 2;
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
    container.querySelector('#garden-grid-label').textContent = `Distance grid (${gridStep()} m)`;
    const tiles = tileImages();
    if (tiles.key !== state.tileKey) {
      tileLayer.innerHTML = tiles.markup;
      state.tileKey = tiles.key;
    }
    const polygons = garden.parcel.polygons.map(rings => rings.map(ring =>
      `M${ring.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join('')).join('');
    const gridPath = planning.showGrid ? gridMarkup(stroke) : '';
    parcelLayer.innerHTML = `<path d="${polygons}" class="garden-parcel-casing" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>
      <path d="${polygons}" class="garden-parcel-outline" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>
      ${gridPath}
      ${gardenBoundaryMarkup(stroke)}`;

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
      markup += `<g data-placement="${esc(placement.id)}" transform="translate(${placement.x},${-placement.y}) rotate(${placement.rotation || 0}) scale(${placement.scale / 100}) translate(${-centerX},${-centerY})" class="garden-placed-border${selected ? ' selected' : ''}">
        ${zones}<path d="${outline}" fill="${selected ? '#e5a944' : '#f2d57c'}" fill-opacity=".35" stroke="${selected ? '#b54b19' : '#8a6122'}" stroke-width="3" vector-effect="non-scaling-stroke"/>
      </g>
      <text x="${placement.x}" y="${-placement.y - stroke * 3}" class="garden-border-label" font-size="${Math.max(view.w * 0.018, 0.8)}">${esc(border.name)}</text>`;
    }

    borderLayer.innerHTML = markup;
    pointLayer.innerHTML = planning.referencePoints.map(point => `<g class="garden-custom-point" data-reference="${esc(point.id)}">
        <circle cx="${point.x}" cy="${-point.y}" r="${stroke * 2.8}"/>
        <text x="${point.x + stroke * 3.2}" y="${-point.y - stroke * 2}" font-size="${Math.max(view.w * 0.018, 0.8)}">${esc(point.name)}</text>
      </g>`).join('');
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

  function gardenBoundaryMarkup(stroke) {
    const boundary = state.boundaryDraft ?? planning.gardenBoundary;
    if (!boundary?.length) return '';
    const closed = state.boundaryDraft === null && boundary.length >= 3;
    const points = boundary.map(point => `${point.x},${-point.y}`).join(' ');
    const shape = closed
      ? `<polygon points="${points}" class="garden-boundary" stroke-width="${stroke * 2}" vector-effect="non-scaling-stroke"/>`
      : `<polyline points="${points}" class="garden-boundary-draft" stroke-width="${stroke * 2}" vector-effect="non-scaling-stroke"/>`;
    const handles = state.boundaryDraft
      ? boundary.map(point => `<circle cx="${point.x}" cy="${-point.y}" r="${stroke * 2.2}" class="garden-boundary-handle"/>`).join('')
      : '';
    return shape + handles;
  }

  function dataPlantColor(entry) {
    return dataPlants.find(plant => plant.id === entry.plantId)?.color || '';
  }

  const dataPlants = plants;

  function mapPoint(event) {
    const point = pointAt(event);
    if (!planning.snapToGrid) return point;
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
      const scaleLabel = document.createElement('label');
      scaleLabel.textContent = `Scale ${placement.scale.toFixed(2)}×`;
      const scale = document.createElement('input');
      scale.type = 'range'; scale.min = '0.25'; scale.max = '4'; scale.step = '0.05'; scale.value = String(placement.scale);
      scale.setAttribute('aria-label', `${border.name} scale`);
      scale.oninput = () => {
        placement.scale = Number(scale.value);
        scaleLabel.textContent = `Scale ${placement.scale.toFixed(2)}×`;
        draw(); onChange();
      };
      const rotationLabel = document.createElement('label');
      rotationLabel.textContent = 'Rotation';
      const rotation = document.createElement('input');
      rotation.type = 'number'; rotation.min = '-180'; rotation.max = '180'; rotation.step = '5'; rotation.value = String(placement.rotation || 0);
      rotation.setAttribute('aria-label', `${border.name} rotation in degrees`);
      rotation.oninput = () => {
        const value = Number(rotation.value);
        if (!Number.isFinite(value)) return;
        placement.rotation = Math.max(-180, Math.min(180, value));
        draw(); onChange();
      };
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn alt'; remove.textContent = 'Remove';
      remove.onclick = () => {
        planning.placements = planning.placements.filter(item => item.id !== placement.id);
        if (state.selectedPlacement === placement.id) state.selectedPlacement = null;
        renderPlacementControls(); draw(); onChange();
      };
      row.append(name, scaleLabel, scale, rotationLabel, rotation, remove);
      placementsList.append(row);
    }
    if (!planning.placements.length) {
      const hint = document.createElement('p');
      hint.className = 'muted'; hint.textContent = 'No borders placed on this map yet.';
      placementsList.append(hint);
    }
  }

  function renderReferenceList() {
    referencesList.replaceChildren();
    for (const point of planning.referencePoints) {
      const row = document.createElement('div');
      row.className = 'garden-reference-row';
      const name = document.createElement('span');
      name.textContent = point.name;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn alt'; remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove reference point ${point.name}`);
      remove.onclick = () => {
        planning.referencePoints = planning.referencePoints.filter(item => item.id !== point.id);
        renderReferenceList(); draw(); onChange();
      };
      row.append(name, remove);
      referencesList.append(row);
    }
    if (!planning.referencePoints.length) {
      const hint = document.createElement('p');
      hint.className = 'muted'; hint.textContent = 'No custom reference points yet.';
      referencesList.append(hint);
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

  function beginPlacement() {
    if (!borderSelect.value) {
      status.textContent = 'Select a saved border first.';
      return;
    }
    state.mode = 'place';
    svg.classList.add('placing');
    status.textContent = 'Tap the map where this border should go.';
  }

  function beginBoundary() {
    state.mode = 'boundary';
    state.boundaryDraft = [];
    svg.classList.add('placing');
    updateBoundaryControls();
    status.textContent = 'Tap around the edge of your garden to draw a new outline.';
    draw();
  }

  function updateBoundaryControls() {
    const drawing = state.boundaryDraft !== null;
    container.querySelector('#garden-draw-boundary').hidden = drawing;
    container.querySelector('#garden-finish-boundary').hidden = !drawing;
    container.querySelector('#garden-undo-boundary').hidden = !drawing;
    container.querySelector('#garden-cancel-boundary').hidden = !drawing;
    container.querySelector('#garden-remove-boundary').hidden = drawing || !planning.gardenBoundary?.length;
    container.querySelector('#garden-finish-boundary').disabled = (state.boundaryDraft?.length ?? 0) < 3;
    container.querySelector('#garden-undo-boundary').disabled = !state.boundaryDraft?.length;
    boundaryStatus.textContent = planning.gardenBoundary?.length
      ? 'Custom garden outline saved. You can redraw it at any time.'
      : 'No custom garden outline yet; the parcel outline is shown as a reference.';
    if (drawing) boundaryStatus.textContent = `${state.boundaryDraft.length} points added. At least 3 are needed to finish.`;
  }

  function finishBoundary() {
    if (!state.boundaryDraft || state.boundaryDraft.length < 3) return;
    planning.gardenBoundary = state.boundaryDraft.map(point => ({ ...point }));
    state.boundaryDraft = null;
    state.mode = 'pan';
    svg.classList.remove('placing');
    updateBoundaryControls();
    status.textContent = 'Garden outline saved.';
    draw(); onChange();
  }

  function beginReference() {
    const name = refNameInput.value.trim();
    if (!name) {
      refNameInput.focus();
      status.textContent = 'Enter a name for your reference point first.';
      return;
    }
    state.mode = 'reference';
    svg.classList.add('placing');
    status.textContent = 'Tap the map to add this reference point.';
  }

  function finishPlacement(event) {
    const point = mapPoint(event);
    if (state.mode === 'place') {
      const border = borders.find(item => item.id === borderSelect.value);
      if (!border) return;
      const id = uid();
      planning.placements.push({ id, borderId: border.id, x: point.x, y: point.y, scale: 1, rotation: 0 });
      state.selectedPlacement = id;
      renderPlacementControls();
      state.mode = 'pan'; svg.classList.remove('placing');
      status.textContent = `${border.name} placed. Drag it to adjust its position.`;
      draw(); onChange();
    } else if (state.mode === 'reference') {
      planning.referencePoints.push({
        id: uid(),
        name: refNameInput.value.trim(),
        x: point.x,
        y: point.y,
      });
      refNameInput.value = '';
      renderReferenceList();
      state.mode = 'pan'; svg.classList.remove('placing');
      status.textContent = 'Reference point added.';
      draw(); onChange();
    }
  }

  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    svg.setPointerCapture(event.pointerId);
    const point = pointAt(event);
    if (state.mode === 'place' || state.mode === 'reference' || state.mode === 'boundary') {
      state.gesture = { type: 'add', mode: state.mode, start: point, clientX: event.clientX, clientY: event.clientY };
      return;
    }
    const target = event.target.closest?.('[data-placement]');
    if (target) {
      const id = target.dataset.placement;
      const placement = planning.placements.find(item => item.id === id);
      if (placement) {
        state.selectedPlacement = id;
        state.gesture = { type: 'move-border', id, start: point, x: placement.x, y: placement.y };
        renderPlacementControls();
      }
    } else {
      state.gesture = { type: 'pan', clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
    }
    draw();
  });

  svg.addEventListener('pointermove', event => {
    const gesture = state.gesture;
    if (!gesture || !svg.hasPointerCapture(event.pointerId)) return;
    if (gesture.type === 'add') return;
    if (gesture.type === 'move-border') {
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
    if (!state.gesture || state.gesture.type === 'add' &&
      !['place', 'reference', 'boundary'].includes(state.gesture.mode)) return;
    const gesture = state.gesture;
    state.gesture = null;
    if (gesture.type === 'add') {
      if (event.type === 'pointerup' && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 8) {
        if (gesture.mode === 'boundary') {
          state.boundaryDraft.push(mapPoint(event));
          updateBoundaryControls(); draw();
        } else {
          finishPlacement(event);
        }
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

  marginInput.value = String([5, 10, 20].includes(planning.mapMargin) ? planning.mapMargin : 5);
  marginInput.onchange = () => {
    planning.mapMargin = Number(marginInput.value);
    fitParcel();
    onChange();
  };
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
  container.querySelector('#garden-fit').onclick = fitParcel;
  container.querySelector('#garden-zoom-in').onclick = () => zoomAt(1 / 1.4);
  container.querySelector('#garden-zoom-out').onclick = () => zoomAt(1.4);
  container.querySelector('#garden-place-border').onclick = beginPlacement;
  container.querySelector('#garden-add-reference').onclick = beginReference;
  container.querySelector('#garden-draw-boundary').onclick = beginBoundary;
  container.querySelector('#garden-finish-boundary').onclick = finishBoundary;
  container.querySelector('#garden-undo-boundary').onclick = () => {
    state.boundaryDraft?.pop(); updateBoundaryControls(); draw();
  };
  container.querySelector('#garden-cancel-boundary').onclick = () => {
    state.boundaryDraft = null; state.mode = 'pan'; svg.classList.remove('placing'); updateBoundaryControls(); draw();
  };
  container.querySelector('#garden-remove-boundary').onclick = () => {
    planning.gardenBoundary = null;
    updateBoundaryControls(); draw(); onChange();
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
      fitParcel();
      return;
    }
    const centerY = view.y + view.h / 2;
    view.h = view.w * rect.height / rect.width;
    view.y = centerY - view.h / 2;
    draw();
  }

  populateBorderSelect();
  renderPlacementControls();
  renderReferenceList();
  updateBoundaryControls();
  state.resizeObserver = new ResizeObserver(resizeMap);
  state.resizeObserver.observe(svg);
  initialFrame = requestAnimationFrame(fitParcel);
  return () => {
    cancelAnimationFrame(initialFrame);
    state.resizeObserver.disconnect();
  };
}
