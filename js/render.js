// Rendering. Terrain is prepared once into static vector/raster pieces (coast path, biome image,
// relief glyph list) and can then be painted into any context: the full-map base cache, a crisp
// viewport "detail" tile at high zoom, or the PNG export. Nations are drawn live as smooth paths.
import { traceContours, ringsToPath, ringArea } from './contour.js';
import { BIOMES, SEA_LEVEL, HILL_LEVEL, MOUNTAIN_LEVEL } from './terrain.js';
import { makeRng } from './rng.js';
import { shortName } from './names.js';

export const OCEAN = '#4c74b0';
const LABEL_FONT = 'Georgia, "Times New Roman", "Palatino Linotype", serif';

export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function darken(hex, f = 0.6) {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c * f));
  return `rgb(${r},${g},${b})`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------- Static terrain preparation ----------
export function prepareTerrain(terrain, cellSize) {
  const { width, height, land, biome, elevation: h, rivers } = terrain;
  const mapW = width * cellSize;
  const mapH = height * cellSize;

  const rings = traceContours(h, width, height, SEA_LEVEL);
  const landPath = ringsToPath(rings, cellSize, true);

  // Biome colours at grid resolution with hillshade baked in; upscaled with smoothing when drawn.
  const biomeImg = makeCanvas(width, height);
  const bctx = biomeImg.getContext('2d');
  const img = bctx.createImageData(width, height);
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let col;
      if (land[i]) col = hexToRgb(BIOMES[biome[i]].color);
      else {
        let found = null;
        for (let k = 0; k < 8 && found === null; k++) {
          const nx = x + DX[k];
          const ny = y + DY[k];
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && land[ny * width + nx]) found = biome[ny * width + nx];
        }
        col = hexToRgb(BIOMES[found ?? 4].color);
      }
      const hl = h[Math.max(0, x - 1) + y * width];
      const hr = h[Math.min(width - 1, x + 1) + y * width];
      const hu = h[x + Math.max(0, y - 1) * width];
      const hd = h[x + Math.min(height - 1, y + 1) * width];
      const s = land[i] ? Math.max(-1, Math.min(1, (hl - hr + (hu - hd)) * 6)) : 0;
      const f = 1 + s * 0.35 + (land[i] ? (h[i] - SEA_LEVEL) * 0.25 : 0);
      img.data[i * 4] = Math.min(255, col[0] * f);
      img.data[i * 4 + 1] = Math.min(255, col[1] * f);
      img.data[i * 4 + 2] = Math.min(255, col[2] * f);
      img.data[i * 4 + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  // Relief glyph list (deterministic per seed).
  const rng = makeRng(terrain.seed + ':relief');
  const glyphs = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = (y / 2) % 2 === 0 ? 0 : 1; x < width; x += 2) {
      const i = y * width + x;
      if (!land[i] || h[i] >= HILL_LEVEL) continue;
      const b = biome[i];
      const px = (x + 0.5 + (rng() - 0.5) * 0.9) * cellSize;
      const py = (y + 0.5 + (rng() - 0.5) * 0.9) * cellSize;
      const s = cellSize * 0.9;
      if (b === 9 || b === 8) {
        if (rng() < 0.55) glyphs.push({ t: 'conifer', x: px, y: py, s: s * 1.1 });
      } else if (b === 6 || b === 7 || b === 5) {
        if (rng() < 0.4) glyphs.push({ t: 'broadleaf', x: px, y: py, s });
      } else if (b === 12) {
        if (rng() < 0.4) glyphs.push({ t: 'reeds', x: px, y: py, s });
      } else if (b === 1 && rng() < 0.05) {
        glyphs.push({ t: 'dune', x: px, y: py, s: s * 1.3 });
      }
    }
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = (y / 2) % 2 === 0 ? 0 : 1; x < width; x += 2) {
      const i = y * width + x;
      if (!land[i] || h[i] < HILL_LEVEL) continue;
      const px = (x + 0.5 + (rng() - 0.5) * 0.6) * cellSize;
      const py = (y + 0.7) * cellSize;
      if (h[i] >= MOUNTAIN_LEVEL) {
        const t = (h[i] - MOUNTAIN_LEVEL) / (1 - MOUNTAIN_LEVEL);
        glyphs.push({ t: 'mountain', x: px, y: py, w: cellSize * (2.2 + t * 2.4), h: cellSize * (1.8 + t * 2.6), snow: t > 0.45, peak: (rng() - 0.5) * 0.25 });
      } else if (rng() < 0.85) {
        glyphs.push({ t: 'hill', x: px, y: py, w: cellSize * (1.5 + rng() * 0.8) });
      }
    }
  }

  const riverPaths = rivers.map((r) => buildRiverSegments(r, cellSize));
  return { terrain, cellSize, mapW, mapH, landPath, rings, biomeImg, glyphs, riverPaths };
}

