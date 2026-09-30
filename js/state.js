// Application state and all mutating operations (territory fill, brush, boundaries, resources, undo/redo).
import { generateTerrain, autoNations, NATION_COLORS, RANGE_LEVEL } from './terrain.js';
import { makeRng, randomSeed } from './rng.js';
import { nationName } from './names.js';

export const CELL = 4; // map pixels per grid cell
export const GRID_W = 300;
export const GRID_H = 200;

export function createState() {
  return {
    seed: randomSeed(),
    template: 'continent',
    landRatio: 0.42,
    nationCount: 8,
    cellSize: CELL,
    terrain: null,
    nations: [],
    burgs: [],
    owner: new Uint8Array(GRID_W * GRID_H),
    boundaries: [], // [{points: [[x,y]...] map px}]
    barrier: new Uint8Array(GRID_W * GRID_H),
    selectedRivers: new Set(),
    selectedRanges: new Set(),
    allRiversBlock: false,
    allRangesBlock: false,
    sameOwnerOnly: true, // fill stays inside the tapped nation's territory
    activeNation: 1,
    resources: { visible: true, opacity: 1, items: [] },
    view: { x: 0, y: 0, zoom: 1 },
    undo: [],
    redo: [],
    listeners: new Set(),
  };
}

export function regenerate(state, opts = {}) {
  Object.assign(state, opts);
  state.terrain = generateTerrain({ seed: state.seed, width: GRID_W, height: GRID_H, template: state.template, landRatio: state.landRatio });
  const rng = makeRng(state.seed + ':nations');
  const { owner, nations, burgs } = autoNations(state.terrain, state.nationCount, rng);
  state.owner = owner;
  state.nations = nations;
  state.burgs = burgs || [];
  state.boundaries = [];
  state.barrier = new Uint8Array(GRID_W * GRID_H);
  state.selectedRivers = new Set();
  state.selectedRanges = new Set();
  state.activeNation = nations.length ? nations[0].id : 1;
  state.undo = [];
  state.redo = [];
  emit(state, 'terrain');
}

export function onChange(state, fn) {
  state.listeners.add(fn);
}
export function emit(state, what) {
  for (const fn of state.listeners) fn(what);
}

// ---------- Undo ----------
function snapshot(state) {
  return {
    owner: state.owner.slice(),
    boundaries: state.boundaries.map((b) => ({ points: b.points.map((p) => p.slice()) })),
    selectedRivers: new Set(state.selectedRivers),
    selectedRanges: new Set(state.selectedRanges),
    resources: { ...state.resources, items: state.resources.items.map((it) => (it.type === 'stroke' ? { ...it, points: it.points.map((p) => p.slice()) } : { ...it })) },
    nations: state.nations.map((n) => ({ ...n })),
    burgs: state.burgs.map((b) => ({ ...b })),
  };
}
function restore(state, snap) {
  state.owner = snap.owner;
  state.boundaries = snap.boundaries;
  state.selectedRivers = snap.selectedRivers;
  state.selectedRanges = snap.selectedRanges;
  state.resources = snap.resources;
  state.nations = snap.nations;
  state.burgs = snap.burgs;
  rebuildBarrier(state);
  emit(state, 'nations');
  emit(state, 'resources');
}
export function pushUndo(state) {
  state.undo.push(snapshot(state));
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
}
export function undo(state) {
  if (!state.undo.length) return;
  state.redo.push(snapshot(state));
  restore(state, state.undo.pop());
}
export function redo(state) {
  if (!state.redo.length) return;
  state.undo.push(snapshot(state));
  restore(state, state.redo.pop());
}

