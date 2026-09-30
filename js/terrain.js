// Procedural terrain: heightmap, drainage, rivers, biomes, mountain ranges, auto-generated nations and towns.
import { makeRng } from './rng.js';
import { makeNoise } from './noise.js';
import { nationName, townName, riverName } from './names.js';

export const SEA_LEVEL = 0.2;
export const HILL_LEVEL = 0.5;
export const MOUNTAIN_LEVEL = 0.66;
export const RANGE_LEVEL = 0.58; // highlands that count as a natural boundary

export const BIOMES = [
  { id: 0, name: 'Marine', color: '#466eab' },
  { id: 1, name: 'Hot desert', color: '#fbe79f' },
  { id: 2, name: 'Cold desert', color: '#b5b887' },
  { id: 3, name: 'Savanna', color: '#d2d082' },
  { id: 4, name: 'Grassland', color: '#c8d68f' },
  { id: 5, name: 'Tropical seasonal forest', color: '#b6d95d' },
  { id: 6, name: 'Temperate deciduous forest', color: '#29bc56' },
  { id: 7, name: 'Tropical rainforest', color: '#7dcb35' },
  { id: 8, name: 'Temperate rainforest', color: '#409c43' },
  { id: 9, name: 'Taiga', color: '#4b6b32' },
  { id: 10, name: 'Tundra', color: '#96784b' },
  { id: 11, name: 'Glacier', color: '#d5e7eb' },
  { id: 12, name: 'Wetland', color: '#0b9131' },
];

export const NATION_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
  '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#a9a9a9',
];

const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const DY8 = [0, 1, 1, 1, 0, -1, -1, -1];