// Paint the terrain in map units into ctx (already transformed). bounds = {x0,y0,x1,y1} in map units.
export function paintTerrain(ctx, st, bounds, opts = {}) {
  const { mapW, mapH, landPath, biomeImg, glyphs, cellSize, terrain } = st;
  const b = bounds || { x0: 0, y0: 0, x1: mapW, y1: mapH };
  ctx.save();
  ctx.fillStyle = OCEAN;
  ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  const grad = ctx.createRadialGradient(mapW / 2, mapH / 2, mapH * 0.2, mapW / 2, mapH / 2, mapW * 0.75);
  grad.addColorStop(0, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(0,0,40,0.18)');
  ctx.fillStyle = grad;
  ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);

  ctx.lineJoin = 'round';
  for (const [w, c] of [[cellSize * 7, 'rgba(255,255,255,0.10)'], [cellSize * 4, 'rgba(255,255,255,0.14)'], [cellSize * 2, 'rgba(255,255,255,0.22)']]) {
    ctx.lineWidth = w;
    ctx.strokeStyle = c;
    ctx.stroke(landPath);
  }

  ctx.save();
  ctx.clip(landPath);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(biomeImg, 0, 0, terrain.width, terrain.height, -cellSize / 2, -cellSize / 2, mapW + cellSize, mapH + cellSize);
  if (!opts.noTexture) {
    const rng = makeRng(terrain.seed + ':tex');
    ctx.globalAlpha = 0.06;
    for (let k = 0; k < (mapW * mapH) / 60; k++) {
      const x = rng() * mapW;
      const y = rng() * mapH;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      ctx.fillStyle = rng() < 0.5 ? '#000' : '#fff';
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(30,50,90,0.75)';
  ctx.lineWidth = 0.9;
  ctx.stroke(landPath);

  drawRiverSegments(ctx, st.riverPaths, false);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const pad = cellSize * 6;
  for (const g of glyphs) {
    if (g.x < b.x0 - pad || g.x > b.x1 + pad || g.y < b.y0 - pad || g.y > b.y1 + pad) continue;
    switch (g.t) {
      case 'conifer': drawConifer(ctx, g.x, g.y, g.s); break;
      case 'broadleaf': drawBroadleaf(ctx, g.x, g.y, g.s); break;
      case 'reeds': drawReeds(ctx, g.x, g.y, g.s); break;
      case 'dune': drawDune(ctx, g.x, g.y, g.s); break;
      case 'mountain': drawMountain(ctx, g.x, g.y, g.w, g.h, g.snow, g.peak); break;
      case 'hill': drawHill(ctx, g.x, g.y, g.w); break;
    }
  }
  ctx.restore();
}

export function buildTerrainCache(st, scale) {
  const canvas = makeCanvas(st.mapW * scale, st.mapH * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  paintTerrain(ctx, st, null);
  return { canvas, scale };
}

// ---------- Rivers ----------
function buildRiverSegments(river, cellSize) {
  const pts = river.points;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const w = (river.widths[Math.min(i, river.widths.length - 1)] || 0.3) * cellSize;
    const p = new Path2D();
    const a = pts[i];
    const b = pts[i + 1];
    const c = pts[i + 2] || b;
    const m1 = [((a[0] + b[0]) / 2) * cellSize, ((a[1] + b[1]) / 2) * cellSize];
    const m2 = [((b[0] + c[0]) / 2) * cellSize, ((b[1] + c[1]) / 2) * cellSize];
    if (i === 0) {
      p.moveTo(a[0] * cellSize, a[1] * cellSize);
      p.lineTo(m1[0], m1[1]);
    } else p.moveTo(m1[0], m1[1]);
    p.quadraticCurveTo(b[0] * cellSize, b[1] * cellSize, m2[0], m2[1]);
    segs.push({ p, w });
  }
  return segs;
}

function drawRiverSegments(ctx, riverPaths, highlight, only) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = highlight ? 'rgba(255,170,0,0.85)' : '#3b64ad';
  riverPaths.forEach((segs, idx) => {
    if (only && !only.has(idx)) return;
    for (const s of segs) {
      ctx.lineWidth = highlight ? s.w + 5 : s.w;
      ctx.stroke(s.p);
    }
  });
  ctx.restore();
}

// ---------- Relief glyphs ----------
function drawMountain(ctx, x, y, w, hgt, snow, peakOff) {
  const peakX = x + peakOff * w;
  const top = y - hgt;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.lineTo(peakX - w * 0.15, y - hgt * 0.55);
  ctx.lineTo(peakX, top);
  ctx.lineTo(peakX + w * 0.12, y - hgt * 0.6);
  ctx.lineTo(x + w / 2, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(245,240,228,0.95)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(peakX, top);
  ctx.lineTo(peakX + w * 0.12, y - hgt * 0.6);
  ctx.lineTo(x + w / 2, y);
  ctx.lineTo(peakX + w * 0.05, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(90,80,70,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.lineTo(peakX - w * 0.15, y - hgt * 0.55);
  ctx.lineTo(peakX, top);
  ctx.lineTo(peakX + w * 0.12, y - hgt * 0.6);
  ctx.lineTo(x + w / 2, y);
  ctx.strokeStyle = 'rgba(60,50,45,0.9)';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  if (snow) {
    ctx.beginPath();
    ctx.moveTo(peakX - w * 0.1, y - hgt * 0.66);
    ctx.lineTo(peakX, top);
    ctx.lineTo(peakX + w * 0.09, y - hgt * 0.68);
    ctx.lineTo(peakX + w * 0.03, y - hgt * 0.6);
    ctx.lineTo(peakX - w * 0.04, y - hgt * 0.64);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}
function drawHill(ctx, x, y, w) {
  ctx.beginPath();
  ctx.arc(x, y, w / 2, Math.PI, 0);
  ctx.fillStyle = 'rgba(240,232,210,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,60,50,0.8)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, w / 2, -0.35, 0);
  ctx.lineTo(x + w * 0.15, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(90,80,70,0.35)';
  ctx.fill();
}
function drawConifer(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.45, y);
  ctx.lineTo(x - s * 0.45, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(40,90,50,0.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,50,30,0.9)';
  ctx.lineWidth = 0.4;
  ctx.stroke();
}
function drawBroadleaf(ctx, x, y, s) {
  ctx.beginPath();
  ctx.arc(x, y - s * 0.45, s * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(60,140,60,0.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,80,30,0.9)';
  ctx.lineWidth = 0.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - s * 0.3);
  ctx.strokeStyle = 'rgba(70,50,30,0.9)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
}
function drawReeds(ctx, x, y, s) {
  ctx.strokeStyle = 'rgba(20,90,50,0.8)';
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.3, y);
  ctx.lineTo(x - s * 0.2, y - s * 0.7);
  ctx.moveTo(x, y);
  ctx.lineTo(x + s * 0.05, y - s * 0.9);
  ctx.moveTo(x + s * 0.3, y);
  ctx.lineTo(x + s * 0.35, y - s * 0.6);
  ctx.stroke();
}
function drawDune(ctx, x, y, s) {
  ctx.strokeStyle = 'rgba(160,130,70,0.7)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(x - s / 2, y);
  ctx.quadraticCurveTo(x, y - s * 0.5, x + s / 2, y);
  ctx.stroke();
}

// ---------- Nations ----------
export function buildNationShapes(state) {
  const { terrain, cellSize, nations, owner } = state;
  const { width, height } = terrain;
  const field = new Float32Array(width * height);
  const shapes = [];
  const labels = [];
  for (const nat of nations) {
    let count = 0;
    for (let i = 0; i < field.length; i++) {
      const v = owner[i] === nat.id ? 1 : 0;
      field[i] = v;
      count += v;
    }
    if (!count) continue;
    const rings = traceContours(field, width, height, 0.5);
    const path = ringsToPath(rings, cellSize, true);
    shapes.push({ path, color: nat.color });
    let best = null;
    let bestA = 0;
    for (const r of rings) {
      const a = Math.abs(ringArea(r));
      if (a > bestA) {
        bestA = a;
        best = r;
      }
    }
    if (best) {
      const c = interiorPoint(best, field, width, height);
      labels.push({ x: c[0] * cellSize, y: c[1] * cellSize, size: Math.max(9, Math.min(34, Math.sqrt(bestA) * 0.55)), name: nat.name, color: nat.color });
    }
  }
  return { shapes, labels };
}

export function drawNations(ctx, nationShapes, zoom = 1) {
  const k = Math.min(1, 2 / zoom); // strokes stop growing past 2x zoom
  ctx.save();
  ctx.lineJoin = 'round';
  for (const s of nationShapes.shapes) {
    ctx.fillStyle = rgba(s.color, 0.38);
    ctx.fill(s.path);
    ctx.setLineDash([]);
    ctx.strokeStyle = rgba(s.color, 0.9);
    ctx.lineWidth = 1.6 * k;
    ctx.stroke(s.path);
    ctx.strokeStyle = darken(s.color, 0.45);
    ctx.lineWidth = 0.7 * k;
    ctx.setLineDash([3 * k, 2 * k]);
    ctx.stroke(s.path);
  }
  ctx.restore();
}

function interiorPoint(ring, field, width, height) {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  const cx = sx / ring.length;
  const cy = sy / ring.length;
  const inside = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    return ix >= 0 && iy >= 0 && ix < width && iy < height && field[iy * width + ix] >= 0.5;
  };
  if (inside(cx, cy)) return [cx, cy];
  for (let r = 1; r < 60; r++) {
    for (let a = 0; a < 16; a++) {
      const x = cx + Math.cos((a / 16) * Math.PI * 2) * r;
      const y = cy + Math.sin((a / 16) * Math.PI * 2) * r;
      if (inside(x, y)) return [x, y];
    }
  }
  return [cx, cy];
}

// ---------- Live layers ----------
export function drawLabels(ctx, state, nationShapes, zoom) {
  const { burgs } = state;
  // Labels grow with zoom only up to a point, then stay a constant screen size.
  const k = Math.min(1, 2.2 / zoom);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of nationShapes.labels) {
    const name = shortName(l.name).toUpperCase();
    const size = l.size * k;
    ctx.font = `600 ${size}px ${LABEL_FONT}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.28;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.strokeText(name, l.x, l.y);
    ctx.fillStyle = darken(l.color, 0.4);
    ctx.fillText(name, l.x, l.y);
  }
  const cs = state.cellSize;
  const showTowns = zoom >= 1.4;
  const kb = Math.min(1, 3 / zoom);
  for (const b of burgs) {
    const x = b.x * cs;
    const y = b.y * cs;
    if (!b.capital && !showTowns) continue;
    const r = (b.capital ? 3.2 : 1.9) * kb;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = b.capital ? '#ffefc0' : '#fff';
    ctx.fill();
    ctx.lineWidth = (b.capital ? 1.2 : 0.8) * kb;
    ctx.strokeStyle = '#222';
    ctx.stroke();
    if (b.capital || zoom >= 2.2) {
      const fs = (b.capital ? 7.5 : 5.5) * kb;
      ctx.font = `${b.capital ? 'bold ' : ''}${fs}px ${LABEL_FONT}`;
      ctx.textAlign = 'left';
      ctx.lineWidth = 2 * kb;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.strokeText(b.name, x + r + 1.5 * kb, y);
      ctx.fillStyle = '#1b1b1b';
      ctx.fillText(b.name, x + r + 1.5 * kb, y);
      ctx.textAlign = 'center';
    }
  }
  ctx.restore();
}

export function drawSelectedLandmarks(ctx, state, st) {
  const { terrain, cellSize, selectedRivers, selectedRanges } = state;
  if (selectedRivers.size) drawRiverSegments(ctx, st.riverPaths, true, selectedRivers);
  if (selectedRanges.size) {
    const { width, height } = terrain;
    const field = new Float32Array(width * height);
    for (const id of selectedRanges) for (const c of terrain.ranges.list[id].cells) field[c] = 1;
    const path = ringsToPath(traceContours(field, width, height, 0.5), cellSize, true);
    ctx.save();
    ctx.fillStyle = 'rgba(255,170,0,0.28)';
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(255,140,0,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
    ctx.restore();
  }
}

export function drawBoundaries(ctx, state, zoom = 1) {
  const k = Math.min(1, 2 / zoom);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const b of state.boundaries) {
    if (b.points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(b.points[0][0], b.points[0][1]);
    for (let i = 1; i < b.points.length; i++) ctx.lineTo(b.points[i][0], b.points[i][1]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 3.2 * k;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.strokeStyle = '#5a2d0c';
    ctx.lineWidth = 1.4 * k;
    ctx.setLineDash([4 * k, 3 * k]);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawResources(ctx, res) {
  if (!res.visible) return;
  ctx.save();
  ctx.globalAlpha = res.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const it of res.items) {
    if (it.type === 'stroke') drawStroke(ctx, it);
    else if (it.type === 'shape') drawShape(ctx, it.kind, it.x, it.y, it.size, it.color);
  }
  ctx.restore();
}

export function drawStroke(ctx, s) {
  const p = s.points;
  if (!p.length) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  if (p.length === 1) {
    ctx.arc(p[0][0], p[0][1], s.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    return;
  }
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2;
    const my = (p[i][1] + p[i + 1][1]) / 2;
    ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
  }
  const l = p[p.length - 1];
  ctx.lineTo(l[0], l[1]);
  ctx.stroke();
}

export const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'hexagon', 'cross', 'ring', 'pentagon', 'drop'];

export function drawShape(ctx, kind, x, y, size, color) {
  const r = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = Math.max(0.6, size * 0.08);
  ctx.beginPath();
  switch (kind) {
    case 'circle':
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      break;
    case 'ring':
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.moveTo(r * 0.5, 0);
      ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2, true);
      break;
    case 'square':
      ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
      break;
    case 'triangle':
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.95, r * 0.75);
      ctx.lineTo(-r * 0.95, r * 0.75);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.75, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.75, 0);
      ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? r : r * 0.45;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    case 'pentagon':
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      break;
    case 'cross': {
      const t = r * 0.32;
      ctx.moveTo(-t, -r);
      ctx.lineTo(t, -r);
      ctx.lineTo(t, -t);
      ctx.lineTo(r, -t);
      ctx.lineTo(r, t);
      ctx.lineTo(t, t);
      ctx.lineTo(t, r);
      ctx.lineTo(-t, r);
      ctx.lineTo(-t, t);
      ctx.lineTo(-r, t);
      ctx.lineTo(-r, -t);
      ctx.lineTo(-t, -t);
      ctx.closePath();
      break;
    }
    case 'drop':
      ctx.moveTo(0, -r);
      ctx.bezierCurveTo(r * 0.9, r * 0.1, r * 0.6, r, 0, r);
      ctx.bezierCurveTo(-r * 0.6, r, -r * 0.9, r * 0.1, 0, -r);
      ctx.closePath();
      break;
  }
  ctx.fill('evenodd');
  ctx.stroke();
  ctx.restore();
}
