// Save / load. Terrain is regenerated from its seed, so only user edits are stored.
import { regenerate, rebuildBarrier, emit, GRID_W, GRID_H } from './state.js';

const KEY = 'fantasy-map-state-v1';

function rle(arr) {
  const out = [];
  let v = arr[0];
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === v) n++;
    else {
      out.push(v, n);
      v = arr[i];
      n = 1;
    }
  }
  out.push(v, n);
  return out;
}
function unrle(runs, len) {
  const arr = new Uint8Array(len);
  let i = 0;
  for (let k = 0; k < runs.length; k += 2) {
    const v = runs[k];
    const n = runs[k + 1];
    arr.fill(v, i, i + n);
    i += n;
  }
  return arr;
}

export function serialize(state) {
  return {
    version: 1,
    seed: state.seed,
    template: state.template,
    landRatio: state.landRatio,
    nationCount: state.nationCount,
    nations: state.nations,
    burgs: state.burgs,
    owner: rle(state.owner),
    boundaries: state.boundaries,
    selectedRivers: [...state.selectedRivers],
    selectedRanges: [...state.selectedRanges],
    allRiversBlock: state.allRiversBlock,
    allRangesBlock: state.allRangesBlock,
    sameOwnerOnly: state.sameOwnerOnly,
    activeNation: state.activeNation,
    resources: state.resources,
    view: state.view,
  };
}

export function deserialize(state, data) {
  if (!data || data.version !== 1) throw new Error('Unsupported file');
  state.seed = data.seed;
  state.template = data.template;
  state.landRatio = data.landRatio;
  state.nationCount = data.nationCount || 8;
  regenerate(state);
  state.nations = data.nations;
  state.burgs = data.burgs || [];
  state.owner = unrle(data.owner, GRID_W * GRID_H);
  state.boundaries = data.boundaries || [];
  state.selectedRivers = new Set(data.selectedRivers || []);
  state.selectedRanges = new Set(data.selectedRanges || []);
  state.allRiversBlock = !!data.allRiversBlock;
  state.allRangesBlock = !!data.allRangesBlock;
  state.sameOwnerOnly = data.sameOwnerOnly !== false;
  state.activeNation = data.activeNation;
  state.resources = data.resources || { visible: true, opacity: 1, items: [] };
  if (data.view) state.view = data.view;
  rebuildBarrier(state);
  state.undo = [];
  state.redo = [];
  emit(state, 'nations');
  emit(state, 'resources');
  emit(state, 'selection');
}

export function saveLocal(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(serialize(state)));
    return true;
  } catch (e) {
    console.warn('autosave failed', e);
    return false;
  }
}
export function loadLocal(state) {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    deserialize(state, JSON.parse(raw));
    return true;
  } catch (e) {
    console.warn('load failed', e);
    return false;
  }
}
export function clearLocal() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) { /* ignore */ }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