export function generateTerrain(opts) {
  const { seed, width, height, template = 'continent', landRatio = 0.42 } = opts;
  const rng = makeRng(seed);
  const noise = makeNoise(rng);
  const n = width * height;
  const raw = new Float32Array(n);
  const aspect = width / height;

  // Template parameters
  const tpl = {
    continent: { freq: 2.4, falloff: 1.3, falloffPow: 2.2, ridge: 0.45 },
    archipelago: { freq: 4.2, falloff: 0.6, falloffPow: 3, ridge: 0.25 },
    pangea: { freq: 1.8, falloff: 1.0, falloffPow: 3.5, ridge: 0.5 },
    islands: { freq: 3.4, falloff: 0.9, falloffPow: 2.5, ridge: 0.35 },
  }[template] || { freq: 2.4, falloff: 1.3, falloffPow: 2.2, ridge: 0.45 };

  const ox = rng() * 1000;
  const oy = rng() * 1000;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x / width) * tpl.freq * aspect;
      const ny = (y / height) * tpl.freq;
      let v = noise.fbm(nx + ox, ny + oy, 6, 2.05, 0.5); // -1..1
      v = v * 0.5 + 0.5;
      const r = noise.ridged(nx * 1.7 + ox + 50, ny * 1.7 + oy + 50, 4);
      v = v * (1 - tpl.ridge) + r * v * tpl.ridge * 1.6;
      // fine coastal detail so shorelines are craggy rather than blobby
      v += noise.fbm(nx * 5 + ox + 200, ny * 5 + oy + 200, 3, 2.2, 0.55) * 0.09;
      // elliptical falloff so oceans surround the land
      const dx = (x / width - 0.5) * 2;
      const dy = (y / height - 0.5) * 2;
      const d = Math.sqrt(dx * dx * 1.0 + dy * dy * 1.15);
      v -= Math.pow(Math.max(0, d), tpl.falloffPow) * tpl.falloff;
      raw[y * width + x] = v;
    }
  }

  // Normalise: sea level sits at the desired land percentile, then squash to 0..1.
  const sorted = Float32Array.from(raw).sort();
  const seaRaw = sorted[Math.floor((1 - landRatio) * n)];
  const maxRaw = sorted[n - 1];
  const minRaw = sorted[0];
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (v >= seaRaw) h[i] = SEA_LEVEL + ((v - seaRaw) / (maxRaw - seaRaw + 1e-6)) * (1 - SEA_LEVEL);
    else h[i] = ((v - minRaw) / (seaRaw - minRaw + 1e-6)) * SEA_LEVEL;
  }
  // Lift land elevation curve a little so mountains are not only at the very peak.
  for (let i = 0; i < n; i++) {
    if (h[i] >= SEA_LEVEL) {
      const t = (h[i] - SEA_LEVEL) / (1 - SEA_LEVEL);
      h[i] = SEA_LEVEL + Math.pow(t, 1.6) * (1 - SEA_LEVEL);
    }
  }

  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = h[i] >= SEA_LEVEL ? 1 : 0;

  // Distance to coast (in cells) for land, used for moisture and town placement.
  const coastDist = distanceToCoast(land, width, height);

  // Drainage
  const filled = fillSinks(h, land, width, height);
  const { down, flux } = computeFlow(filled, land, width, height, noise, ox, oy);
  const riverThreshold = Math.max(18, (n * landRatio) / 900);
  const rivers = traceRivers(down, flux, land, width, height, riverThreshold, rng);
  const riverCell = new Int16Array(n).fill(-1);
  rivers.forEach((r, idx) => r.cells.forEach((c) => (riverCell[c] = idx)));

  // Climate and biomes
  const biome = new Uint8Array(n);
  const moisture = new Float32Array(n);
  const temperature = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const lat = y / height; // 0 = north (cold), 1 = south (hot)
      let temp = 0.3 + lat * 0.65 + noise.fbm(x / width * 3 + ox + 7, y / height * 3 + oy + 7, 3) * 0.1;
      temp -= Math.max(0, h[i] - SEA_LEVEL) * 0.45;
      let moist = noise.fbm(x / width * 3.5 + ox + 99, y / height * 3.5 + oy + 99, 4) * 0.5 + 0.5;
      moist += Math.max(0, 1 - coastDist[i] / 25) * 0.25;
      if (riverCell[i] >= 0) moist += 0.25;
      temperature[i] = temp;
      moisture[i] = Math.min(1, moist);
      biome[i] = land[i] ? classifyBiome(temp, moist, h[i], flux[i], riverThreshold) : 0;
    }
  }

  const ranges = findRanges(h, width, height);

  const terrain = {
    seed, width, height, template, landRatio,
    elevation: h, land, coastDist, biome, moisture, temperature, flux, down,
    rivers, riverCell, ranges,
  };
  return terrain;
}

function classifyBiome(temp, moist, height, flux, riverThreshold) {
  if (height > 0.9 || temp < 0.1) return 11;
  if (temp < 0.25) return 10;
  if (temp < 0.45) return moist > 0.4 ? 9 : 2;
  if (flux > riverThreshold * 0.5 && moist > 0.75 && height < 0.3) return 12;
  if (temp > 0.78 && moist < 0.32) return 1;
  if (temp > 0.68 && moist < 0.5) return 3;
  if (temp > 0.72 && moist > 0.72) return 7;
  if (temp > 0.68) return 5;
  if (moist < 0.42) return 4;
  if (moist < 0.7) return 6;
  return 8;
}

function distanceToCoast(land, width, height) {
  const n = width * height;
  const dist = new Float32Array(n).fill(1e9);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!land[i]) {
        dist[i] = 0;
        queue[qt++] = i;
      }
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % width;
    const y = (i - x) / width;
    for (let k = 0; k < 8; k += 2) {
      const nx = x + DX8[k];
      const ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (dist[j] > dist[i] + 1) {
        dist[j] = dist[i] + 1;
        queue[qt++] = j;
      }
    }
  }
  return dist;
}

