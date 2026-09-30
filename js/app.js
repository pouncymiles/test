// Entry point: wires state, rendering, pointer input and the UI together.
import * as S from './state.js';
import { prepareTerrain, paintTerrain, buildTerrainCache, buildNationShapes, drawNations, drawLabels, drawSelectedLandmarks, drawBoundaries, drawResources, drawStroke, drawShape, SHAPES, rgba } from './render.js';
import { saveLocal, loadLocal, clearLocal, serialize, deserialize, downloadBlob } from './storage.js';
import { randomSeed, makeRng } from './rng.js';
import { autoNations } from './terrain.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const PALETTE = ['#000000', '#ffffff', '#e6194b', '#f58231', '#ffe119', '#3cb44b', '#42d4f4', '#4363d8', '#911eb4', '#f032e6', '#9a6324', '#7f7f7f'];

const state = S.createState();
const canvas = $('#map');
const ctx = canvas.getContext('2d');
const stage = $('#stage');

const ui = {
  mode: 'map', // 'map' | 'resources'
  mapTool: 'fill',
  resTool: 'pen',
  brushSize: 4,
  penWidth: 3,
  color: '#e6194b',
  shape: 'circle',
  shapeSize: 14,
  panelCollapsed: false,
};

let terrainStatic = null; // prepared vector/raster pieces
let terrainCache = null; // full-map raster used at low zoom
let detail = null; // crisp viewport tile used at high zoom
let detailTimer = null;
let nationShapes = null;
const DETAIL_ZOOM = 2.2;
let cacheScale = Math.min(2, window.devicePixelRatio || 1);
let dirty = false;
let brushPreview = null; // {x, y} in map px while hovering with brush
let liveOverlay = []; // cells painted during a brush stroke: [cellIdx, nationId]
let op = null; // current pointer operation
let linePoints = []; // straight-line tool vertices (map px)
let lineCursor = null;
let lastTap = { t: 0, x: 0, y: 0 };
const pointers = new Map();
let gesture = null;
let spaceHeld = false;
let saveTimer = null;

const mapW = () => S.GRID_W * state.cellSize;
const mapH = () => S.GRID_H * state.cellSize;

// ---------- Rendering ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  requestDraw();
}

function requestDraw() {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(draw);
}