// ---------- Nations ----------
export function addNation(state, name) {
  pushUndo(state);
  const used = new Set(state.nations.map((n) => n.color));
  const id = (state.nations.reduce((m, n) => Math.max(m, n.id), 0) || 0) + 1;
  if (id > 255) return null;
  let color = NATION_COLORS.find((c) => !used.has(c));
  if (!color) color = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
  const rng = makeRng(state.seed + ':n' + id + ':' + Date.now());
  const nat = { id, name: name || nationName(rng), color, capital: -1 };
  state.nations.push(nat);
  state.activeNation = id;
  emit(state, 'nations');
  return nat;
}
export function removeNation(state, id) {
  pushUndo(state);
  state.nations = state.nations.filter((n) => n.id !== id);
  for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === id) state.owner[i] = 0;
  state.burgs = state.burgs.filter((b) => b.nation !== id);
  if (state.activeNation === id) state.activeNation = state.nations.length ? state.nations[0].id : 0;
  emit(state, 'nations');
}
export function updateNation(state, id, patch) {
  const n = state.nations.find((x) => x.id === id);
  if (!n) return;
  pushUndo(state);
  Object.assign(n, patch);
  emit(state, 'nations');
}
export function renameRandom(state, id) {
  updateNation(state, id, { name: nationName(makeRng(Math.random() * 1e9)) });
}

// ---------- Cell helpers ----------
export function cellAt(state, mx, my) {
  const x = Math.floor(mx / state.cellSize);
  const y = Math.floor(my / state.cellSize);
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return -1;
  return y * GRID_W + x;
}

function isBlocking(state, c) {
  const t = state.terrain;
  if (state.barrier[c]) return true;
  const rc = t.riverCell[c];
  if (rc >= 0 && (state.allRiversBlock || state.selectedRivers.has(rc))) return true;
  const rg = t.ranges.rangeId[c];
  if (rg >= 0 && (state.allRangesBlock || state.selectedRanges.has(rg))) return true;
  return false;
}

// Flood-fill a region of land bounded by the coast, selected landmarks and drawn boundaries.
export function fillRegion(state, startCell, nationId) {
  const t = state.terrain;
  if (startCell < 0 || !t.land[startCell]) return false;
  pushUndo(state);
  const owner = state.owner;
  const prev = owner[startCell];
  const visited = new Uint8Array(owner.length);
  const queue = new Int32Array(owner.length);
  let qh = 0;
  let qt = 0;
  queue[qt++] = startCell;
  visited[startCell] = 1;
  const startBlocked = isBlocking(state, startCell);
  while (qh < qt) {
    const c = queue[qh++];
    owner[c] = nationId;
    // Blocking cells are absorbed (claimed) but not expanded from, so a 1-cell-wide river or line stops the fill.
    if (isBlocking(state, c) && !(startBlocked && c === startCell)) continue;
    const x = c % GRID_W;
    const y = (c - x) / GRID_W;
    const neigh = [c - 1, c + 1, c - GRID_W, c + GRID_W];
    for (let k = 0; k < 4; k++) {
      if ((k === 0 && x === 0) || (k === 1 && x === GRID_W - 1) || (k === 2 && y === 0) || (k === 3 && y === GRID_H - 1)) continue;
      const j = neigh[k];
      if (visited[j] || !t.land[j]) continue;
      if (state.sameOwnerOnly && owner[j] !== prev && owner[j] !== nationId) continue;
      if (isBlocking(state, j)) {
        // Absorb boundary cells only if they are free or belonged to the nation being replaced.
        if (owner[j] === 0 || owner[j] === prev) {
          visited[j] = 1;
          queue[qt++] = j;
        }
        continue;
      }
      visited[j] = 1;
      queue[qt++] = j;
    }
  }
  emit(state, 'nations');
  return true;
}

export function paintBrush(state, mx, my, radiusCells, nationId, begin) {
  if (begin) pushUndo(state);
  const t = state.terrain;
  const cx = mx / state.cellSize;
  const cy = my / state.cellSize;
  const r = radiusCells;
  let changed = false;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(GRID_H - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(GRID_W - 1, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const i = y * GRID_W + x;
      if (!t.land[i] || state.owner[i] === nationId) continue;
      state.owner[i] = nationId;
      changed = true;
    }
  }
  if (changed) emit(state, 'nations-light');
  return changed;
}