// Planchon-Darboux depression filling so every land cell drains to the sea.
function fillSinks(h, land, width, height) {
  const n = width * height;
  const w = new Float32Array(n);
  const eps = 0.0004;
  for (let i = 0; i < n; i++) w[i] = land[i] ? 1e9 : h[i];
  let changed = true;
  let passes = 0;
  while (changed && passes < 200) {
    changed = false;
    passes++;
    const forward = passes % 2 === 1;
    for (let s = 0; s < n; s++) {
      const i = forward ? s : n - 1 - s;
      if (!land[i] || w[i] <= h[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        const cand = w[j] + eps;
        if (h[i] >= cand) {
          w[i] = h[i];
          changed = true;
          break;
        }
        if (w[i] > cand) {
          w[i] = cand;
          changed = true;
        }
      }
    }
  }
  return w;
}

function computeFlow(w, land, width, height, noise, ox, oy) {
  const n = width * height;
  const down = new Int32Array(n).fill(-1);
  const flux = new Float32Array(n);
  const order = [];
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    order.push(i);
    const x = i % width;
    const y = (i - x) / width;
    let best = -1;
    let bestW = w[i];
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k];
      const ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      // diagonal moves are penalised a little so rivers do not stair-step
      const wv = w[j] + (k % 2 === 1 ? 0.00005 : 0);
      if (wv < bestW) {
        bestW = wv;
        best = j;
      }
    }
    down[i] = best;
  }
  order.sort((a, b) => w[b] - w[a]);
  for (const i of order) {
    const x = i % width;
    const y = (i - x) / width;
    const rain = 0.6 + (noise.fbm(x / width * 4 + ox + 31, y / height * 4 + oy + 31, 3) * 0.5 + 0.5);
    flux[i] += rain;
    if (down[i] >= 0) flux[down[i]] += flux[i];
  }
  return { down, flux };
}

function traceRivers(down, flux, land, width, height, threshold, rng) {
  const n = width * height;
  const isRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (land[i] && flux[i] >= threshold) isRiver[i] = 1;
  const hasUpstreamRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (isRiver[i] && down[i] >= 0) hasUpstreamRiver[down[i]] = 1;
  const owner = new Int16Array(n).fill(-1);
  const rivers = [];
  // Sources sorted by flux so main stems get traced before tributaries would claim their cells.
  const sources = [];
  for (let i = 0; i < n; i++) if (isRiver[i] && !hasUpstreamRiver[i]) sources.push(i);
  // Trace from each source to the sea; the longest path claims cells first.
  const paths = sources.map((s) => {
    const cells = [];
    let c = s;
    let guard = 0;
    while (c >= 0 && land[c] && guard++ < 5000) {
      cells.push(c);
      c = down[c];
    }
    return { source: s, cells, mouth: c };
  });
  paths.sort((a, b) => b.cells.length - a.cells.length);
  for (const p of paths) {
    const cells = [];
    for (const c of p.cells) {
      if (owner[c] >= 0) {
        cells.push(c); // include the junction cell so the tributary visually joins
        break;
      }
      cells.push(c);
    }
    if (cells.length < 6) continue;
    const id = rivers.length;
    for (const c of cells) if (owner[c] < 0) owner[c] = id;
    const points = cells.map((c) => {
      const x = c % width;
      const y = (c - x) / width;
      return [x + 0.5 + (rng() - 0.5) * 0.5, y + 0.5 + (rng() - 0.5) * 0.5];
    });
    // If the river reaches the sea, extend the last point a bit into the water so it visibly meets the coast.
    if (p.mouth >= 0 && !land[p.mouth] && owner[cells[cells.length - 1]] === id) {
      const mx = p.mouth % width;
      const my = (p.mouth - mx) / width;
      points.push([mx + 0.5, my + 0.5]);
    }
    const widths = cells.map((c) => Math.min(1.4, 0.18 + Math.sqrt(flux[c] / threshold) * 0.22));
    if (points.length > cells.length) widths.push(widths[widths.length - 1]);
    rivers.push({ id, cells, points, widths, name: riverName(rng), flux: flux[cells[cells.length - 1]] });
  }
  return rivers;
}

