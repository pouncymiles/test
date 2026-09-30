// Marching squares with linear interpolation. Turns a scalar grid into smooth closed polygons
// at a given threshold. Used for coastlines and nation borders so they are not blocky.
// field: Float32Array|Uint8Array of size w*h sampled at cell centres. Returns array of rings
// (each ring an array of [x, y] in cell units, where cell centre (i, j) is at (i + 0.5, j + 0.5)).
export function traceContours(field, w, h, threshold) {
  // Work on a padded grid so shapes touching the edge are closed.
  const W = w + 2;
  const H = h + 2;
  const f = new Float32Array(W * H);
  const pad = threshold - 1; // padding value is always "outside"
  f.fill(pad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[(y + 1) * W + (x + 1)] = field[y * w + x];
  }
  const val = (x, y) => f[y * W + x];
  const inside = (x, y) => val(x, y) >= threshold;

  // Segment endpoints are on cell edges between sample points. We key each edge by
  // (x, y, dir) where dir 0 = horizontal edge from (x,y) to (x+1,y), 1 = vertical from (x,y) to (x,y+1).
  const edgeKey = (x, y, dir) => (y * W + x) * 2 + dir;
  const lerpEdge = (x, y, dir) => {
    const a = val(x, y);
    const b = dir === 0 ? val(x + 1, y) : val(x, y + 1);
    let t = (threshold - a) / (b - a);
    if (!isFinite(t)) t = 0.5;
    t = Math.max(0.02, Math.min(0.98, t));
    return dir === 0 ? [x + t, y] : [x, y + t];
  };

  // next[edge] = following edge (so we can chain segments into rings). Interior is kept on the right.
  const next = new Map();
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = inside(x, y) ? 8 : 0;
      const tr = inside(x + 1, y) ? 4 : 0;
      const br = inside(x + 1, y + 1) ? 2 : 0;
      const bl = inside(x, y + 1) ? 1 : 0;
      const c = tl | tr | br | bl;
      if (c === 0 || c === 15) continue;
      const T = edgeKey(x, y, 0);
      const B = edgeKey(x, y + 1, 0);
      const L = edgeKey(x, y, 1);
      const R = edgeKey(x + 1, y, 1);
      // Directed segments (from, to) chosen so inside is on the left when walking.
      const add = (a, b) => next.set(a, b);
      switch (c) {
        case 1: add(L, B); break;
        case 2: add(B, R); break;
        case 3: add(L, R); break;
        case 4: add(R, T); break;
        case 5: { // saddle
          const centre = (val(x, y) + val(x + 1, y) + val(x, y + 1) + val(x + 1, y + 1)) / 4;
          if (centre >= threshold) { add(L, T); add(R, B); } else { add(L, B); add(R, T); }
          break;
        }
        case 6: add(B, T); break;
        case 7: add(L, T); break;
        case 8: add(T, L); break;
        case 9: add(T, B); break;
        case 10: {
          const centre = (val(x, y) + val(x + 1, y) + val(x, y + 1) + val(x + 1, y + 1)) / 4;
          if (centre >= threshold) { add(T, R); add(B, L); } else { add(T, L); add(B, R); }
          break;
        }
        case 11: add(T, R); break;
        case 12: add(R, L); break;
        case 13: add(R, B); break;
        case 14: add(B, L); break;
      }
    }
  }

  const rings = [];
  const visited = new Set();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const ring = [];
    let e = start;
    let guard = 0;
    while (e !== undefined && !visited.has(e) && guard++ < 1e6) {
      visited.add(e);
      const dir = e & 1;
      const idx = e >> 1;
      const x = idx % W;
      const y = (idx - x) / W;
      const p = lerpEdge(x, y, dir);
      ring.push([p[0] - 1 + 0.5, p[1] - 1 + 0.5]); // unpad, and shift to cell-centre coordinates
      e = next.get(e);
    }
    if (ring.length > 2) rings.push(ring);
  }
  return rings;
}

// Build a Path2D from rings, in map pixels, using smooth quadratic curves through midpoints.
export function ringsToPath(rings, cellSize, smooth = true) {
  const path = new Path2D();
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    if (!smooth || n < 6) {
      path.moveTo(ring[0][0] * cellSize, ring[0][1] * cellSize);
      for (let i = 1; i < n; i++) path.lineTo(ring[i][0] * cellSize, ring[i][1] * cellSize);
      path.closePath();
      continue;
    }
    const mid = (a, b) => [((a[0] + b[0]) / 2) * cellSize, ((a[1] + b[1]) / 2) * cellSize];
    let m = mid(ring[n - 1], ring[0]);
    path.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      m = mid(p, q);
      path.quadraticCurveTo(p[0] * cellSize, p[1] * cellSize, m[0], m[1]);
    }
    path.closePath();
  }
  return path;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
