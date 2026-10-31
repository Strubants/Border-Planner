import { uid } from './store.js';

const ORTHO_URL = 'https://geo.api.vlaanderen.be/OFW/wmts';
const GRB_URL = 'https://geo.api.vlaanderen.be/GRB/wmts';
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
  garden.planning.layer ??= 'aerial';
  garden.planning.showBuildings ??= true;
  garden.planning.placements ??= [];
  garden.planning.referencePoints ??= [];
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

function geometryPath(geometry) {
  if (!geometry) return '';
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.flatMap(rings => rings).map(ring => {
    if (!Array.isArray(ring) || !ring.length) return '';
    return `M${ring.map(point => `${point[0]},${-point[1]}`).join('L')}Z`;
  }).join('');
}

export function mountGardenMap(container, garden, { borders, plants, onChange }) {
  const planning = gardenPlanning(garden);
  const bounds = parcelBounds(garden);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('garden-map');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Interactive garden map. Drag to move the map; use the mouse wheel to zoom.');
  const [tileLayer, buildingLayer, parcelLayer, borderLayer, pointLayer] = ['tiles', 'buildings', 'parcel', 'borders', 'points']
    .map(name => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.layer = name;
      return group;
    });
  svg.append(tileLayer, buildingLayer, parcelLayer, borderLayer, pointLayer);
  container.innerHTML = `
    <div class="garden-map-controls">
      <label class="garden-layer-label">Map layer
        <select id="garden-layer">
          <option value="aerial">Aerial photo</option>
          <option value="grb">GRB reference map</option>
        </select>
      </label>
      <label class="garden-building-toggle"><input type="checkbox" id="garden-buildings"> Building outlines</label>
      <button class="btn alt" type="button" id="garden-fit">Fit parcel</button>
      <span class="garden-zoom-controls"><button type="button" id="garden-zoom-out" aria-label="Zoom out">−</button><button type="button" id="garden-zoom-in" aria-label="Zoom in">+</button></span>
    </div>
    <div class="garden-map-wrap"><div class="garden-map-status" id="garden-map-status" role="status" aria-live="polite"></div></div>
    <div class="garden-map-legend">
      <span><i class="garden-address-key"></i>Address point</span>
      <span><i class="garden-center-key"></i>Parcel center</span>
      <span><i class="garden-parcel-key"></i>Parcel boundary</span>
      <span><i class="garden-building-key"></i>Building reference</span>
    </div>
    <p class="muted">Map references can be incomplete or out of date. The address marker is not a house footprint. Border placement is an estimate; check it against your property before relying on it.</p>
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
    <p class="garden-attribution">Map data: <a href="https://www.vlaanderen.be/datavindplaats/catalogus/wmts-grb" target="_blank" rel="noreferrer">Digitaal Vlaanderen GRB</a> and <a href="https://metadata.vlaanderen.be/srv/api/records/50134be3-f0cd-47c5-8f6e-4a0936287947" target="_blank" rel="noreferrer">orthophoto service</a>.</p>`;
  const mapWrap = container.querySelector('.garden-map-wrap');
  mapWrap.append(svg);

  const status = container.querySelector('#garden-map-status');
  tileLayer.addEventListener('error', () => {
    status.textContent = 'Some map tiles could not be loaded. Check your connection and try again.';
  }, true);
  const placementsList = container.querySelector('#garden-placements');
  const referencesList = container.querySelector('#garden-reference-list');
  const layerInput = container.querySelector('#garden-layer');
  const buildingsInput = container.querySelector('#garden-buildings');
  const borderSelect = container.querySelector('#garden-border-select');
  const refNameInput = container.querySelector('#garden-reference-name');
  const view = { x: 0, y: 0, w: 1, h: 1 };
  let initialFrame;
  const state = {
    mode: 'pan',
    selectedPlacement: null,
    gesture: null,
    features: [],
    featureMarkup: '',
    tileKey: '',
    featureController: null,
    featureTimer: null,
    featureSequence: 0,
    resizeObserver: null,
  };

  const resizeView = () => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    view.h = view.w * rect.height / rect.width;
  };

  function fitParcel() {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const width = Math.max(bounds.maxX - bounds.minX, 10);
    const height = Math.max(bounds.maxY - bounds.minY, 10);
    view.w = Math.max(width * 1.35, height * 1.35 * rect.width / rect.height);
    view.h = view.w * rect.height / rect.width;
    view.x = (bounds.minX + bounds.maxX) / 2 - view.w / 2;
    view.y = -(bounds.minY + bounds.maxY) / 2 - view.h / 2;
    draw();
    scheduleBuildings();
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
    const base = planning.layer === 'grb' ? GRB_URL : ORTHO_URL;
    const layer = planning.layer === 'grb' ? 'grb_bsk' : 'ofw';
    const images = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const left = TILE_ORIGIN_X + col * tileWorldSize;
        const top = TILE_ORIGIN_Y - row * tileWorldSize;
        const query = new URLSearchParams({
          SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile',
          LAYER: layer, STYLE: 'default', FORMAT: 'image/png',
          TILEMATRIXSET: 'BPL72VL', TILEMATRIX: matrix.id,
          TILEROW: String(row), TILECOL: String(col),
        });
        images.push(`<image href="${base}?${query}" x="${left}" y="${-top}" width="${tileWorldSize}" height="${tileWorldSize}" preserveAspectRatio="none"/>`);
      }
    }
    return {
      key: `${layer}/${matrix.id}/${minCol}/${maxCol}/${minRow}/${maxRow}`,
      markup: images.join(''),
    };
  }

  function draw() {
    resizeView();
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const stroke = Math.max(view.w * 0.002, 0.15);
    const tiles = tileImages();
    if (tiles.key !== state.tileKey) {
      tileLayer.innerHTML = tiles.markup;
      state.tileKey = tiles.key;
    }
    const polygons = garden.parcel.polygons.map(rings => rings.map(ring =>
      `M${ring.map(([x, y]) => `${x},${-y}`).join('L')}Z`).join('')).join('');
    buildingLayer.innerHTML = planning.showBuildings ? state.featureMarkup : '';
    parcelLayer.innerHTML = `<path d="${polygons}" fill="#b9d59a" fill-opacity=".12" fill-rule="evenodd" stroke="#396b2c" stroke-width="${stroke * 1.6}" vector-effect="non-scaling-stroke"/>
      <circle cx="${garden.parcel.center[0]}" cy="${-garden.parcel.center[1]}" r="${stroke * 2}" class="garden-center"/>
      <circle cx="${garden.location.x}" cy="${-garden.location.y}" r="${stroke * 2.6}" class="garden-address-point"/>`;

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
    pointLayer.innerHTML = planning.referencePoints.map(point => `<g class="garden-custom-point">
        <circle cx="${point.x}" cy="${-point.y}" r="${stroke * 2.8}"/>
        <text x="${point.x + stroke * 3.2}" y="${-point.y - stroke * 2}" font-size="${Math.max(view.w * 0.018, 0.8)}">${esc(point.name)}</text>
      </g>`).join('');
  }

  function dataPlantColor(entry) {
    return dataPlants.find(plant => plant.id === entry.plantId)?.color || '';
  }

  const dataPlants = plants;

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

  function scheduleBuildings() {
    clearTimeout(state.featureTimer);
    if (!planning.showBuildings) return;
    state.featureTimer = setTimeout(loadBuildings, 250);
  }

  async function loadBuildings() {
    state.featureController?.abort();
    const controller = new AbortController();
    state.featureController = controller;
    const sequence = ++state.featureSequence;
    const north = -view.y, south = -(view.y + view.h);
    const url = new URL(WFS_URL);
    url.search = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'GetFeature',
      typeNames: 'GRB:GBG', outputFormat: 'application/json',
      srsName: 'EPSG:31370', count: '300',
      bbox: `${view.x},${south},${view.x + view.w},${north},EPSG:31370`,
    });
    status.textContent = 'Loading building reference features…';
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`GRB returned HTTP ${response.status}.`);
      const collection = await response.json();
      if (sequence !== state.featureSequence) return;
      if (!Array.isArray(collection.features)) throw new Error('GRB returned an invalid feature collection.');
      state.features = collection.features;
      state.featureMarkup = state.features.map(feature => {
        const path = geometryPath(feature.geometry);
        return path ? `<path d="${path}" class="garden-building-feature"/>` : '';
      }).join('');
      status.textContent = state.features.length === 300
        ? 'Showing 300 building references. Zoom in for more detail.'
        : `${state.features.length} building reference feature${state.features.length === 1 ? '' : 's'} loaded.`;
      draw();
    } catch (error) {
      if (error.name !== 'AbortError' && sequence === state.featureSequence) {
        status.textContent = `Building references unavailable: ${error.message}`;
      }
    }
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
    const point = pointAt(event);
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
    if (state.mode === 'place' || state.mode === 'reference') {
      state.gesture = { type: 'add', start: point, clientX: event.clientX, clientY: event.clientY };
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
    if (!state.gesture || state.gesture.type === 'add' && state.mode !== 'place' && state.mode !== 'reference') return;
    const gesture = state.gesture;
    state.gesture = null;
    if (gesture.type === 'add') {
      if (event.type === 'pointerup' && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 8) finishPlacement(event);
    } else if (gesture.type === 'move-border') {
      onChange();
      status.textContent = 'Border moved.';
      scheduleBuildings();
    } else if (gesture.type === 'pan') {
      scheduleBuildings();
    }
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    const point = pointAt(event);
    const rect = svg.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.width;
    view.w = Math.min(20000, Math.max(8, view.w * (event.deltaY > 0 ? 1.2 : 1 / 1.2)));
    view.h = view.w * rect.height / rect.width;
    view.x = point.x - fx * view.w;
    view.y = -point.y - fy * view.w;
    draw(); scheduleBuildings();
  }, { passive: false });

  layerInput.value = planning.layer;
  layerInput.onchange = () => {
    planning.layer = layerInput.value;
    draw(); onChange();
  };
  buildingsInput.checked = planning.showBuildings;
  buildingsInput.onchange = () => {
    planning.showBuildings = buildingsInput.checked;
    if (!planning.showBuildings) {
      state.featureController?.abort();
      state.features = [];
      state.featureMarkup = '';
      state.featureSequence++;
      status.textContent = 'Building reference layer hidden.';
      draw();
    } else {
      scheduleBuildings();
    }
    onChange();
  };
  container.querySelector('#garden-fit').onclick = fitParcel;
  container.querySelector('#garden-zoom-in').onclick = () => zoomAt(1 / 1.4);
  container.querySelector('#garden-zoom-out').onclick = () => zoomAt(1.4);
  container.querySelector('#garden-place-border').onclick = beginPlacement;
  container.querySelector('#garden-add-reference').onclick = beginReference;

  function zoomAt(factor) {
    const centerX = view.x + view.w / 2;
    const centerY = view.y + view.h / 2;
    const rect = svg.getBoundingClientRect();
    view.w = Math.min(20000, Math.max(8, view.w * factor));
    view.h = view.w * rect.height / rect.width;
    view.x = centerX - view.w / 2;
    view.y = centerY - view.h / 2;
    draw(); scheduleBuildings();
  }

  populateBorderSelect();
  renderPlacementControls();
  renderReferenceList();
  state.resizeObserver = new ResizeObserver(fitParcel);
  state.resizeObserver.observe(svg);
  initialFrame = requestAnimationFrame(fitParcel);
  return () => {
    cancelAnimationFrame(initialFrame);
    state.resizeObserver.disconnect();
    state.featureController?.abort();
    clearTimeout(state.featureTimer);
  };
}