function findRanges(h, width, height) {
  const n = width * height;
  const rangeId = new Int16Array(n).fill(-1);
  const ranges = [];
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (h[i] < RANGE_LEVEL || rangeId[i] >= 0) continue;
    const id = ranges.length;
    const cells = [];
    stack.push(i);
    rangeId[i] = id;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const x = c % width;
      const y = (c - x) / width;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (h[j] >= RANGE_LEVEL && rangeId[j] < 0) {
          rangeId[j] = id;
          stack.push(j);
        }
      }
    }
    if (cells.length < 4) {
      for (const c of cells) rangeId[c] = -1;
      continue;
    }
    ranges.push({ id, cells });
  }
  return { rangeId, list: ranges };
}

// ---------- Nations & towns ----------

export function autoNations(terrain, count, rng) {
  const { width, height, land, elevation: h, riverCell, coastDist, biome } = terrain;
  const n = width * height;
  const owner = new Uint8Array(n); // 0 = neutral, else nation id
  const nations = [];
  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || h[i] > HILL_LEVEL || biome[i] === 11 || biome[i] === 1) continue;
    candidates.push(i);
  }
  if (!candidates.length) return { owner, nations };
  const minDist = Math.sqrt((candidates.length * 1.0) / count) * 0.9;
  const capitals = [];
  let tries = 0;
  while (capitals.length < count && tries++ < 4000) {
    const c = candidates[Math.floor(rng() * candidates.length)];
    const x = c % width;
    const y = (c - x) / width;
    let ok = true;
    for (const k of capitals) {
      const kx = k % width;
      const ky = (k - kx) / width;
      if (Math.hypot(kx - x, ky - y) < minDist) {
        ok = false;
        break;
      }
    }
    if (ok) capitals.push(c);
  }
  const usedColors = new Set();
  capitals.forEach((c, idx) => {
    let color = NATION_COLORS[idx % NATION_COLORS.length];
    while (usedColors.has(color)) color = NATION_COLORS[Math.floor(rng() * NATION_COLORS.length)];
    usedColors.add(color);
    nations.push({ id: idx + 1, name: nationName(rng), color, capital: c });
  });

  // Multi-source Dijkstra with terrain costs. Rivers and mountains are expensive to cross so borders follow them.
  const cost = new Float64Array(n).fill(1e9);
  const heap = new MinHeap();
  capitals.forEach((c, idx) => {
    cost[c] = 0;
    owner[c] = idx + 1;
    heap.push(0, c);
  });
  const maxCost = Math.sqrt(n) * 0.9;
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > cost[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k];
      const ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (!land[j]) continue;
      let step = k % 2 === 1 ? 1.41 : 1;
      const hj = h[j];
      if (hj >= MOUNTAIN_LEVEL) step += 14;
      else if (hj >= HILL_LEVEL) step += 3;
      if (riverCell[j] >= 0 && riverCell[j] !== riverCell[i]) step += 10;
      if (biome[j] === 1 || biome[j] === 11 || biome[j] === 10) step += 2;
      const nd = d + step;
      if (nd < cost[j] && nd < maxCost) {
        cost[j] = nd;
        owner[j] = owner[i];
        heap.push(nd, j);
      }
    }
  }

  // Towns: a few per nation on rivers or coasts.
  const burgs = [];
  nations.forEach((nat) => {
    const cx = nat.capital % width;
    const cy = (nat.capital - cx) / width;
    burgs.push({ cell: nat.capital, x: cx + 0.5, y: cy + 0.5, name: townName(rng), capital: true, nation: nat.id });
    const cells = [];
    for (let i = 0; i < n; i++) if (owner[i] === nat.id && h[i] < HILL_LEVEL && (riverCell[i] >= 0 || coastDist[i] <= 2)) cells.push(i);
    let placed = 0;
    let t = 0;
    while (placed < 4 && t++ < 400 && cells.length) {
      const c = cells[Math.floor(rng() * cells.length)];
      const x = c % width;
      const y = (c - x) / width;
      const tooClose = burgs.some((b) => Math.hypot(b.x - x, b.y - y) < 14);
      if (tooClose) continue;
      burgs.push({ cell: c, x: x + 0.5, y: y + 0.5, name: townName(rng), capital: false, nation: nat.id });
      placed++;
    }
  });
  return { owner, nations, burgs };
}

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && k[l] < k[m]) m = l;
        if (r < n && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
