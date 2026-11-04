import { dist, polygonArea, centroid, pointInPolygon, bbox, setEdgeLength, closestOnPolygon, distToPolygon, polygonsOverlap, insideOrOn } from './geometry.js';
import { loadData, saveData, uid } from './store.js';
import { mountGardenMap, orthoTiles } from './garden-map.js';
import * as cloud from './cloud-sync.js';
import { open3D } from './view3d.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const $ = id => document.getElementById(id);
const main = $('main'), dlg = $('dlg');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const m2 = cm => (cm / 100).toFixed(2);

let data;
let saveTimer;
let gardenMapCleanup;
let gardenRequestCleanup;
let cloudUser = null;
let cloudRevision = null;
let cloudStatus = 'Not connected';
let cloudChoice = null;
let cloudConflict = false;
let cloudSaveTimer;
let cloudSaveInProgress = false;
let cloudSaveQueued = false;

function updateCloudStatus(message) {
  cloudStatus = message;
  const status = $('cloud-sync-status');
  if (status) status.textContent = message;
}

function queueCloudSave() {
  if (!cloudUser || cloudConflict || cloud.getLinkedAccount()?.userId !== cloudUser.id) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(syncLocalData, 900);
}

async function syncLocalData() {
  if (!cloudUser || cloudConflict || cloud.getLinkedAccount()?.userId !== cloudUser.id) return;
  if (cloudSaveInProgress) {
    cloudSaveQueued = true;
    return;
  }
  cloudSaveInProgress = true;
  try {
    const token = await cloud.getAccessToken();
    const snapshot = JSON.parse(JSON.stringify(data));
    const saved = await cloud.saveUserData(snapshot, cloudRevision, token);
    if (!saved) {
      cloudConflict = true;
      cloudChoice = { remote: await cloud.getUserData(cloudUser.id, token), linked: true };
      updateCloudStatus('Another device has newer cloud data. Choose which copy to keep below.');
      return;
    }
    cloudRevision = saved.revision;
    cloud.linkAccount(cloudUser.id, cloudRevision);
    cloud.clearAccountDirty(cloudUser.id);
    updateCloudStatus(`Synced just now · revision ${cloudRevision}`);
  } catch (error) {
    updateCloudStatus(`Saved on this device. Cloud sync failed: ${error.message}`);
  } finally {
    cloudSaveInProgress = false;
    if (cloudSaveQueued) {
      cloudSaveQueued = false;
      queueCloudSave();
    }
  }
}

let savePending = false;
let currentNav = null;

function save() {
  clearTimeout(saveTimer);
  savePending = true;
  if (cloudUser && cloud.getLinkedAccount()?.userId === cloudUser.id) cloud.markAccountDirty(cloudUser.id);
  saveTimer = setTimeout(async () => {
    try {
      await saveData(data);
      queueCloudSave();
    } catch (error) {
      notify('Saving failed: ' + error.message);
    } finally {
      savePending = false;
    }
  }, 200);
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
  if (!Object.hasOwn(d, 'garden')) {
    d.garden = null;
    changed = true;
  }
  if (!Array.isArray(d.gardens)) {
    d.gardens = [];
    changed = true;
  }
  if (d.garden) {
    d.garden.id ??= uid();
    let activeGarden = d.gardens.find(garden => garden.id === d.garden.id);
    if (!activeGarden) {
      activeGarden = d.garden;
      d.gardens.push(activeGarden);
      changed = true;
    }
    d.activeGardenId = activeGarden.id;
    d.garden = activeGarden;
  } else if (d.activeGardenId) {
    d.garden = d.gardens.find(garden => garden.id === d.activeGardenId) || null;
  }
  if (d.version !== 3) changed = true;
  d.version = 3;
  return changed;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJSON(item) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function setHeader(title, { back, actions = [] } = {}) {
  $('title').textContent = title;
  const b = $('back');
  b.hidden = !back;
  b.onclick = back || null;
  $('gear').hidden = !!back;
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
  currentNav = active;
  if (active !== 'garden') {
    gardenRequestCleanup?.();
    gardenRequestCleanup = null;
    gardenMapCleanup?.();
    gardenMapCleanup = null;
  }
  $('nav').classList.toggle('hidden', !active);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === active));
  $('gear').classList.toggle('on', active === 'settings');
}

document.querySelectorAll('#nav button').forEach(b => {
  b.onclick = () => ({ list: showList, garden: showGarden, plants: showPlants })[b.dataset.nav]();
});
$('gear').onclick = () => showSettings();

// ---------- dialogs ----------
function openDialog(html, onMount) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  onMount?.(dlg);
}
const closeDialog = () => dlg.open && dlg.close();

// In-app replacements for confirm()/alert(), which are blocked or unreliable in some browsers.
function ask(message, okLabel = 'Delete', danger = true) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.innerHTML = `<p style="margin-top:0">${esc(message)}</p>
      <div class="dlg-btns"><button class="btn alt" data-r="0">Cancel</button><button class="btn${danger ? ' danger' : ''}" data-r="1">${esc(okLabel)}</button></div>`;
    d.onclose = () => d.remove();
    d.addEventListener('click', e => {
      const r = e.target.dataset?.r;
      if (r === undefined) return;
      resolve(r === '1');
      d.close();
    });
    d.addEventListener('cancel', () => resolve(false));
    document.body.append(d);
    d.showModal();
  });
}

function notify(message) {
  const d = document.createElement('dialog');
  d.innerHTML = `<p style="margin-top:0">${esc(message)}</p><div class="dlg-btns"><button class="btn">OK</button></div>`;
  d.onclose = () => d.remove();
  d.querySelector('button').onclick = () => d.close();
  document.body.append(d);
  d.showModal();
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
    const plants = b.zones.reduce((n, z) => n + z.plants.reduce((s, e) => s + (e.count || 0), 0), 0);
    const card = document.createElement('div');
    card.className = 'card click';
    card.innerHTML = `<b>${esc(b.name)}</b><div class="muted">${b.points.length ? m2(polygonArea(b.points) / 100) + ' m² · ' : ''}${b.zones.length} zones${plants ? ` · ${plants} planted` : ''}</div>`;
    card.onclick = () => openEditor(b.id);
    items.append(card);
  }
}