function draw() {
  dirty = false;
  if (!terrainCache) return;
  const dpr = window.devicePixelRatio || 1;
  const { x, y, zoom } = state.view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#17202f';
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.translate(x, y);
  ctx.scale(zoom, zoom);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const useDetail = detail && zoom > DETAIL_ZOOM && detailCovers();
  if (useDetail) ctx.drawImage(detail.canvas, detail.x0, detail.y0, detail.w, detail.h);
  else ctx.drawImage(terrainCache.canvas, 0, 0, mapW(), mapH());
  if (zoom > DETAIL_ZOOM && (!detail || !detailCovers() || detail.zoom !== zoom)) scheduleDetail();
  if (nationShapes) drawNations(ctx, nationShapes, zoom);
  // Cells painted by the brush since the last cache rebuild.
  if (liveOverlay.length) {
    const cs = state.cellSize;
    for (const [c, id] of liveOverlay) {
      const nat = state.nations.find((n) => n.id === id);
      ctx.fillStyle = nat ? rgba(nat.color, 0.45) : 'rgba(255,255,255,0.5)';
      const cx = c % S.GRID_W;
      const cy = (c - cx) / S.GRID_W;
      ctx.fillRect(cx * cs, cy * cs, cs, cs);
    }
  }
  if (ui.mode === 'map') drawSelectedLandmarks(ctx, state, terrainStatic);
  drawBoundaries(ctx, state, zoom);
  if (nationShapes) drawLabels(ctx, state, nationShapes, zoom);
  drawResources(ctx, state.resources);

  // Previews
  if (op && op.kind === 'pen' && op.item) {
    ctx.save();
    ctx.globalAlpha = state.resources.opacity;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawStroke(ctx, op.item);
    ctx.restore();
  }
  if (op && op.kind === 'freehand' && op.points.length > 1) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#5a2d0c';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(op.points[0][0], op.points[0][1]);
    for (const p of op.points) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    ctx.restore();
  }
  if (ui.mode === 'map' && ui.mapTool === 'lines' && linePoints.length) {
    ctx.save();
    ctx.strokeStyle = '#5a2d0c';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(linePoints[0][0], linePoints[0][1]);
    for (const p of linePoints) ctx.lineTo(p[0], p[1]);
    if (lineCursor) ctx.lineTo(lineCursor[0], lineCursor[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i < linePoints.length; i++) {
      const p = linePoints[i];
      ctx.beginPath();
      ctx.arc(p[0], p[1], (i === 0 ? 5 : 3) / zoom, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ffb300' : '#fff';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  if (brushPreview && ui.mode === 'map' && ui.mapTool === 'brush') {
    ctx.beginPath();
    ctx.arc(brushPreview.x, brushPreview.y, ui.brushSize * state.cellSize, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1 / zoom;
    ctx.stroke();
  }
  if (brushPreview && ui.mode === 'resources' && ui.resTool === 'shape') {
    ctx.save();
    ctx.globalAlpha = 0.6;
    drawShape(ctx, ui.shape, brushPreview.x, brushPreview.y, ui.shapeSize, ui.color);
    ctx.restore();
  }
}

function rebuildTerrain() {
  terrainStatic = prepareTerrain(state.terrain, state.cellSize);
  terrainCache = buildTerrainCache(terrainStatic, cacheScale);
  detail = null;
  rebuildNations();
}
function rebuildNations() {
  nationShapes = buildNationShapes(state);
  liveOverlay = [];
  requestDraw();
}

// Visible map rectangle in map units.
function visibleRect() {
  const r = stage.getBoundingClientRect();
  const v = state.view;
  return { x0: -v.x / v.zoom, y0: -v.y / v.zoom, x1: (r.width - v.x) / v.zoom, y1: (r.height - v.y) / v.zoom };
}
function detailCovers() {
  const vr = visibleRect();
  return vr.x0 >= detail.x0 - 0.5 && vr.y0 >= detail.y0 - 0.5 && vr.x1 <= detail.x0 + detail.w + 0.5 && vr.y1 <= detail.y0 + detail.h + 0.5;
}
function scheduleDetail() {
  if (detailTimer) return;
  detailTimer = setTimeout(() => {
    detailTimer = null;
    buildDetail();
  }, 120);
}
function buildDetail() {
  const zoom = state.view.zoom;
  if (zoom <= DETAIL_ZOOM || !terrainStatic) return;
  const vr = visibleRect();
  const vw = vr.x1 - vr.x0;
  const vh = vr.y1 - vr.y0;
  const x0 = Math.max(0, vr.x0 - vw * 0.3);
  const y0 = Math.max(0, vr.y0 - vh * 0.3);
  const x1 = Math.min(mapW(), vr.x1 + vw * 0.3);
  const y1 = Math.min(mapH(), vr.y1 + vh * 0.3);
  const dpr = window.devicePixelRatio || 1;
  let scale = zoom * dpr;
  const maxPx = 4096;
  scale = Math.min(scale, maxPx / (x1 - x0), maxPx / (y1 - y0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil((x1 - x0) * scale));
  c.height = Math.max(1, Math.ceil((y1 - y0) * scale));
  const cx = c.getContext('2d');
  cx.scale(scale, scale);
  cx.translate(-x0, -y0);
  paintTerrain(cx, terrainStatic, { x0, y0, x1, y1 }, { noTexture: true });
  detail = { canvas: c, x0, y0, w: x1 - x0, h: y1 - y0, zoom };
  requestDraw();
}

S.onChange(state, (what) => {
  if (what === 'terrain') {
    rebuildTerrain();
    renderNationList();
  } else if (what === 'nations') {
    rebuildNations();
    renderNationList();
  } else if (what === 'nations-light') {
    requestDraw();
  } else {
    requestDraw();
  }
  scheduleSave();
});

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveLocal(state), 700);
}

// ---------- View helpers ----------
function screenToMap(sx, sy) {
  const r = canvas.getBoundingClientRect();
  const x = sx - r.left;
  const y = sy - r.top;
  return [(x - state.view.x) / state.view.zoom, (y - state.view.y) / state.view.zoom];
}
function clampView() {
  const v = state.view;
  v.zoom = Math.max(0.3, Math.min(8, v.zoom));
  const r = stage.getBoundingClientRect();
  const w = mapW() * v.zoom;
  const h = mapH() * v.zoom;
  const margin = 80;
  v.x = Math.max(Math.min(v.x, r.width - margin), margin - w);
  v.y = Math.max(Math.min(v.y, r.height - margin), margin - h);
}
function zoomAt(factor, sx, sy) {
  const r = canvas.getBoundingClientRect();
  const px = sx - r.left;
  const py = sy - r.top;
  const v = state.view;
  const nz = Math.max(0.3, Math.min(8, v.zoom * factor));
  const k = nz / v.zoom;
  v.x = px - (px - v.x) * k;
  v.y = py - (py - v.y) * k;
  v.zoom = nz;
  clampView();
  requestDraw();
}
function fitView() {
  const r = stage.getBoundingClientRect();
  // On phones the tool sheet overlays the bottom of the stage; fit into the part that stays visible.
  const overlay = window.matchMedia('(max-width: 820px)').matches && !ui.panelCollapsed ? $('#panel').offsetHeight : 0;
  const availH = Math.max(120, r.height - overlay);
  const z = Math.min(r.width / mapW(), availH / mapH()) * 0.96;
  state.view.zoom = z;
  state.view.x = (r.width - mapW() * z) / 2;
  state.view.y = (availH - mapH() * z) / 2;
  requestDraw();
}

// ---------- Pointer input ----------
function currentTool() {
  return ui.mode === 'map' ? ui.mapTool : ui.resTool;
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  e.preventDefault();
  if (pointers.size === 2) {
    cancelOp();
    const [a, b] = [...pointers.values()];
    gesture = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      view: { ...state.view },
    };
    return;
  }
  if (pointers.size > 2 || gesture) return;
  const wantPan = e.button === 1 || e.button === 2 || spaceHeld || currentTool() === 'pan';
  if (wantPan) {
    op = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
    canvas.style.cursor = 'grabbing';
    return;
  }
  const [mx, my] = screenToMap(e.clientX, e.clientY);
  startTool(mx, my, e);
}

function onPointerMove(e) {
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (gesture && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const k = Math.max(0.3, Math.min(8, gesture.view.zoom * (dist / gesture.dist))) / gesture.view.zoom;
    const r = canvas.getBoundingClientRect();
    const gx = gesture.mid[0] - r.left;
    const gy = gesture.mid[1] - r.top;
    state.view.zoom = gesture.view.zoom * k;
    state.view.x = gx - (gx - gesture.view.x) * k + (mid[0] - gesture.mid[0]);
    state.view.y = gy - (gy - gesture.view.y) * k + (mid[1] - gesture.mid[1]);
    clampView();
    requestDraw();
    return;
  }
  const [mx, my] = screenToMap(e.clientX, e.clientY);
  if (op) {
    if (op.kind === 'pan') {
      state.view.x = op.vx + (e.clientX - op.sx);
      state.view.y = op.vy + (e.clientY - op.sy);
      clampView();
      requestDraw();
    } else moveTool(mx, my, e);
    return;
  }
  // Hover previews
  const tool = currentTool();
  if ((ui.mode === 'map' && tool === 'brush') || (ui.mode === 'resources' && tool === 'shape')) {
    brushPreview = { x: mx, y: my };
    requestDraw();
  } else if (brushPreview) {
    brushPreview = null;
    requestDraw();
  }
  if (ui.mode === 'map' && tool === 'lines' && linePoints.length) {
    lineCursor = [mx, my];
    requestDraw();
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (gesture) {
    if (pointers.size < 2) gesture = null;
    if (pointers.size === 0) scheduleSave();
    return;
  }
  if (!op) return;
  const [mx, my] = screenToMap(e.clientX, e.clientY);
  if (op.kind === 'pan') {
    op = null;
    canvas.style.cursor = '';
    scheduleSave();
    return;
  }
  endTool(mx, my, e);
  op = null;
  brushPreview = null;
  requestDraw();
}

function cancelOp() {
  if (!op) return;
  if (op.kind === 'brush' && op.began) rebuildNations();
  op = null;
  brushPreview = null;
  requestDraw();
}

function startTool(mx, my, e) {
  const tool = currentTool();
  const tolerance = 8 / state.view.zoom;
  if (ui.mode === 'map') {
    switch (tool) {
      case 'fill':
      case 'landmark':
      case 'erase-boundary':
      case 'lines':
        op = { kind: 'tap', tool, sx: e.clientX, sy: e.clientY, mx, my };
        break;
      case 'brush':
        op = { kind: 'brush', began: false, nation: state.activeNation };
        brushAt(mx, my);
        break;
      case 'freehand':
        op = { kind: 'freehand', points: [[mx, my]] };
        break;
    }
  } else {
    switch (tool) {
      case 'pen':
        op = { kind: 'pen', item: { type: 'stroke', color: ui.color, width: ui.penWidth, points: [[mx, my]] } };
        break;
      case 'shape':
        op = { kind: 'tap', tool, sx: e.clientX, sy: e.clientY, mx, my };
        break;
      case 'eraser':
        op = { kind: 'eraser' };
        S.eraseResourceNear(state, mx, my, tolerance);
        break;
    }
  }
  void tolerance;
}

function brushAt(mx, my) {
  const nation = op.nation;
  const before = liveOverlay.length;
  const cs = state.cellSize;
  const r = ui.brushSize;
  const cx = mx / cs;
  const cy = my / cs;
  const t = state.terrain;
  if (!op.began) {
    S.pushUndo(state);
    op.began = true;
  }
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(S.GRID_H - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(S.GRID_W - 1, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const i = y * S.GRID_W + x;
      if (!t.land[i] || state.owner[i] === nation) continue;
      state.owner[i] = nation;
      liveOverlay.push([i, nation]);
    }
  }
  brushPreview = { x: mx, y: my };
  if (liveOverlay.length !== before || true) requestDraw();
}

function moveTool(mx, my, e) {
  switch (op.kind) {
    case 'brush':
      brushAt(mx, my);
      break;
    case 'freehand': {
      const last = op.points[op.points.length - 1];
      if (Math.hypot(last[0] - mx, last[1] - my) > 1.5 / state.view.zoom) op.points.push([mx, my]);
      requestDraw();
      break;
    }
    case 'pen': {
      const pts = op.item.points;
      const last = pts[pts.length - 1];
      if (Math.hypot(last[0] - mx, last[1] - my) > 1 / state.view.zoom) pts.push([mx, my]);
      requestDraw();
      break;
    }
    case 'eraser':
      S.eraseResourceNear(state, mx, my, 8 / state.view.zoom);
      break;
    case 'tap':
      // A tap that moves far becomes a drag-pan for convenience on touch.
      if (Math.hypot(e.clientX - op.sx, e.clientY - op.sy) > 12 && op.tool !== 'lines') {
        op = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
      }
      break;
  }
}

function endTool(mx, my, e) {
  const tol = 10 / state.view.zoom;
  switch (op.kind) {
    case 'brush':
      if (op.began) {
        rebuildNations();
        S.emit(state, 'nations-light');
        scheduleSave();
      }
      break;
    case 'freehand':
      if (op.points.length > 1) S.addBoundary(state, simplify(op.points, 0.8 / state.view.zoom));
      break;
    case 'pen':
      S.addResource(state, op.item);
      break;
    case 'tap': {
      if (Math.hypot(e.clientX - op.sx, e.clientY - op.sy) > 12) break;
      if (op.tool === 'fill') {
        const c = S.cellAt(state, mx, my);
        if (c >= 0 && state.terrain.land[c]) S.fillRegion(state, c, state.activeNation);
        else setHint('Fill only works on land. Tap inside a landmass.', true);
      } else if (op.tool === 'landmark') {
        const river = S.riverNear(state, mx, my, tol);
        if (river >= 0) S.toggleRiver(state, river);
        else {
          const range = S.rangeAt(state, mx, my);
          if (range >= 0) S.toggleRange(state, range);
          else setHint('No river or mountain range here. Tap closer to a blue river or a mountain glyph.', true);
        }
      } else if (op.tool === 'erase-boundary') {
        if (!S.removeBoundaryNear(state, mx, my, tol)) setHint('Tap on a dashed boundary line to remove it.', true);
      } else if (op.tool === 'lines') {
        handleLineTap(mx, my, e);
      } else if (op.tool === 'shape') {
        S.addResource(state, { type: 'shape', kind: ui.shape, color: ui.color, x: mx, y: my, size: ui.shapeSize });
      }
      break;
    }
  }
}

function handleLineTap(mx, my, e) {
  const now = Date.now();
  const isDouble = now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 20;
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (isDouble) {
    finishLine(false);
    return;
  }
  if (linePoints.length >= 3 && Math.hypot(linePoints[0][0] - mx, linePoints[0][1] - my) < 12 / state.view.zoom) {
    finishLine(true);
    return;
  }
  linePoints.push([mx, my]);
  lineCursor = null;
  updateLinebar();
  requestDraw();
}
function finishLine(close) {
  if (linePoints.length >= 2) {
    const pts = close ? [...linePoints, linePoints[0]] : linePoints;
    S.addBoundary(state, pts);
  }
  linePoints = [];
  lineCursor = null;
  updateLinebar();
  requestDraw();
}
function cancelLine() {
  linePoints = [];
  lineCursor = null;
  updateLinebar();
  requestDraw();
}
function updateLinebar() {
  const show = ui.mode === 'map' && ui.mapTool === 'lines' && linePoints.length > 0;
  $('#linebar').classList.toggle('hidden', !show);
  $('#linebar-text').textContent = `${linePoints.length} point${linePoints.length === 1 ? '' : 's'} · double-tap or Finish to end`;
}

function simplify(points, tol) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= tol) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('pointerleave', () => {
  if (!op && brushPreview) {
    brushPreview = null;
    requestDraw();
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  zoomAt(factor, e.clientX, e.clientY);
}, { passive: false });
// Safari pinch on trackpad/touch fires gesture events; block page zoom.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.target === canvas) e.preventDefault(); }, { passive: false });

window.addEventListener('keydown', (e) => {
  const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.code === 'Space' && !inField) {
    spaceHeld = true;
    canvas.classList.add('pan');
    e.preventDefault();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) S.redo(state);
    else S.undo(state);
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    S.redo(state);
  }
  if (e.key === 'Escape') {
    cancelLine();
    cancelOp();
  }
  if (e.key === 'Enter' && linePoints.length) finishLine(false);
  if (!inField && (e.key === '+' || e.key === '=')) zoomAt(1.2, stage.clientWidth / 2 + stage.getBoundingClientRect().left, stage.clientHeight / 2 + stage.getBoundingClientRect().top);
  if (!inField && e.key === '-') zoomAt(1 / 1.2, stage.clientWidth / 2 + stage.getBoundingClientRect().left, stage.clientHeight / 2 + stage.getBoundingClientRect().top);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false;
    canvas.classList.remove('pan');
  }
});
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

