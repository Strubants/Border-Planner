export const PLANT_TYPES = [['tuber', 'Tuber'], ['plant', 'Plant'], ['tree', 'Bush / Tree']];

const KEY = 'plantTypeFilter';

// The set of plant types currently shown; defaults to all of them.
export function loadTypeFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved)) return new Set(saved.filter(t => PLANT_TYPES.some(([k]) => k === t)));
  } catch { /* fall through to default */ }
  return new Set(PLANT_TYPES.map(([k]) => k));
}

export function saveTypeFilter(filter) {
  localStorage.setItem(KEY, JSON.stringify([...filter]));
}

// Plants without a type (saved before types existed) are never filtered out.
export function typeVisible(plant, filter) {
  return !plant?.type || filter.has(plant.type);
}

// Entries of a zone that pass the filter. An empty zone stays visible.
export function zoneEntries(zone, plants, filter) {
  return zone.plants.filter(e => typeVisible(plants.find(p => p.id === e.plantId), filter));
}

export const zoneVisible = (zone, plants, filter) =>
  !zone.plants.length || zoneEntries(zone, plants, filter).length > 0;

// Renders the filter chips into `el` and calls onChange(filter) when one is toggled.
export function mountTypeFilter(el, filter, onChange) {
  const draw = () => {
    el.innerHTML = PLANT_TYPES.map(([k, l]) =>
      `<button type="button" class="type-chip${filter.has(k) ? ' on' : ''}" data-type="${k}" aria-pressed="${filter.has(k)}">${l}</button>`).join('');
  };
  el.onclick = e => {
    const k = e.target.closest('[data-type]')?.dataset.type;
    if (!k) return;
    if (filter.has(k)) filter.delete(k); else filter.add(k);
    saveTypeFilter(filter);
    draw();
    onChange(filter);
  };
  draw();
}