// ---------- garden parcel lookup ----------
function showGarden() {
  gardenRequestCleanup?.();
  gardenRequestCleanup = null;
  gardenMapCleanup?.();
  gardenMapCleanup = null;
  setNav('garden');
  setHeader('My Garden');
  main.innerHTML = `<div class="pad garden-page">
    <div class="garden-address-bar">
      <div class="garden-address-search">
        <label for="garden-address">Garden address</label>
        <div class="row garden-search">
          <input type="text" id="garden-address" autocomplete="street-address" placeholder="Street, number, postcode, municipality">
          <button class="btn" id="garden-search" type="button">Search</button>
        </div>
      </div>
      <div class="garden-address-side">
        <div id="garden-saved-addresses" class="garden-saved-addresses" hidden>
          <label for="garden-address-select">Saved gardens</label>
          <div class="row">
            <select id="garden-address-select" aria-label="Select a saved garden"></select>
            <button class="btn alt" id="garden-remove-address" type="button">Remove</button>
          </div>
        </div>
        <div id="garden-status" class="muted" role="status" aria-live="polite"></div>
      </div>
    </div>
    <div id="garden-suggestions"></div>
    <div id="garden-result" class="garden-result"></div>
  </div>`;

  const input = $('garden-address');
  const status = $('garden-status');
  const suggestions = $('garden-suggestions');
  const result = $('garden-result');
  const savedAddresses = $('garden-saved-addresses');
  const addressSelect = $('garden-address-select');
  let suggestionTimer;
  let suggestionSequence = 0;
  let suggestionController;
  let lookupSequence = 0;
  let lookupController;

  function renderSavedAddresses() {
    addressSelect.replaceChildren();
    for (const savedGarden of data.gardens) {
      const option = document.createElement('option');
      option.value = savedGarden.id;
      option.textContent = savedGarden.address;
      option.selected = savedGarden.id === data.activeGardenId;
      addressSelect.append(option);
    }
    savedAddresses.hidden = data.gardens.length < 2;
  }

  addressSelect.onchange = () => {
    const garden = data.gardens.find(item => item.id === addressSelect.value);
    if (!garden) return;
    data.garden = garden;
    data.activeGardenId = garden.id;
    input.value = garden.address;
    clearSuggestions();
    status.textContent = 'Showing the saved parcel.';
    renderSavedAddresses();
    save();
    renderGardenResult(result, garden);
  };

  $('garden-remove-address').onclick = async () => {
    const garden = data.gardens.find(item => item.id === data.activeGardenId);
    if (!garden || !await ask(`Remove ${garden.address} and its garden layout?`, 'Remove address')) return;
    data.gardens = data.gardens.filter(item => item.id !== garden.id);
    data.garden = data.gardens[0] || null;
    data.activeGardenId = data.garden?.id || null;
    input.value = data.garden?.address || '';
    status.textContent = data.garden ? 'Showing the saved parcel.' : 'Search for an address, then select an individual house-number result.';
    renderSavedAddresses();
    save();
    if (data.garden) renderGardenResult(result, data.garden);
    else result.replaceChildren();
  };

  const apiJson = async (url, controller) => {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The service returned HTTP ${response.status}.`);
    return response.json();
  };

  const clearSuggestions = () => { suggestions.replaceChildren(); };

  async function findSuggestions() {
    const query = input.value.trim();
    const sequence = ++suggestionSequence;
    suggestionController?.abort();
    clearSuggestions();
    if (query.length < 2) {
      status.textContent = query ? 'Enter at least two characters to search.' : '';
      return;
    }

    const controller = new AbortController();
    suggestionController = controller;
    status.textContent = 'Searching addresses…';
    try {
      const fetchSuggestions = async text => {
        const url = new URL('https://geo.api.vlaanderen.be/Geolocation/v4/Suggestion');
        url.search = new URLSearchParams({ q: text, c: '8' });
        const result = await apiJson(url, controller);
        return Array.isArray(result.SuggestionResult) ? result.SuggestionResult : [];
      };
      // The service returns nothing for "street nr, postcode city"; retry with simpler forms.
      const plain = query.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
      const noPostcode = plain.replace(/\b[1-9]\d{3}\b/g, '').replace(/\s+/g, ' ').trim();
      const postcode = plain.match(/\b[1-9]\d{3}\b/)?.[0];
      let addresses = [];
      for (const attempt of [...new Set([query, plain, noPostcode])]) {
        if (attempt.length < 2) continue;
        addresses = await fetchSuggestions(attempt);
        if (sequence !== suggestionSequence) return;
        if (addresses.length) break;
      }
      if (postcode) {
        const sameCode = addresses.filter(item => item.includes(postcode));
        if (sameCode.length) addresses = sameCode;
      }
      if (!addresses.length) {
        status.textContent = 'No address suggestions found. Check the spelling or try a fuller address.';
        return;
      }
      status.textContent = 'Choose the exact house-number address:';
      for (const address of addresses) {
        const button = document.createElement('button');
        button.className = 'garden-suggestion';
        button.type = 'button';
        button.textContent = address;
        button.onclick = () => loadGarden(address);
        suggestions.append(button);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && sequence === suggestionSequence) {
        status.textContent = `Address search failed: ${error.message}`;
      }
    }
  }

  function parseGeometry(value) {
    const geometry = typeof value === 'string' ? JSON.parse(value) : value;
    if (!geometry || !Array.isArray(geometry.coordinates)) throw new Error('The parcel service returned no usable outline.');
    const sourcePolygons = geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    const polygons = sourcePolygons.map(rings => rings
      .filter(ring => Array.isArray(ring))
      .map(ring => ring.map(point => {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
          throw new Error('The parcel outline contains invalid coordinates.');
        }
        return [point[0], point[1]];
      }))
      .filter(ring => ring.length >= 4))
      .filter(rings => rings.length);
    if (!polygons.length) throw new Error('The parcel service returned no drawable polygon.');
    return polygons;
  }

  async function loadGarden(address) {
    const sequence = ++lookupSequence;
    lookupController?.abort();
    const controller = new AbortController();
    lookupController = controller;
    input.value = address;
    clearSuggestions();
    status.textContent = 'Finding the address and its parcel…';
    try {
      const locationUrl = new URL('https://geo.api.vlaanderen.be/Geolocation/v4/Location');
      locationUrl.search = new URLSearchParams({ q: address, c: '1' });
      const locationResponse = await apiJson(locationUrl, controller);
      const location = locationResponse.LocationResult?.[0];
      if (!location) throw new Error('No matching address was returned.');
      if (!location.Housenumber) {
        throw new Error('Choose a suggestion for an individual house number; a street or municipality alone cannot identify one parcel.');
      }
      const x = location.Location?.X_Lambert72;
      const y = location.Location?.Y_Lambert72;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('The address result has no usable map coordinates.');

      const parcelUrl = new URL('https://geo.api.vlaanderen.be/capakey/v2/parcel');
      parcelUrl.search = new URLSearchParams({
        x: String(x),
        y: String(y),
        geometry: 'full',
        srs: '31370',
        data: 'adp',
        status: 'actual',
      });
      const parcelResponse = await apiJson(parcelUrl, controller);
      if (parcelResponse.result?.succes === false) {
        throw new Error(parcelResponse.result.errorMessage || 'The parcel service could not find a parcel at this address.');
      }
      const polygons = parseGeometry(parcelResponse.geometry?.shape);
      const parsedCenter = typeof parcelResponse.geometry.center === 'string'
        ? JSON.parse(parcelResponse.geometry.center)
        : parcelResponse.geometry.center;
      let center = parsedCenter?.type === 'Point' &&
        Number.isFinite(parsedCenter.coordinates?.[0]) && Number.isFinite(parsedCenter.coordinates?.[1])
        ? parsedCenter.coordinates : null;
      if (!center) {
        const coordinates = polygons.flat(2);
        center = [
          (Math.min(...coordinates.map(point => point[0])) + Math.max(...coordinates.map(point => point[0]))) / 2,
          (Math.min(...coordinates.map(point => point[1])) + Math.max(...coordinates.map(point => point[1]))) / 2,
        ];
      }
      const garden = {
        id: data.gardens.find(item => item.address.toLocaleLowerCase() === (location.FormattedAddress || address).toLocaleLowerCase())?.id || uid(),
        address: location.FormattedAddress || address,
        location: { x, y, type: location.LocationType || '' },
        planning: data.gardens.find(item => item.address.toLocaleLowerCase() === (location.FormattedAddress || address).toLocaleLowerCase())?.planning,
        parcel: {
          capakey: parcelResponse.capakey || '',
          municipalityName: parcelResponse.municipalityName || location.Municipality || '',
          sectionCode: parcelResponse.sectionCode || '',
          center,
          polygons,
        },
      };
      if (sequence !== lookupSequence) return;
      const savedGardenIndex = data.gardens.findIndex(item => item.id === garden.id);
      if (savedGardenIndex < 0) data.gardens.push(garden);
      else data.gardens[savedGardenIndex] = garden;
      data.garden = garden;
      data.activeGardenId = garden.id;
      save();
      status.textContent = data.gardens.length > 1
        ? 'Parcel saved. Choose any saved garden to switch locations.'
        : 'Parcel found. Check the outline against your actual garden boundary.';
      renderSavedAddresses();
      renderGardenResult(result, garden);
    } catch (error) {
      if (error.name !== 'AbortError' && sequence === lookupSequence) {
        status.textContent = `Could not load this parcel: ${error.message}`;
      }
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(suggestionTimer);
    suggestionTimer = setTimeout(findSuggestions, 350);
  });
  $('garden-search').onclick = () => {
    clearTimeout(suggestionTimer);
    findSuggestions();
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(suggestionTimer);
      findSuggestions();
    }
  });

  gardenRequestCleanup = () => {
    clearTimeout(suggestionTimer);
    suggestionController?.abort();
    lookupController?.abort();
    suggestionSequence++;
    lookupSequence++;
  };

  renderSavedAddresses();
  if (data.garden) {
    input.value = data.garden.address;
    status.textContent = 'Showing the saved parcel. Search for another address to add a garden.';
    renderGardenResult(result, data.garden);
  } else {
    status.textContent = 'Search for an address, then select an individual house-number result.';
  }
}

function renderGardenResult(container, garden) {
  gardenMapCleanup?.();
  gardenMapCleanup = null;
  const area = garden.parcel.polygons.reduce((sum, polygon) => {
    return sum + polygon.reduce((polygonArea, ring, ringIndex) => {
      let value = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        value += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      return polygonArea + (ringIndex === 0 ? 1 : -1) * Math.abs(value) / 2;
    }, 0);
  }, 0);
  const safe = esc;

  container.innerHTML = `<section class="card garden-card">
    <header class="garden-card-heading">
      <div>
        <h2>${safe(garden.address)}</h2>
        <p class="muted">${safe(garden.parcel.municipalityName)}${garden.parcel.capakey ? ` · Official parcel ${safe(garden.parcel.capakey)}` : ''}${area ? ` · ${area.toFixed(0)} m²` : ''}</p>
      </div>
    </header>
    <div class="garden-planning"></div>
  </section>`;
  gardenMapCleanup = mountGardenMap(container.querySelector('.garden-planning'), garden, {
    borders: data.borders,
    plants: data.plants,
    onChange: save,
  });
}

function newBorderDialog() {
  openDialog(`
    <h2>New border</h2>
    <label>Name</label><input type="text" id="nb-name" placeholder="e.g. Front border">
    <div class="dlg-btns"><button class="btn alt" id="nb-cancel">Cancel</button><button class="btn" id="nb-ok">Create</button></div>`,
  d => {
    d.querySelector('#nb-cancel').onclick = closeDialog;
    d.querySelector('#nb-ok').onclick = () => {
      const border = { id: uid(), name: d.querySelector('#nb-name').value.trim() || 'Border', photo: null, points: [], zones: [] };
      data.borders.push(border);
      save();
      closeDialog();
      openEditor(border.id);
    };
  });
}

// ---------- editor ----------
const ICONS = Object.fromEntries(Object.entries({
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  pointMinus: '<circle cx="9" cy="12" r="4"/><path d="M16 12h6"/>',
  ruler: '<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M6 8v4M10 8v3M14 8v4M18 8v3"/>',
  details: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  oval: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  triangle: '<path d="M12 4l9 16H3z"/>',
  rotL: '<path d="M4 12a8 8 0 108-8H8"/><path d="M11 1L8 4l3 3"/>',
  rotR: '<path d="M20 12a8 8 0 11-8-8h4"/><path d="M13 1l3 3-3 3"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  paste: '<path d="M9 4h6v3H9z"/><path d="M9 5.5H7a2 2 0 00-2 2V19a2 2 0 002 2h10a2 2 0 002-2V7.5a2 2 0 00-2-2h-2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  toolbox: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6a1 1 0 011-1h4a1 1 0 011 1v2M3 13h18M11 13v2h2v-2"/>',
}).map(([k, v]) => [k, `<svg viewBox="0 0 24 24" aria-hidden="true">${v}</svg>`]));

function rotatePoints(points, deg, pivot) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return points.map(p => ({ ...p, x: pivot.x + (p.x - pivot.x) * c - (p.y - pivot.y) * s, y: pivot.y + (p.x - pivot.x) * s + (p.y - pivot.y) * c }));
}

function shapePoints(kind, c, w, h) {
  const hw = w / 2, hh = h / 2;
  if (kind === 'rect') return [{ x: c.x - hw, y: c.y - hh }, { x: c.x + hw, y: c.y - hh }, { x: c.x + hw, y: c.y + hh }, { x: c.x - hw, y: c.y + hh }];
  if (kind === 'triangle') return [{ x: c.x, y: c.y - hh }, { x: c.x + hw, y: c.y + hh }, { x: c.x - hw, y: c.y + hh }];
  return Array.from({ length: 12 }, (_, i) => ({ x: c.x + hw * Math.cos(i / 12 * 2 * Math.PI), y: c.y + hh * Math.sin(i / 12 * 2 * Math.PI) }));
}

let zoneClipboard = null;

function openEditor(borderId) {
  const border = data.borders.find(b => b.id === borderId);
  if (!border) return showList();
  setNav(null);
  setHeader(border.name, {
    back: showList,
    actions: [{ label: '⋮', onClick: () => borderMenu(border) }],
  });
  main.innerHTML = `
    <div id="stage"><svg id="sat"></svg><svg id="svg"></svg><div id="hint"></div>
      <button type="button" id="label-toggle" aria-pressed="true">${ICONS.tag}<span>Labels</span></button>
      <button type="button" id="sat-toggle" aria-pressed="false">${ICONS.layers}<span>Satellite</span></button><div id="sat-note"></div></div>
    <div class="toolbar" id="tools"></div>`;
  const svg = $('svg'), hint = $('hint'), tools = $('tools'), satSvg = $('sat'), satToggle = $('sat-toggle'), labelToggle = $('label-toggle'), stage = $('stage');

  const st = {
    mode: border.points.length ? 'view' : 'drawBorder', // view | edit | drawBorder | drawZone
    draft: [],
    shape: null,
    shapesOpen: false,
    pendingShape: null,
    pendingPaste: false,
    showLabels: localStorage.getItem('showZoneLabels') !== '0',
    sel: { kind: 'border' },
    selVertex: -1,
    vb: { x: 0, y: 0, w: 500 },
  };

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

  // Oriented frame of a shape: resize handles on the corners of its (rotated) box plus a rotate handle above it.
  function shapeFrame(points, rot = 0) {
    const pivot = centroid(points), b = bbox(rotatePoints(points, -rot, pivot)), off = 22 * k();
    const back = (x, y) => rotatePoints([{ x, y }], rot, pivot)[0];
    const cx = (b.minX + b.maxX) / 2;
    return {
      pivot,
      box: [back(b.minX, b.minY), back(b.maxX, b.minY), back(b.maxX, b.maxY), back(b.minX, b.maxY)],
      handles: [[b.minX, b.minY, -1, -1], [b.maxX, b.minY, 1, -1], [b.maxX, b.maxY, 1, 1], [b.minX, b.maxY, -1, 1]].map(([x, y, sx, sy]) => ({
        corner: back(x, y), ...back(x + sx * off, y + sy * off),
        uc: { x, y }, ua: { x: sx < 0 ? b.maxX : b.minX, y: sy < 0 ? b.maxY : b.minY }, uoff: { x: sx * off, y: sy * off },
      })),
      rotHandle: { from: back(cx, b.minY), ...back(cx, b.minY - off * 1.8) },
    };
  }

  // ----- satellite background (Flemish aerial imagery anchored to the garden address) -----
  const gardenOf = () => data.gardens.find(x => x.id === data.activeGardenId) || data.gardens[0] || null;
  const boxCentre = () => {
    const b = bbox(border.points.length ? border.points : [{ x: 0, y: 0 }, { x: 500, y: 350 }]);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  };
  // svg (Lambert, y flipped) = (geo.x, -geo.y) + 0.01 * R(rot) * local
  const resolveGeo = () => {
    const garden = gardenOf();
    if (!garden) return null;
    const c = boxCentre();
    const pl = garden.planning?.placements?.find(p => p.borderId === border.id);
    if (pl) {
      const a = (pl.rotation || 0) * Math.PI / 180;
      return border.geo = { gardenId: garden.id, rot: pl.rotation || 0, x: pl.x - 0.01 * (c.x * Math.cos(a) - c.y * Math.sin(a)), y: pl.y + 0.01 * (c.x * Math.sin(a) + c.y * Math.cos(a)) };
    }
    if (border.geo?.gardenId === garden.id) return border.geo;
    const pc = garden.parcel?.center;
    if (!pc) return null;
    return border.geo = { gardenId: garden.id, rot: 0, x: pc[0] - 0.01 * c.x, y: pc[1] + 0.01 * c.y };
  };
  let geo = border.sat || border.geo ? resolveGeo() : null;
  let satKey = '';

  // Keeps a border that is already placed in My Garden in the same spot when its outline changes.
  function keepPlacement() {
    const garden = gardenOf();
    const pl = garden?.planning?.placements?.find(p => p.borderId === border.id);
    if (!pl || !geo || geo.gardenId !== garden.id || border.points.length < 3) return;
    const c = boxCentre(), a = geo.rot * Math.PI / 180;
    const x = geo.x + 0.01 * (c.x * Math.cos(a) - c.y * Math.sin(a)), y = geo.y - 0.01 * (c.x * Math.sin(a) + c.y * Math.cos(a));
    if (Math.abs(x - pl.x) > 1e-6 || Math.abs(y - pl.y) > 1e-6) { pl.x = x; pl.y = y; save(); }
  }

  function renderSat(viewBox, widthPx) {
    const on = !!(border.sat && geo);
    stage.classList.toggle('sat-on', on);
    satToggle.classList.toggle('on', on);
    satToggle.setAttribute('aria-pressed', String(on));
    satSvg.style.display = on ? '' : 'none';
    $('sat-note').textContent = on ? 'Imagery © Digitaal Vlaanderen' : '';
    if (!on) { satKey = ''; satSvg.innerHTML = ''; return; }
    satSvg.setAttribute('viewBox', viewBox.join(' '));
    const [vx, vy, vw, vh] = viewBox, a = geo.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const world = [[vx, vy], [vx + vw, vy], [vx + vw, vy + vh], [vx, vy + vh]].map(([x, y]) => ({ x: geo.x + 0.01 * (x * c - y * s), y: -geo.y + 0.01 * (x * s + y * c) }));
    const minX = Math.min(...world.map(p => p.x)), maxX = Math.max(...world.map(p => p.x));
    const minY = Math.min(...world.map(p => p.y)), maxY = Math.max(...world.map(p => p.y));
    const padX = (maxX - minX) * 0.25, padY = (maxY - minY) * 0.25;
    const tiles = orthoTiles({ x: minX - padX, y: minY - padY, w: maxX - minX + 2 * padX, h: maxY - minY + 2 * padY }, 0.01 * vw / Math.max(widthPx, 1));
    let g = satSvg.querySelector('g');
    if (!g) { g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); satSvg.append(g); satKey = ''; }
    g.setAttribute('transform', `scale(100) rotate(${-geo.rot}) translate(${-geo.x} ${geo.y})`);
    if (tiles.key !== satKey) {
      satKey = tiles.key;
      g.innerHTML = tiles.markup;
    }
  }

  const syncLabelToggle = () => {
    labelToggle.classList.toggle('on', st.showLabels);
    labelToggle.setAttribute('aria-pressed', String(st.showLabels));
  };
  syncLabelToggle();
  labelToggle.onclick = () => {
    st.showLabels = !st.showLabels;
    localStorage.setItem('showZoneLabels', st.showLabels ? '1' : '0');
    syncLabelToggle(); render();
  };

  satToggle.onclick = () => {
    if (!border.sat) {
      geo = resolveGeo();
      if (!geo) { notify('Search your address in the My Garden tab first. The satellite image is placed using your garden address.'); return; }
    }
    border.sat = !border.sat;
    if (!border.sat) delete border.sat;
    save(); update();
  };

  function render() {
    const r = rect(), kk = k();
    if (!r.width || !r.height) return;
    const { vb } = st;
    const vh = vb.w * r.height / r.width;
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vh}`);
    renderSat([vb.x, vb.y, vb.w, vh], r.width);
    const satOn = !!(border.sat && geo);
    const px = n => n * kk;
    const poly = pts => pts.map(p => `${p.x},${p.y}`).join(' ');
    let s = '';
    const minor = vb.w < 600 ? 10 : vb.w < 2500 ? 50 : 100;
    if (!satOn) {
      s += `<defs><pattern id="g" width="${minor}" height="${minor}" patternUnits="userSpaceOnUse"><path d="M${minor} 0H0V${minor}" fill="none" stroke="#dfe7d6" stroke-width="${px(1)}"/></pattern>
      <pattern id="g2" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="#c5d1ba" stroke-width="${px(1.2)}"/></pattern></defs>`;
      s += `<rect x="${vb.x - 1e4}" y="${vb.y - 1e4}" width="2e4" height="2e4" fill="url(#g)"/><rect x="${vb.x - 1e4}" y="${vb.y - 1e4}" width="2e4" height="2e4" fill="url(#g2)"/>`;
    }

    if (border.points.length >= 3) {
      const bsel = st.mode === 'edit' && st.sel.kind === 'border';
      s += `<polygon points="${poly(border.points)}" fill="#e3edd2" fill-opacity="${satOn ? .2 : 1}" stroke="${bsel ? '#d6730a' : satOn ? '#fff' : '#5b7a43'}" stroke-width="${px(bsel ? 3 : 2.5)}" stroke-linejoin="round"/>`;
    }
    for (const z of border.zones) {
      const col = z.plants.map(rp).find(p => p.color)?.color ?? '#9aa39a';
      const zsel = st.mode === 'edit' && st.sel.kind === 'zone' && st.sel.id === z.id;
      s += `<polygon points="${poly(z.points)}" fill="${col}" fill-opacity=".55" stroke="${zsel ? '#d6730a' : col}" stroke-width="${px(zsel ? 3 : 2)}" stroke-linejoin="round"/>`;
      const c = centroid(z.points);
      const label = z.name || z.plants.map(e => rp(e).name + (e.count ? ` ×${e.count}` : '')).join(', ');
      if (label && st.showLabels) s += `<text x="${c.x}" y="${c.y}" font-size="${px(13)}" text-anchor="middle" dominant-baseline="middle" fill="#1d2a1f" stroke="#fff" stroke-width="${px(3)}" paint-order="stroke">${esc(label)}</text>`;
    }
    // edge lengths of the border
    const bp = border.points;
    if (bp.length >= 2 && st.mode !== 'drawBorder') {
      for (let i = 0; i < bp.length; i++) {
        const a = bp[i], b = bp[(i + 1) % bp.length];
        if (bp.length === 2 && i === 1) break;
        if (dist(a, b) / kk < 40) continue;
        s += `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2}" font-size="${px(11)}" text-anchor="middle" fill="#3b4b36" stroke="#fff" stroke-width="${px(3)}" paint-order="stroke">${m2(dist(a, b))} m</text>`;
      }
    }
    // draft
    if (st.draft.length) {
      s += `<polyline points="${poly(st.draft)}" fill="none" stroke="#d6730a" stroke-width="${px(2.5)}" stroke-dasharray="${px(6)}"/>`;
      st.draft.forEach((p, i) => { s += `<circle cx="${p.x}" cy="${p.y}" r="${px(i === 0 ? 9 : 6)}" fill="${i === 0 ? '#2f6b3a' : '#d6730a'}"/>`; });
    }
    // quick shape being placed
    if (st.mode === 'placeShape' && st.shape) {
      s += `<polygon points="${poly(st.shape.points)}" fill="#d6730a" fill-opacity=".3" stroke="#d6730a" stroke-width="${px(2.5)}" stroke-dasharray="${px(6)}" stroke-linejoin="round"/>`;
    }
    const holder = st.mode === 'placeShape' ? st.shape : st.mode === 'edit' ? selZone() : null;
    if (holder) {
      const fr = shapeFrame(holder.points, holder.rot || 0);
      s += `<polygon points="${poly(fr.box)}" fill="none" stroke="#d6730a" stroke-width="${px(1)}" stroke-dasharray="${px(4)}" opacity=".7"/>`;
      for (const h of fr.handles) {
        const r = px(8);
        s += `<line x1="${h.corner.x}" y1="${h.corner.y}" x2="${h.x}" y2="${h.y}" stroke="#d6730a" stroke-width="${px(1)}" opacity=".7"/><rect x="${h.x - r}" y="${h.y - r}" width="${2 * r}" height="${2 * r}" rx="${px(2)}" fill="#fff" stroke="#d6730a" stroke-width="${px(2)}" transform="rotate(${holder.rot || 0} ${h.x} ${h.y})"/>`;
      }
      const rh = fr.rotHandle;
      s += `<line x1="${rh.from.x}" y1="${rh.from.y}" x2="${rh.x}" y2="${rh.y}" stroke="#d6730a" stroke-width="${px(1)}" opacity=".7"/><circle cx="${rh.x}" cy="${rh.y}" r="${px(10)}" fill="#fff" stroke="#d6730a" stroke-width="${px(2)}"/><path d="M${rh.x - px(4)} ${rh.y + px(1)}a${px(4)} ${px(4)} 0 1 1 ${px(2)} ${px(3)}" fill="none" stroke="#d6730a" stroke-width="${px(1.6)}" stroke-linecap="round"/>`;
    }
    // handles
    if (st.mode === 'edit') {
      const pts = selPts();
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        s += `<circle cx="${(p.x + q.x) / 2}" cy="${(p.y + q.y) / 2}" r="${px(6)}" fill="#fff" stroke="#d6730a" stroke-width="${px(1.5)}" opacity=".85"/>`;
      });
      pts.forEach((p, i) => {
        const sel = i === st.selVertex;
        if (p.fixed) {
          const r = px(sel ? 10 : 8);
          s += `<rect x="${p.x - r}" y="${p.y - r}" width="${2 * r}" height="${2 * r}" fill="${sel ? '#b3382c' : '#2f6b3a'}" stroke="#fff" stroke-width="${px(2)}"/>`;
        } else {
          s += `<circle cx="${p.x}" cy="${p.y}" r="${px(sel ? 11 : 9)}" fill="${sel ? '#b3382c' : '#d6730a'}" stroke="#fff" stroke-width="${px(2)}"/>`;
        }
      });
    }
    svg.innerHTML = s;
  }

  function renderTools() {
    const btn = (icon, label, { on, fn, disabled, kind, text } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = ICONS[icon] + (text ? `<span>${label}</span>` : '');
      b.title = label;
      b.setAttribute('aria-label', label);
      b.classList.toggle('on', !!on);
      if (kind) b.classList.add(kind);
      if (text) b.classList.add('with-text');
      b.disabled = !!disabled;
      b.onclick = fn;
      return b;
    };
    tools.innerHTML = '';
    const hasBorder = border.points.length >= 3;
    const drawing = st.mode === 'drawBorder' || st.mode === 'drawZone';
    const goMode = m => () => { st.mode = m; st.draft = []; st.shape = null; st.pendingShape = null; st.pendingPaste = false; st.selVertex = -1; st.shapesOpen = false; update(); };

    // each group: [label, buttons]
    const groups = [];
    if (st.mode === 'placeShape') {
      const cancel = goMode(st.shape.target === 'border' ? 'drawBorder' : 'drawZone');
      groups.push(
        ['Place shape', [btn('check', 'Place', { fn: confirmShape, kind: 'primary', text: true }), btn('x', 'Cancel', { fn: cancel })]],
        ['Size', [btn('ruler', 'Set distances', { fn: sizeDialog })]],
        ['Rotate', [btn('rotL', 'Rotate 15° left', { fn: () => rotateBy(-15) }), btn('rotR', 'Rotate 15° right', { fn: () => rotateBy(15) })]],
      );
    } else if (drawing) {
      const first = !st.draft.length;
      if (first) {
        const shapes = [btn('toolbox', 'Ready-made shapes', { on: st.shapesOpen, fn: () => { st.shapesOpen = !st.shapesOpen; renderTools(); } })];
        if (st.shapesOpen) shapes.push(
          btn('rect', 'Rectangle', { on: st.pendingShape === 'rect', fn: () => startShape('rect') }),
          btn('oval', 'Oval', { on: st.pendingShape === 'oval', fn: () => startShape('oval') }),
          btn('triangle', 'Triangle', { on: st.pendingShape === 'triangle', fn: () => startShape('triangle') }),
        );
        if (st.mode === 'drawZone' && zoneClipboard) shapes.push(btn('paste', 'Paste copied zone', { on: st.pendingPaste, fn: startPaste }));
        groups.push(['Toolbox', shapes]);
      }
      groups.push([st.mode === 'drawZone' ? 'New zone' : 'Border outline', [
        btn('check', 'Finish', { fn: finishDraft, disabled: st.draft.length < 3, kind: 'primary', text: true }),
        btn('undo', 'Undo last point', { fn: () => { st.draft.pop(); update(); }, disabled: !st.draft.length }),
        ...(st.mode === 'drawZone' ? [btn('x', 'Cancel', { fn: goMode('view') })] : []),
      ]]);
    } else if (st.mode === 'edit') {
      const isZone = st.sel.kind === 'zone';
      const noDelete = st.selVertex < 0 || selPts().length <= 3 || !!selPts()[st.selVertex]?.fixed;
      const pointBtns = [btn('pointMinus', 'Delete point', { fn: deleteVertex, disabled: noDelete })];
      if (!isZone) {
        const fixed = !!border.points[st.selVertex]?.fixed;
        pointBtns.push(btn(fixed ? 'unlock' : 'lock', fixed ? 'Unlock point' : 'Lock point', { on: fixed, fn: toggleLock, disabled: st.selVertex < 0 }));
      }
      groups.push(['Point', pointBtns]);
      groups.push(['Shape', [btn('ruler', 'Edge lengths', { fn: lengthsDialog }), ...(isZone ? [
        btn('rotL', 'Rotate 15° left', { fn: () => rotateBy(-15) }), btn('rotR', 'Rotate 15° right', { fn: () => rotateBy(15) })] : [])]]);
      if (isZone) {
        groups.push(['Zone', [
          btn('copy', 'Copy zone', { fn: () => { zoneClipboard = JSON.parse(JSON.stringify(selZone())); notify('Zone copied. Tap Add zone, then the paste button in the toolbox.'); renderTools(); } }),
          btn('details', 'Zone details and plants', { fn: () => zoneDialog(border, selZone(), update, false) }),
          btn('trash', 'Delete zone', {
            kind: 'danger',
            fn: async () => {
              if (await ask('Delete this zone and its plants?')) {
                border.zones = border.zones.filter(z => z.id !== st.sel.id);
                st.sel = { kind: 'border' }; save(); update();
              }
            },
          }),
        ]]);
      }
    }
    if (groups.length) {
      const row = document.createElement('div');
      row.className = 'tool-actions';
      for (const [name, buttons] of groups) {
        const g = document.createElement('div');
        g.className = 'tool-group';
        const label = document.createElement('span');
        label.className = 'tool-label';
        label.textContent = name;
        const inner = document.createElement('div');
        inner.className = 'tool-btns';
        inner.append(...buttons);
        g.append(label, inner);
        row.append(g);
      }
      tools.append(row);
    }

    const modes = document.createElement('div');
    modes.className = 'tool-modes';
    const modeOn = m => st.mode === m || (m === 'drawZone' && st.mode === 'placeShape');
    modes.append(
      btn('eye', 'View', { on: modeOn('view'), fn: goMode('view'), disabled: !hasBorder, text: true }),
      btn('pencil', 'Edit', { on: modeOn('edit'), fn: goMode('edit'), disabled: !hasBorder, text: true }),
      btn('plus', 'Add zone', { on: modeOn('drawZone'), fn: goMode('drawZone'), disabled: !hasBorder, text: true }),
    );
    tools.append(modes);
    const hints = {
      view: border.zones.length ? 'Tap a zone to see or edit its plants. Drag to pan, pinch to zoom.' : 'Tap “Add zone” to mark where you planted something.',
      edit: st.sel.kind === 'zone' ? 'Editing a zone: drag its body to move it, the square handles to resize, the round handle on top to rotate, orange points to reshape, a white dot to add a point. Tap empty space to edit the border.' : 'Editing the border. Green squares are locked points; drag orange points, or a white dot to add a point. Tap a point, then the lock button, to lock it. Tap a zone to edit it.',
      drawBorder: 'Tap the corners of the border one by one, then Finish (or tap the green first point to close). Or open the toolbox for a ready-made shape.',
      drawZone: 'Tap the corners of the planted area and press Finish, or open the toolbox for a ready-made shape.',
      placeShape: 'Drag the shape to move it, the square handles to resize it and the round handle on top to rotate it. Use the ruler to type exact distances. Press Place when it is where you want it.',
    };
    hint.textContent = st.pendingPaste ? 'Tap on the map where you want to paste the copied zone.' : st.pendingShape ? 'Tap on the map where you want to put the shape.' : hints[st.mode];
  }

  function startPaste() {
    st.pendingPaste = !st.pendingPaste;
    st.pendingShape = null;
    st.shapesOpen = false;
    update();
  }

  function pasteZoneAt(c) {
    st.pendingPaste = false;
    const src = zoneClipboard, from = centroid(src.points), dx = c.x - from.x, dy = c.y - from.y;
    const zone = { ...JSON.parse(JSON.stringify(src)), id: uid(), points: src.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
    zone.plants = zone.plants.map(p => ({ ...p, id: uid() }));
    border.zones.push(zone);
    st.mode = 'view'; save(); update();
  }

  // Picking a shape only arms it; the shape is placed where the user taps next.
  function startShape(kind) {
    st.pendingShape = kind;
    st.pendingPaste = false;
    st.shapesOpen = false;
    update();
  }

  function placeShapeAt(kind, c) {
    st.pendingShape = null;
    const onBorder = border.points.length < 3;
    let w, h;
    if (onBorder) {
      const vh = st.vb.w * rect().height / rect().width;
      w = Math.round(st.vb.w * 0.4 / 10) * 10; h = Math.round(Math.min(st.vb.w * 0.3, vh * 0.5) / 10) * 10;
    } else {
      const b = bbox(border.points);
      w =  Math.min(Math.max((b.maxX - b.minX) * 0.3, 40), b.maxX - b.minX);
      h = Math.min(Math.max((b.maxY - b.minY) * 0.3, 40), b.maxY - b.minY);
    }
    st.shape = { kind, target: onBorder ? 'border' : 'zone', points: shapePoints(kind, c, w, h) };
    st.shapesOpen = false;
    st.mode = 'placeShape';
    update();
  }

  function confirmShape() {
    if (st.shape.target === 'border') {
      border.points = st.shape.points;
      st.shape = null; st.mode = 'view';
      save(); fit(); update();
      return;
    }
    addZone(st.shape.points, st.shape.rot);
  }

  function sizeDialog() {
    const sh = st.shape, rot = sh.rot || 0;
    const fr = shapeFrame(sh.points, rot);
    const w0 = dist(fr.box[0], fr.box[1]), h0 = dist(fr.box[1], fr.box[2]);
    const [wl, hl] = sh.kind === 'triangle' ? ['Base', 'Height'] : ['Width', 'Length'];
    openDialog(`<h2>Distances</h2>
      <div class="row"><div class="grow"><label>${wl} (m)</label><input type="number" id="sz-w" step="0.01" min="0.1" value="${m2(w0)}"></div>
      <div class="grow"><label>${hl} (m)</label><input type="number" id="sz-h" step="0.01" min="0.1" value="${m2(h0)}"></div></div>
      <div class="dlg-btns"><button class="btn alt" id="sz-cancel">Cancel</button><button class="btn" id="sz-ok">Apply</button></div>`,
    d => {
      d.querySelector('#sz-cancel').onclick = closeDialog;
      d.querySelector('#sz-ok').onclick = () => {
        const w = parseFloat(d.querySelector('#sz-w').value) * 100, h = parseFloat(d.querySelector('#sz-h').value) * 100;
        if (!(w >= 10 && h >= 10)) { notify('Please enter the distances.'); return; }
        const mid = { x: (fr.box[0].x + fr.box[2].x) / 2, y: (fr.box[0].y + fr.box[2].y) / 2 };
        const scaled = rotatePoints(sh.points, -rot, mid).map(p => ({ x: mid.x + (p.x - mid.x) * w / w0, y: mid.y + (p.y - mid.y) * h / h0 }));
        sh.points = rotatePoints(scaled, rot, mid);
        closeDialog(); update();
      };
    });
  }

  function rotateBy(deg) {
    const h = st.mode === 'placeShape' ? st.shape : selZone();
    if (!h) return;
    const pts = rotatePoints(h.points, deg, centroid(h.points));
    h.points = pts;
    h.rot = (((h.rot || 0) + deg) % 360 + 360) % 360;
    if (h !== st.shape) save();
    update();
  }

  function addZone(points, rot) {
    const zone = { id: uid(), name: '', light: '', water: '', points, plants: [] };
    if (rot) zone.rot = rot;
    border.zones.push(zone);
    st.draft = []; st.shape = null; st.mode = 'view'; save(); update();
    zoneDialog(border, zone, update, true);
  }

  function update() { keepPlacement(); renderTools(); render(); }

  function finishDraft() {
    if (st.draft.length < 3) return;
    if (st.mode === 'drawBorder') {
      border.points = st.draft;
      st.mode = 'view';
      st.draft = [];
      save(); fit(); update();
    } else {
      addZone(st.draft);
    }
  }

  function toggleLock() {
    const p = border.points[st.selVertex];
    if (!p) return;
    if (p.fixed) delete p.fixed; else p.fixed = true;
    save(); update();
  }

  function deleteVertex() {
    const pts = selPts();
    if (st.selVertex >= 0 && pts.length > 3 && !pts[st.selVertex].fixed) { pts.splice(st.selVertex, 1); st.selVertex = -1; save(); update(); }
  }

  function lengthsDialog() {
    const pts = selPts();
    const rows = pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      return `<div class="row"><span class="grow">Point ${i + 1} → ${(i + 1) % pts.length + 1}</span><input type="number" step="0.01" min="0.01" style="width:7em" data-i="${i}" value="${m2(dist(p, q))}"${p.fixed && q.fixed ? ' disabled' : ''}> m</div>`;
    }).join('');
    openDialog(`<h2>Edge lengths</h2>
      <p class="muted">Changing a length moves a free point along that edge (locked points never move). Adjust edges in order for a precise shape.</p>${rows}
      <div class="dlg-btns"><button class="btn alt" id="l-cancel">Cancel</button><button class="btn" id="l-ok">Apply</button></div>`,
    d => {
      d.querySelector('#l-cancel').onclick = closeDialog;
      d.querySelector('#l-ok').onclick = () => {
        d.querySelectorAll('input[data-i]').forEach(inp => {
          const i = +inp.dataset.i, j = (i + 1) % pts.length;
          const len = parseFloat(inp.value) * 100;
          if (len > 0 && Math.abs(len - dist(pts[i], pts[j])) > 0.5) {
            if (!pts[j].fixed) pts[j] = setEdgeLength(pts[i], pts[j], len);
            else if (!pts[i].fixed) pts[i] = setEdgeLength(pts[j], pts[i], len);
          }
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
    const holder = st.mode === 'placeShape' ? st.shape : st.mode === 'edit' ? selZone() : null;
    if (holder) {
      const fr = shapeFrame(holder.points, holder.rot || 0);
      const rh = fr.rotHandle;
      if (dpx(rh, pt) < 18) {
        Object.assign(g, { type: 'rotate', holder, keep: true, pivot: fr.pivot, rot0: holder.rot || 0, a0: Math.atan2(pt.y - fr.pivot.y, pt.x - fr.pivot.x), backup: holder.points.map(p => ({ ...p })) });
        return;
      }
      const hd = fr.handles.find(h => dpx(h, pt) < 16);
      if (hd) {
        Object.assign(g, { type: 'scale', holder, keep: true, backup: holder.points.map(p => ({ ...p })), pivot: fr.pivot, rot: holder.rot || 0, uc: hd.uc, ua: hd.ua, uoff: hd.uoff });
        return;
      }
      if (st.mode === 'placeShape') {
        if (pointInPolygon(pt, holder.points)) Object.assign(g, { type: 'move', holder, backup: holder.points.map(p => ({ ...p })) });
        return;
      }
    }
    if (st.mode === 'edit') {
      const pts = selPts();
      const zone = selZone();
      g.backup = pts.map(p => ({ ...p }));
      const vi = pts.findIndex(p => dpx(p, pt) < 18);
      if (vi >= 0) { g.type = pts[vi].fixed ? 'pan' : 'vertex'; g.keep = true; g.i = vi; st.selVertex = vi; renderTools(); render(); return; }
      const mi = pts.findIndex((p, i) => dpx({ x: (p.x + pts[(i + 1) % pts.length].x) / 2, y: (p.y + pts[(i + 1) % pts.length].y) / 2 }, pt) < 16);
      if (mi >= 0) {
        const q = pts[(mi + 1) % pts.length];
        pts.splice(mi + 1, 0, { x: (pts[mi].x + q.x) / 2, y: (pts[mi].y + q.y) / 2 });
        g.type = 'vertex'; g.i = mi + 1; st.selVertex = mi + 1; g.moved = true; renderTools(); render();
      } else if (zone && pointInPolygon(pt, zone.points)) {
        g.type = 'move'; g.holder = zone;
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
      selPts()[g.i] = { x: p.x, y: p.y };
      render();
    } else if (g.type === 'move' && g.moved) {
      const p = world(e);
      const dx = p.x - g.pt.x, dy = p.y - g.pt.y;
      g.holder.points = g.backup.map(q => ({ x: q.x + dx, y: q.y + dy }));
      render();
    } else if (g.type === 'rotate') {
      const p = world(e);
      let r = ((g.rot0 + (Math.atan2(p.y - g.pivot.y, p.x - g.pivot.x) - g.a0) * 180 / Math.PI) % 360 + 360) % 360;
      const snapped = Math.round(r / 15) * 15;
      if (Math.abs(snapped - r) < 4) r = snapped % 360;
      g.holder.points = rotatePoints(g.backup, r - g.rot0, g.pivot);
      g.holder.rot = r;
      g.moved = true;
      render();
    } else if (g.type === 'scale') {
      const u = rotatePoints([world(e)], -g.rot, g.pivot)[0];
      const factor = (now, anchor, corner) => {
        const ext = corner - anchor;
        if (Math.abs(ext) < 1) return 1;
        return Math.max((now - anchor) / ext, 20 / Math.abs(ext));
      };
      const fx = factor(u.x - g.uoff.x, g.ua.x, g.uc.x), fy = factor(u.y - g.uoff.y, g.ua.y, g.uc.y);
      const scaled = rotatePoints(g.backup, -g.rot, g.pivot).map(q => ({ ...q, x: g.ua.x + (q.x - g.ua.x) * fx, y: g.ua.y + (q.y - g.ua.y) * fy }));
      g.holder.points = rotatePoints(scaled, g.rot, g.pivot);
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
    if (done.type === 'vertex' || done.type === 'scale' || (done.type === 'move' && done.moved) || (done.type === 'rotate' && done.moved)) {
      const zone = st.mode === 'edit' ? selZone() : null;
      if (zone && done.type === 'vertex') delete zone.rot;
      save(); update(); return;
    }
    if (!done.moved && !done.keep && e.type === 'pointerup') onTap(done.pt);
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
    if (st.mode === 'placeShape') return;
    if (st.pendingPaste && st.mode === 'drawZone') return pasteZoneAt(pt);
    if (st.pendingShape && (st.mode === 'drawBorder' || st.mode === 'drawZone')) return placeShapeAt(st.pendingShape, pt);
    if (st.mode === 'drawBorder' || st.mode === 'drawZone') {
      if (st.draft.length >= 3 && dpx(st.draft[0], pt) < 16) return finishDraft();
      st.draft.push({ x: pt.x, y: pt.y });
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
      <button class="btn alt" id="m-3d">3D view</button>
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
    d.querySelector('#m-3d').onclick = () => {
      closeDialog();
      open3D({ border, plantsOf: z => z.plants.map(e => ({ ...rp(e), count: e.count })) });
    };
    d.querySelector('#m-cal').onclick = () => calendarDialog([border]);
    d.querySelector('#m-del').onclick = async () => {
      if (await ask(`Delete “${border.name}” and everything in it?`)) {
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
  const newEntry = () => ({ id: uid(), plantId: '', planted: today, note: '', count: 0 });
  const plantOptions = sel => '<option value="">Choose a plant…</option>' +
    [...data.plants].sort(byName).map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('') +
    '<option value="__new__">＋ Create new plant…</option>';
  const plantHtml = e => {
    const p = data.plants.find(x => x.id === e.plantId);
    return `
    <div class="plant" data-id="${e.id}">
      <label>Plant</label><select class="p-plant">${plantOptions(e.plantId)}</select>
      ${p ? `<div class="muted" style="margin-top:4px"><span class="dot" style="background:${esc(p.color)}"></span>${esc(plantSummary(p))}</div>` : ''}
      <div class="row"><div class="grow"><label>Amount planted</label><input type="number" inputmode="numeric" min="0" step="1" class="p-count" value="${e.count ? esc(e.count) : ''}" placeholder="e.g. 20 bulbs"></div>
      <div class="grow"><label>Planted on</label><input type="date" class="p-date" value="${esc(e.planted)}"></div></div>
      <label>Note (optional)</label><input type="text" class="p-note" value="${esc(e.note)}">
      <div class="dlg-btns" style="margin-top:6px">${p ? '<button class="btn alt p-edit">Edit plant</button>' : ''}<button class="btn danger p-del">Remove</button></div>
    </div>`;
  };
  const work = zone.plants.map(e => ({ ...e }));
  if (!work.length) work.push(newEntry());

  const readAll = d => [...d.querySelectorAll('.plant')].map(el => ({
    id: el.dataset.id,
    plantId: el.querySelector('.p-plant').value === '__new__' ? '' : el.querySelector('.p-plant').value,
    planted: el.querySelector('.p-date').value,
    count: Math.max(0, Math.floor(+el.querySelector('.p-count').value) || 0),
    note: el.querySelector('.p-note').value.trim(),
  }));

  const meta = { name: zone.name, light: zone.light, water: zone.water };

  function draw(plants) {
    openDialog(`<h2>${isNew ? 'New zone' : 'Zone'}</h2>
      <div class="muted">${m2(polygonArea(zone.points) / 100)} m²</div>
      <label>Zone name (optional)</label><input type="text" id="z-name" value="${esc(meta.name)}">
      <div class="row"><div class="grow"><label>Light level</label><select id="z-light">${opts(SUN, meta.light)}</select></div>
      <div class="grow"><label>Water</label><select id="z-water">${opts(ZONE_WATER, meta.water)}</select></div></div>
      <div class="muted" style="margin:10px 0 0">Plants in this zone</div>
      <div id="plants">${plants.map(plantHtml).join('')}</div>
      <button class="btn alt" id="z-add">+ Add plant</button>
      <div class="dlg-btns"><button class="btn danger" id="z-del">Delete zone</button><button class="btn alt" id="z-cancel">${isNew ? 'Skip' : 'Cancel'}</button><button class="btn" id="z-save">Save</button></div>`,
    d => {
      // keep the zone fields when the dialog is redrawn (add/copy/create plant)
      for (const [id, key] of [['#z-name', 'name'], ['#z-light', 'light'], ['#z-water', 'water']]) {
        d.querySelector(id).addEventListener('input', e => { meta[key] = e.target.value; });
      }
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
      d.querySelector('#z-del').onclick = async () => {
        if (await ask('Delete this zone?')) { border.zones = border.zones.filter(z => z !== zone); save(); closeDialog(); onClose?.(); }
      };
      d.querySelector('#z-save').onclick = () => {
        zone.name = d.querySelector('#z-name').value.trim();
        zone.light = d.querySelector('#z-light').value;
        zone.water = d.querySelector('#z-water').value;
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
    p.height && (p.height >= 100 ? `${(p.height / 100).toFixed(p.height % 100 ? 1 : 0)} m tall` : `${p.height} cm tall`),
  ].filter(Boolean).join(' · ') || 'No details yet';
}

// Create (plant = null) or edit a library plant. Calls onDone(plant) after saving; closes itself first.
function plantDialog(plant, onDone, onCancel, canDelete = false) {
  const p = plant ?? { id: uid(), name: '', color: '#e8a2c1', bloomFrom: 0, bloomTo: 0, water: '', sun: '', notes: '' };
  openDialog(`<h2>${plant ? 'Edit plant' : 'New plant'}</h2>
    ${plant ? '<p class="muted">Changes apply to every zone that uses this plant.</p>' : ''}
    <label>Name</label>
    <div class="row"><input type="text" id="pl-name" class="grow" value="${esc(p.name)}" placeholder="e.g. Tulip ‘Queen of Night’">
    <button class="btn alt" type="button" id="pl-autofill">Autofill</button></div>
    <p class="muted" id="pl-autofill-msg" hidden></p>
    <div class="row"><div class="grow"><label>Blooms from</label><select id="pl-from">${monthOptions(p.bloomFrom)}</select></div>
    <div class="grow"><label>until</label><select id="pl-to">${monthOptions(p.bloomTo)}</select></div>
    <div><label>Colour</label><input type="color" id="pl-color" value="${esc(p.color)}"></div></div>
    <div class="row"><div class="grow"><label>Water</label><select id="pl-water">${opts(WATER, p.water)}</select></div>
    <div class="grow"><label>Sun / shade</label><select id="pl-sun">${opts(SUN, p.sun)}</select></div></div>
    <label>Height (cm)</label><input type="number" id="pl-height" min="0" max="3000" step="1" inputmode="numeric" value="${p.height || ''}" placeholder="e.g. 60">
    <label>Notes</label><textarea id="pl-notes" rows="2">${esc(p.notes)}</textarea>
    <div class="dlg-btns">${plant && canDelete ? '<button class="btn danger" id="pl-del">Delete</button>' : ''}<button class="btn alt" id="pl-cancel">Cancel</button><button class="btn" id="pl-save">Save</button></div>`,
  d => {
    d.querySelector('#pl-cancel').onclick = () => { closeDialog(); onCancel?.(); };
    const msg = d.querySelector('#pl-autofill-msg');
    const showMsg = text => { msg.textContent = text; msg.hidden = !text; };
    d.querySelector('#pl-autofill').onclick = async e => {
      const btn = e.currentTarget;
      const name = d.querySelector('#pl-name').value.trim();
      if (name.length < 2) { showMsg('Type the plant name first.'); return; }
      if (!cloudUser) { showMsg('Sign in on the Account tab to use autofill.'); return; }
      btn.disabled = true;
      showMsg('Looking up plant details…');
      try {
        const r = await cloud.autofillPlant(name);
        if (!r.found) { showMsg('Plant not recognised. Check the spelling or try the Latin name.'); return; }
        const set = (id, value) => {
          const el = d.querySelector(id);
          if (value === '' || value === 0 || value == null) return;
          el.value = value;
          el.classList.add('autofilled');
        };
        set('#pl-from', r.bloomFrom);
        set('#pl-to', r.bloomTo);
        set('#pl-color', r.color);
        set('#pl-water', r.water);
        set('#pl-sun', r.sun);
        set('#pl-height', r.height);
        if (r.notes && !d.querySelector('#pl-notes').value.trim()) set('#pl-notes', r.notes);
        showMsg('Filled in by AI. Please check the highlighted fields before saving.');
      } catch (error) {
        showMsg(error.message);
      } finally {
        btn.disabled = false;
      }
    };
    d.querySelector('#pl-del')?.addEventListener('click', async () => {
      const uses = data.borders.flatMap(b => b.zones).filter(z => z.plants.some(e => e.plantId === p.id)).length;
      if (!await ask(uses ? `“${p.name}” is planted in ${uses} zone(s). Delete it from the library and from those zones?` : `Delete “${p.name}”?`)) return;
      data.plants = data.plants.filter(x => x.id !== p.id);
      data.borders.forEach(b => b.zones.forEach(z => { z.plants = z.plants.filter(e => e.plantId !== p.id); }));
      save(); closeDialog(); onDone(null);
    });
    d.querySelector('#pl-save').onclick = () => {
      const name = d.querySelector('#pl-name').value.trim();
      if (!name) { notify('Please enter a name.'); return; }
      Object.assign(p, {
        name,
        color: d.querySelector('#pl-color').value,
        bloomFrom: +d.querySelector('#pl-from').value,
        bloomTo: +d.querySelector('#pl-to').value,
        water: d.querySelector('#pl-water').value,
        sun: d.querySelector('#pl-sun').value,
        height: Math.max(0, Math.round(+d.querySelector('#pl-height').value || 0)),
        notes: d.querySelector('#pl-notes').value.trim(),
      });
      if (!plant) data.plants.push(p);
      save(); closeDialog(); onDone(p);
    };
  });
}

const WATER = [['', '—'], ['low', 'Low (dry)'], ['medium', 'Medium'], ['high', 'High (moist)']];
const ZONE_WATER = [['', '—'], ['few', 'Few'], ['normal', 'Normal'], ['lots', 'Lots']];
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

// ---------- backup and cloud sync ----------
const isEmptyData = d => !d.borders?.length && !d.plants?.length && !d.gardens?.length && !d.garden;

function refreshView() {
  ({ list: showList, plants: showPlants, settings: showSettings })[currentNav]?.();
}

// Replaces local data with the cloud copy and links this device to that revision.
async function applyRemote(remote, token) {
  if (!Array.isArray(remote.data?.borders)) throw new Error('The cloud copy is not a valid Border Planner backup.');
  const next = remote.data;
  const migrated = migrate(next);
  data = next;
  await saveData(data);
  cloudRevision = remote.revision;
  if (migrated) {
    const saved = await cloud.saveUserData(JSON.parse(JSON.stringify(data)), cloudRevision, token);
    if (!saved) return false;
    cloudRevision = saved.revision;
  }
  cloud.linkAccount(cloudUser.id, cloudRevision);
  cloud.clearAccountDirty(cloudUser.id);
  return true;
}

async function uploadData(expectedRevision, token) {
  const saved = await cloud.saveUserData(JSON.parse(JSON.stringify(data)), expectedRevision, token);
  if (!saved) return false;
  cloudRevision = saved.revision;
  cloud.linkAccount(cloudUser.id, cloudRevision);
  cloud.clearAccountDirty(cloudUser.id);
  return true;
}

let reconciling = false;

// Keeps this device and the account's cloud copy in step. Only real conflicts need a decision.
async function inspectCloudAccount({ silent = false } = {}) {
  if (!cloudUser || reconciling) return;
  reconciling = true;
  if (!silent) updateCloudStatus('Syncing…');
  try {
    const token = await cloud.getAccessToken();
    const remote = await cloud.getUserData(cloudUser.id, token);
    const link = cloud.getLinkedAccount();
    const linked = link?.userId === cloudUser.id;
    const dirty = cloud.getDirtyAccount() === cloudUser.id;
    const same = remote && canonicalJSON(data) === canonicalJSON(remote.data);
    const remoteEmpty = remote && isEmptyData(remote.data || {});
    cloudRevision = linked ? link.revision : null;
    cloudChoice = null;
    cloudConflict = false;

    const synced = () => updateCloudStatus(`Synced · revision ${cloudRevision}`);
    const download = async () => {
      if (!await applyRemote(remote, token)) throw new Error('The cloud copy changed. Try again.');
      synced();
      refreshView();
    };
    const upload = async expected => {
      if (!await uploadData(expected, token)) throw new Error('The cloud copy changed. Try again.');
      synced();
    };
    const choose = message => {
      cloudChoice = { remote, linked };
      cloudConflict = linked;
      cloudStatus = message;
    };

    if (!remote) {
      if (linked) choose('No cloud copy was found. Choose whether to upload this device’s data.');
      else await upload(null);
    } else if (linked && remote.revision === link.revision) {
      if (dirty || !same) {
        if (savePending) return;
        cloud.markAccountDirty(cloudUser.id);
        await upload(remote.revision);
      } else synced();
    } else if (linked) {
      if (!dirty && !savePending) await download();
      else choose('This device and another device both changed. Choose which copy to keep.');
    } else if (same) {
      cloud.linkAccount(cloudUser.id, remote.revision);
      cloudRevision = remote.revision;
      synced();
    } else if (isEmptyData(data)) await download();
    else if (remoteEmpty) await upload(remote.revision);
    else choose('This account already has cloud data and so does this device. Choose which copy to use.');
    if (!silent || cloudChoice) renderCloudSettings();
  } catch (error) {
    updateCloudStatus(`Saved on this device. Could not sync: ${error.message}`);
  } finally {
    reconciling = false;
  }
}

async function useCloudCopy() {
  let remote = cloudChoice?.remote;
  if (!remote) return;
  if (!Array.isArray(remote.data?.borders)) {
    notify('The cloud copy is not a valid Border Planner backup.');
    return;
  }
  if (!await ask('Replace the data on this device with the cloud copy?', 'Use cloud copy')) return;
  try {
    const token = await cloud.getAccessToken();
    const latest = await cloud.getUserData(cloudUser.id, token);
    if (!latest || latest.revision !== remote.revision) {
      cloudChoice = { remote: latest, linked: cloudChoice.linked };
      cloudConflict = cloudChoice.linked;
      updateCloudStatus('The cloud copy changed. Review the current version before replacing local data.');
      renderCloudSettings();
      return;
    }
    if (!await applyRemote(latest, token)) {
      cloudConflict = true;
      cloudChoice = { remote: await cloud.getUserData(cloudUser.id, token), linked: true };
      updateCloudStatus('Cloud data changed during migration. Choose which copy to keep in the Account tab.');
      showList();
      return;
    }
    cloudChoice = null;
    cloudConflict = false;
    updateCloudStatus(`Synced · revision ${cloudRevision}`);
    showList();
  } catch (error) {
    updateCloudStatus(`Could not use cloud copy: ${error.message}`);
    renderCloudSettings();
  }
}

async function uploadLocalCopy() {
  if (!cloudUser || !cloudChoice) return;
  const remote = cloudChoice.remote;
  if (remote && !await ask('Replace the cloud copy for this account with this device’s data? Other devices will receive this copy.', 'Replace cloud data')) return;
  try {
    const token = await cloud.getAccessToken();
    const saved = await cloud.saveUserData(JSON.parse(JSON.stringify(data)), remote?.revision ?? null, token);
    if (!saved) {
      cloudConflict = true;
      updateCloudStatus('The cloud copy changed while syncing. Check again before choosing a copy.');
      await inspectCloudAccount();
      return;
    }
    cloudRevision = saved.revision;
    cloud.linkAccount(cloudUser.id, cloudRevision);
    cloud.clearAccountDirty(cloudUser.id);
    cloudChoice = null;
    cloudConflict = false;
    updateCloudStatus(`Synced just now · revision ${cloudRevision}`);
    renderCloudSettings();
  } catch (error) {
    updateCloudStatus(`Could not upload this device’s data: ${error.message}`);
    renderCloudSettings();
  }
}

function renderCloudSettings() {
  const root = $('cloud-sync-panel');
  if (!root) return;
  const settings = cloud.getCloudConfig();
  if (cloudUser) {
    root.innerHTML = `<p>Signed in as <b>${esc(cloudUser.email || 'your account')}</b>.</p>
      <p class="muted cloud-sync-status" id="cloud-sync-status">${esc(cloudStatus)}</p>
      <div class="row">
        <button class="btn" type="button" id="cloud-check">Sync now</button>
        <button class="btn alt" type="button" id="cloud-sign-out">Sign out</button>
      </div>
      ${cloudChoice ? `<div class="cloud-sync-choice">
        <p>${cloudChoice.remote ? 'There is a cloud copy for this account. Choose explicitly; neither copy is replaced until you confirm.' : 'There is no cloud copy yet.'}</p>
        ${cloudChoice.remote ? '<button class="btn alt" type="button" id="cloud-use-copy">Use cloud copy on this device</button>' : ''}
        <button class="btn" type="button" id="cloud-upload-copy">${cloudChoice.remote ? 'Replace cloud with this device' : 'Upload this device to cloud'}</button>
      </div>` : ''}
      <p class="muted">Changes sync to your account automatically, and you stay signed in on this device. Garden data is private to this account.</p>`;
    $('cloud-check').onclick = inspectCloudAccount;
    $('cloud-sign-out').onclick = async () => {
      try {
        await cloud.signOut();
        cloudUser = null;
        cloudRevision = null;
        cloudChoice = null;
        cloudConflict = false;
        updateCloudStatus('Signed out. Your data remains saved on this device.');
        renderCloudSettings();
      } catch (error) {
        notify(`Could not sign out: ${error.message}`);
      }
    };
    $('cloud-use-copy')?.addEventListener('click', useCloudCopy);
    const uploadButton = $('cloud-upload-copy');
    if (uploadButton) uploadButton.onclick = uploadLocalCopy;
    return;
  }

  root.innerHTML = `${settings ? `<p class="muted">Sign in on each device with the same account to sync your garden. Each account has private data.</p>
    <label for="cloud-email">Email</label><input id="cloud-email" type="email" autocomplete="email" required>
    <label for="cloud-password">Password</label><input id="cloud-password" type="password" autocomplete="current-password" required>
    <p class="muted cloud-sync-status" id="cloud-sync-status">${esc(cloudStatus)}</p>
    <div class="row"><button class="btn" type="button" id="cloud-sign-in">Sign in</button>
    <button class="btn alt" type="button" id="cloud-sign-up">Create account</button></div>`
    : `<p class="muted">Add your Supabase project connection below to enable accounts and private cloud sync. Your local app continues to work without it.</p>
      <p class="muted cloud-sync-status" id="cloud-sync-status">${esc(cloudStatus)}</p>`}
    <details class="cloud-setup">
      <summary>${settings ? 'Supabase project connection' : 'Set up Supabase connection'}</summary>
      <p class="muted">Use your Supabase Project URL and the publishable (or legacy anon) public key. Never enter a service-role key here.</p>
      <label for="cloud-project-url">Project URL</label><input id="cloud-project-url" type="url" autocomplete="url" placeholder="https://your-project.supabase.co" value="${esc(settings?.url || '')}">
      <label for="cloud-public-key">Publishable / anon public key</label><input id="cloud-public-key" type="text" autocomplete="off" value="${esc(settings?.publicKey || '')}">
      <button class="btn alt" type="button" id="cloud-save-config">Save connection</button>
      <p class="muted">Run the included <code>supabase-schema.sql</code> in your Supabase SQL Editor first. Setup instructions are in <code>SUPABASE_SETUP.md</code>.</p>
    </details>`;
  $('cloud-sign-in')?.addEventListener('click', () => authenticate('sign-in'));
  $('cloud-sign-up')?.addEventListener('click', () => authenticate('sign-up'));
  $('cloud-save-config')?.addEventListener('click', () => {
    try {
      cloud.configureCloud($('cloud-project-url').value, $('cloud-public-key').value);
      cloudUser = null;
      cloudRevision = null;
      cloudChoice = null;
      cloudConflict = false;
      cloudStatus = 'Project connection saved on this device.';
      renderCloudSettings();
    } catch (error) {
      updateCloudStatus(error.message);
    }
  });
}

async function authenticate(action) {
  const email = $('cloud-email')?.value.trim();
  const password = $('cloud-password')?.value || '';
  if (!email || !password) {
    updateCloudStatus('Enter your email and password.');
    return;
  }
  updateCloudStatus(action === 'sign-in' ? 'Signing in…' : 'Creating account…');
  try {
    if (action === 'sign-in') {
      const session = await cloud.signIn(email, password);
      cloudUser = session.user;
      cloudStatus = 'Signed in. Checking cloud data…';
      await inspectCloudAccount();
    } else {
      const result = await cloud.signUp(email, password);
      if (!result.session) {
        updateCloudStatus('Account created. Check your email, confirm the account, then return here and sign in.');
        return false;
      }
      cloudUser = result.session.user;
      await inspectCloudAccount();
    }
    return !!cloudUser;
  } catch (error) {
    updateCloudStatus(`${action === 'sign-in' ? 'Sign in' : 'Account creation'} failed: ${error.message}`);
    return false;
  }
}

const WELCOME_KEY = 'borderplanner-welcome-done';

function showWelcome() {
  const el = document.createElement('div');
  el.className = 'welcome';
  el.innerHTML = `<div class="welcome-card">
    <img src="icon.svg" alt="" class="welcome-logo">
    <h1>Border Planner</h1>
    <p class="welcome-lead">Plan your garden and keep it with you on every device.</p>
    <form id="welcome-form" novalidate>
      <label for="cloud-email">Email</label>
      <input id="cloud-email" type="email" autocomplete="email" inputmode="email">
      <label for="cloud-password">Password</label>
      <input id="cloud-password" type="password" autocomplete="current-password">
      <p class="welcome-status" id="cloud-sync-status" role="status"></p>
      <button class="btn" type="submit" id="welcome-create">Create account</button>
      <button class="btn alt" type="button" id="welcome-signin">Sign in</button>
    </form>
    <button class="welcome-skip" type="button" id="welcome-skip">Continue without an account</button>
    <p class="welcome-note">Your data stays on this device until you choose to sync it. Nothing is overwritten without asking.</p>
  </div>`;
  document.body.append(el);
  const finish = goToAccount => {
    localStorage.setItem(WELCOME_KEY, '1');
    el.remove();
    if (goToAccount) showSettings();
  };
  const run = async action => {
    const buttons = el.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    const ok = await authenticate(action);
    buttons.forEach(b => { b.disabled = false; });
    if (ok) finish(!!cloudChoice);
  };
  el.querySelector('#welcome-form').onsubmit = e => { e.preventDefault(); run('sign-up'); };
  el.querySelector('#welcome-signin').onclick = () => run('sign-in');
  el.querySelector('#welcome-skip').onclick = () => finish(false);
}

function showSettings() {
  setNav('settings');
  setHeader('Account');
  main.innerHTML = `<div class="pad settings-page">
    <section class="card">
      <h2>Account & cloud sync</h2>
      <div id="cloud-sync-panel"></div>
    </section>
    <section class="card">
      <h2>Local backup</h2>
      <p class="muted">A backup file gives you an extra copy. Keep one even when cloud sync is enabled.</p>
      <div class="row"><button class="btn" id="exp">Export backup</button>
      <label class="btn alt" style="margin:0">Import backup<input type="file" id="imp" accept="application/json" hidden></label></div>
    </section>
  </div>`;
  renderCloudSettings();
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
      if (!await ask('Replace all current data with this backup?', 'Replace')) return;
      migrate(imported);
      data = imported; save(); showList();
    } catch (err) { notify('Import failed: ' + err.message); }
  };
}

// ---------- start ----------
(async () => {
  data = await loadData();
  if (migrate(data)) save();
  showList();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    cloud.consumeAuthRedirect();
    if (cloud.getCloudConfig() && cloud.getStoredSession()) {
      const session = await cloud.restoreSession();
      cloudUser = session.user;
      cloudStatus = 'Signed in. Checking cloud data…';
      await inspectCloudAccount();
    } else if (!localStorage.getItem(WELCOME_KEY)) {
      showWelcome();
    }
  } catch (error) {
    updateCloudStatus(`Local data is available, but cloud sync could not start: ${error.message}`);
  }
  const autoSync = () => {
    if (cloudUser && !cloudChoice && !cloudConflict && !savePending && !cloudSaveInProgress && ['list', 'plants', 'settings'].includes(currentNav)) {
      inspectCloudAccount({ silent: true });
    }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoSync(); });
  window.addEventListener('online', autoSync);
  setInterval(autoSync, 60000);
})();