// ---------- UI ----------
const HINTS = {
  map: {
    pan: 'Drag to pan, pinch or scroll to zoom.',
    fill: 'Tap land to claim it for the active nation. Fill stops at coasts, orange landmarks and drawn lines.',
    brush: 'Drag to paint territory for the active nation.',
    landmark: 'Tap a river or mountain range to toggle it as a natural border (orange = active).',
    freehand: 'Drag to draw a boundary line. Then use Fill on each side.',
    lines: 'Tap to add points. Double-tap or press Finish to end; tap the first point to close.',
    'erase-boundary': 'Tap a dashed line to delete it.',
  },
  resources: {
    pan: 'Drag to pan, pinch or scroll to zoom.',
    pen: 'Draw freehand on the resource layer.',
    shape: 'Tap to place the selected shape.',
    eraser: 'Tap or drag over drawings to erase them.',
  },
};
let hintTimer = null;
function setHint(text, flash = false) {
  const el = $('#hint');
  el.textContent = text;
  if (flash) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => updateHint(), 2500);
  }
}
function updateHint() {
  setHint(HINTS[ui.mode][currentTool()] || '');
}

function setMode(mode) {
  ui.mode = mode;
  $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#panel-map').classList.toggle('hidden', mode !== 'map');
  $('#panel-resources').classList.toggle('hidden', mode !== 'resources');
  if (mode !== 'map') cancelLine();
  if (mode === 'resources' && !state.resources.visible) {
    state.resources.visible = true;
    $('#chk-res-visible').checked = true;
  }
  canvas.classList.toggle('pan', currentTool() === 'pan');
  updateHint();
  updateLinebar();
  requestDraw();
}
function setTool(tool) {
  if (ui.mode === 'map') ui.mapTool = tool;
  else ui.resTool = tool;
  const grid = ui.mode === 'map' ? '#map-tools' : '#res-tools';
  $$(`${grid} .tool`).forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#brush-field').classList.toggle('hidden', !(ui.mode === 'map' && tool === 'brush'));
  $('#pen-field').classList.toggle('hidden', !(ui.mode === 'resources' && tool === 'pen'));
  $('#shape-field').classList.toggle('hidden', !(ui.mode === 'resources' && tool === 'shape'));
  if (tool !== 'lines') cancelLine();
  canvas.classList.toggle('pan', tool === 'pan');
  updateHint();
  requestDraw();
}
$$('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$$('#map-tools .tool, #res-tools .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function renderNationList() {
  const ul = $('#nation-list');
  ul.innerHTML = '';
  const rows = [{ id: 0, name: 'Unclaimed (erase)', color: null }, ...state.nations];
  for (const n of rows) {
    const li = document.createElement('li');
    li.className = (n.id === state.activeNation ? 'active ' : '') + (n.id === 0 ? 'neutral' : '');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    if (n.id) {
      sw.style.background = n.color;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = n.color;
      inp.title = 'Change colour';
      inp.addEventListener('input', () => {
        sw.style.background = inp.value;
      });
      inp.addEventListener('change', () => S.updateNation(state, n.id, { color: inp.value }));
      inp.addEventListener('click', (e) => e.stopPropagation());
      sw.appendChild(inp);
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = n.name;
    li.append(sw, name);
    if (n.id) {
      const rename = document.createElement('button');
      rename.className = 'icon-btn';
      rename.textContent = '✏️';
      rename.title = 'Rename';
      rename.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = prompt('Nation name', n.name);
        if (v && v.trim()) S.updateNation(state, n.id, { name: v.trim() });
      });
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.textContent = '🗑';
      del.title = 'Delete nation';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete ${n.name}? Its land becomes unclaimed.`)) S.removeNation(state, n.id);
      });
      li.append(rename, del);
    }
    li.addEventListener('click', () => {
      state.activeNation = n.id;
      renderNationList();
      scheduleSave();
    });
    ul.appendChild(li);
  }
}

$('#btn-add-nation').addEventListener('click', () => {
  const nat = S.addNation(state);
  if (!nat) alert('Maximum number of nations reached.');
  else setHint(`${nat.name} added. Use Fill or Brush to give it land.`, true);
});
$('#btn-auto-nations').addEventListener('click', () => {
  if (!confirm('Replace all territories with automatically generated nations?')) return;
  S.pushUndo(state);
  const rng = makeRng(state.seed + ':nations:' + Date.now());
  const { owner, nations, burgs } = autoNations(state.terrain, Math.max(1, state.nationCount), rng);
  state.owner = owner;
  state.nations = nations;
  state.burgs = burgs;
  state.activeNation = nations[0]?.id || 1;
  S.emit(state, 'nations');
});
$('#brush-size').addEventListener('input', (e) => {
  ui.brushSize = +e.target.value;
  $('#brush-size-val').textContent = e.target.value;
});
$('#chk-same-owner').addEventListener('change', (e) => {
  state.sameOwnerOnly = e.target.checked;
  scheduleSave();
});
$('#chk-rivers').addEventListener('change', (e) => {
  state.allRiversBlock = e.target.checked;
  scheduleSave();
});
$('#chk-ranges').addEventListener('change', (e) => {
  state.allRangesBlock = e.target.checked;
  scheduleSave();
});
$('#btn-clear-selection').addEventListener('click', () => S.clearSelection(state));
$('#btn-clear-boundaries').addEventListener('click', () => {
  if (state.boundaries.length && confirm('Remove all drawn boundary lines?')) S.clearBoundaries(state);
});
$('#btn-line-finish').addEventListener('click', () => finishLine(false));
$('#btn-line-undo').addEventListener('click', () => {
  linePoints.pop();
  updateLinebar();
  requestDraw();
});
$('#btn-line-cancel').addEventListener('click', cancelLine);

// Resources UI
const pal = $('#palette');
PALETTE.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (c === ui.color ? ' active' : '');
  b.style.background = c;
  b.dataset.color = c;
  b.title = c;
  b.addEventListener('click', () => setColor(c));
  pal.appendChild(b);
});
function setColor(c) {
  ui.color = c;
  $$('#palette .swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
  $('#custom-color').value = c.length === 7 ? c : '#000000';
  requestDraw();
}
$('#custom-color').addEventListener('input', (e) => setColor(e.target.value));
$('#pen-width').addEventListener('input', (e) => {
  ui.penWidth = +e.target.value;
  $('#pen-width-val').textContent = e.target.value;
});
$('#shape-size').addEventListener('input', (e) => {
  ui.shapeSize = +e.target.value;
  $('#shape-size-val').textContent = e.target.value;
});
const sg = $('#shape-grid');
SHAPES.forEach((kind) => {
  const b = document.createElement('button');
  b.dataset.kind = kind;
  b.title = kind;
  b.className = kind === ui.shape ? 'active' : '';
  const c = document.createElement('canvas');
  c.width = 52;
  c.height = 52;
  c.style.width = '26px';
  c.style.height = '26px';
  const cx = c.getContext('2d');
  cx.scale(2, 2);
  drawShape(cx, kind, 13, 13, 20, '#555');
  b.appendChild(c);
  b.addEventListener('click', () => {
    ui.shape = kind;
    $$('#shape-grid button').forEach((x) => x.classList.toggle('active', x.dataset.kind === kind));
    requestDraw();
  });
  sg.appendChild(b);
});
$('#chk-res-visible').addEventListener('change', (e) => {
  state.resources.visible = e.target.checked;
  requestDraw();
  scheduleSave();
});
$('#res-opacity').addEventListener('input', (e) => {
  state.resources.opacity = +e.target.value / 100;
  $('#res-opacity-val').textContent = `${e.target.value}%`;
  requestDraw();
  scheduleSave();
});
$('#btn-clear-resources').addEventListener('click', () => {
  if (state.resources.items.length && confirm('Clear everything on the resource layer?')) S.clearResources(state);
});

// Top bar
$('#btn-undo').addEventListener('click', () => S.undo(state));
$('#btn-redo').addEventListener('click', () => S.redo(state));
$('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());
$('#btn-panel').addEventListener('click', () => {
  ui.panelCollapsed = !ui.panelCollapsed;
  $('#panel').classList.toggle('collapsed', ui.panelCollapsed);
});
$('#btn-zoom-in').addEventListener('click', () => zoomAt(1.25, stage.getBoundingClientRect().left + stage.clientWidth / 2, stage.getBoundingClientRect().top + stage.clientHeight / 2));
$('#btn-zoom-out').addEventListener('click', () => zoomAt(0.8, stage.getBoundingClientRect().left + stage.clientWidth / 2, stage.getBoundingClientRect().top + stage.clientHeight / 2));
$('#btn-zoom-fit').addEventListener('click', fitView);

// Generate dialog
const genDialog = $('#gen-dialog');
$('#btn-generate').addEventListener('click', () => {
  $('#gen-seed').value = state.seed;
  $('#gen-template').value = state.template;
  $('#gen-land').value = Math.round(state.landRatio * 100);
  $('#gen-land-val').textContent = `${Math.round(state.landRatio * 100)}%`;
  $('#gen-nations').value = state.nationCount;
  $('#gen-nations-val').textContent = state.nationCount;
  genDialog.showModal();
});
$('#gen-random').addEventListener('click', () => ($('#gen-seed').value = randomSeed()));
$('#gen-land').addEventListener('input', (e) => ($('#gen-land-val').textContent = `${e.target.value}%`));
$('#gen-nations').addEventListener('input', (e) => ($('#gen-nations-val').textContent = e.target.value));
genDialog.addEventListener('close', () => {
  if (genDialog.returnValue !== 'ok') return;
  generate({
    seed: $('#gen-seed').value.trim() || randomSeed(),
    template: $('#gen-template').value,
    landRatio: +$('#gen-land').value / 100,
    nationCount: +$('#gen-nations').value,
  });
});
function generate(opts) {
  setHint('Generating world…');
  cancelLine();
  setTimeout(() => {
    S.regenerate(state, opts);
    $('#chk-rivers').checked = state.allRiversBlock = false;
    $('#chk-ranges').checked = state.allRangesBlock = false;
    $('#chk-same-owner').checked = state.sameOwnerOnly = true;
    fitView();
    updateHint();
    saveLocal(state);
  }, 20);
}

// File dialog
const fileDialog = $('#file-dialog');
$('#btn-file').addEventListener('click', () => fileDialog.showModal());
$('#file-save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(serialize(state))], { type: 'application/json' });
  downloadBlob(blob, `realm-${state.seed}.json`);
  fileDialog.close();
});
$('#file-load').addEventListener('click', () => $('#file-input').click());
$('#file-help').addEventListener('click', () => {
  fileDialog.close();
  $('#help-dialog').showModal();
});
$('#file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    deserialize(state, JSON.parse(await f.text()));
    rebuildTerrain();
    renderNationList();
    $('#chk-rivers').checked = state.allRiversBlock;
    $('#chk-ranges').checked = state.allRangesBlock;
    $('#chk-same-owner').checked = state.sameOwnerOnly;
    $('#chk-res-visible').checked = state.resources.visible;
    $('#res-opacity').value = Math.round(state.resources.opacity * 100);
    fitView();
    saveLocal(state);
    fileDialog.close();
  } catch (err) {
    alert('Could not load that file: ' + err.message);
  }
  e.target.value = '';
});
$('#file-png').addEventListener('click', () => {
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = mapW() * scale;
  c.height = mapH() * scale;
  const cx = c.getContext('2d');
  cx.scale(scale, scale);
  paintTerrain(cx, terrainStatic, null);
  drawNations(cx, nationShapes);
  drawBoundaries(cx, state);
  drawLabels(cx, state, nationShapes, 2.2);
  drawResources(cx, state.resources);
  c.toBlob((blob) => downloadBlob(blob, `realm-${state.seed}.png`), 'image/png');
  fileDialog.close();
});
$('#file-reset').addEventListener('click', () => {
  if (!confirm('Discard the current map and start a new random world?')) return;
  clearLocal();
  state.resources = { visible: true, opacity: 1, items: [] };
  generate({ seed: randomSeed() });
  fileDialog.close();
});

// ---------- Boot ----------
function boot() {
  resize();
  if (!loadLocal(state)) {
    S.regenerate(state);
    fitView();
  } else {
    rebuildTerrain();
    renderNationList();
    $('#chk-rivers').checked = state.allRiversBlock;
    $('#chk-ranges').checked = state.allRangesBlock;
    $('#chk-same-owner').checked = state.sameOwnerOnly;
    $('#chk-res-visible').checked = state.resources.visible;
    $('#res-opacity').value = Math.round(state.resources.opacity * 100);
    $('#res-opacity-val').textContent = `${Math.round(state.resources.opacity * 100)}%`;
    if (!state.view || !state.view.zoom) fitView();
    else {
      clampView();
      requestDraw();
    }
  }
  setMode('map');
  setTool('fill');
  if (window.matchMedia('(max-width: 820px)').matches) {
    ui.panelCollapsed = false;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
// Expose for debugging / tests
window.__realm = { state, S, requestDraw, fitView, generate };