// ---------- Landmarks ----------
export function riverNear(state, mx, my, tol) {
  const cs = state.cellSize;
  let best = -1;
  let bestD = tol;
  for (const r of state.terrain.rivers) {
    const pts = r.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = segDist(mx, my, pts[i][0] * cs, pts[i][1] * cs, pts[i + 1][0] * cs, pts[i + 1][1] * cs);
      if (d < bestD) {
        bestD = d;
        best = r.id;
      }
    }
  }
  return best;
}
export function rangeAt(state, mx, my) {
  const c = cellAt(state, mx, my);
  if (c < 0) return -1;
  const rid = state.terrain.ranges.rangeId;
  if (rid[c] >= 0) return rid[c];
  const x = c % GRID_W;
  const y = (c - x) / GRID_W;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      if (rid[ny * GRID_W + nx] >= 0) return rid[ny * GRID_W + nx];
    }
  }
  return -1;
}
export function toggleRiver(state, id) {
  pushUndo(state);
  if (state.selectedRivers.has(id)) state.selectedRivers.delete(id);
  else state.selectedRivers.add(id);
  emit(state, 'selection');
}
export function toggleRange(state, id) {
  pushUndo(state);
  if (state.selectedRanges.has(id)) state.selectedRanges.delete(id);
  else state.selectedRanges.add(id);
  emit(state, 'selection');
}
export function clearSelection(state) {
  pushUndo(state);
  state.selectedRivers.clear();
  state.selectedRanges.clear();
  emit(state, 'selection');
}

// ---------- Manual boundaries ----------
export function addBoundary(state, points) {
  if (points.length < 2) return;
  pushUndo(state);
  state.boundaries.push({ points: points.map((p) => p.slice()) });
  rebuildBarrier(state);
  emit(state, 'selection');
}
export function removeBoundaryNear(state, mx, my, tol) {
  let best = -1;
  let bestD = tol;
  state.boundaries.forEach((b, idx) => {
    for (let i = 0; i < b.points.length - 1; i++) {
      const d = segDist(mx, my, b.points[i][0], b.points[i][1], b.points[i + 1][0], b.points[i + 1][1]);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  });
  if (best < 0) return false;
  pushUndo(state);
  state.boundaries.splice(best, 1);
  rebuildBarrier(state);
  emit(state, 'selection');
  return true;
}
export function clearBoundaries(state) {
  pushUndo(state);
  state.boundaries = [];
  rebuildBarrier(state);
  emit(state, 'selection');
}
export function rebuildBarrier(state) {
  const b = new Uint8Array(GRID_W * GRID_H);
  const cs = state.cellSize;
  for (const line of state.boundaries) {
    const p = line.points;
    for (let i = 0; i < p.length - 1; i++) {
      rasterLine(b, Math.floor(p[i][0] / cs), Math.floor(p[i][1] / cs), Math.floor(p[i + 1][0] / cs), Math.floor(p[i + 1][1] / cs));
    }
    if (p.length === 1) rasterLine(b, Math.floor(p[0][0] / cs), Math.floor(p[0][1] / cs), Math.floor(p[0][0] / cs), Math.floor(p[0][1] / cs));
  }
  state.barrier = b;
}
function rasterLine(grid, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let guard = 0;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < GRID_W && y0 < GRID_H) grid[y0 * GRID_W + x0] = 1;
    if ((x0 === x1 && y0 === y1) || guard++ > 10000) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// ---------- Resources ----------
export function addResource(state, item) {
  pushUndo(state);
  state.resources.items.push(item);
  emit(state, 'resources');
}
export function eraseResourceNear(state, mx, my, tol) {
  const items = state.resources.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    let hit = false;
    if (it.type === 'shape') hit = Math.hypot(it.x - mx, it.y - my) <= it.size / 2 + tol;
    else {
      const p = it.points;
      if (p.length === 1) hit = Math.hypot(p[0][0] - mx, p[0][1] - my) <= it.width / 2 + tol;
      for (let k = 0; k < p.length - 1 && !hit; k++) hit = segDist(mx, my, p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]) <= it.width / 2 + tol;
    }
    if (hit) {
      pushUndo(state);
      items.splice(i, 1);
      emit(state, 'resources');
      return true;
    }
  }
  return false;
}
export function clearResources(state) {
  pushUndo(state);
  state.resources.items = [];
  emit(state, 'resources');
}

export function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export { RANGE_LEVEL };
