// Headless smoke test: run a static server on :8123 first (see README).
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', d => d.accept());
await page.goto('http://localhost:8123/');
await page.waitForFunction(() => window.__realm && window.__realm.state.terrain);
await page.evaluate(() => { localStorage.clear(); window.__realm.generate({ seed: 'demo', template: 'continent', landRatio: 0.42, nationCount: 8 }); });
await page.waitForTimeout(800);
const st = () => page.evaluate(() => { const s = window.__realm.state; return { nations: s.nations.length, owners: [...new Set(s.owner)].length, bounds: s.boundaries.length, selR: s.selectedRivers.size, selG: s.selectedRanges.size, res: s.resources.items.length, undo: s.undo.length }; });

// Map centre in screen coords of a land cell: find a river cell and a range cell
const pts = await page.evaluate(() => {
  const s = window.__realm.state; const t = s.terrain; const v = s.view; const cs = s.cellSize;
  const r = document.querySelector('#map').getBoundingClientRect();
  const toScreen = (mx, my) => [r.left + v.x + mx * v.zoom, r.top + v.y + my * v.zoom];
  const riv = t.rivers.reduce((a, b) => (a.cells.length > b.cells.length ? a : b));
  const rp = riv.points[Math.floor(riv.points.length / 2)];
  const rg = t.ranges.list.reduce((a, b) => (a.cells.length > b.cells.length ? a : b));
  const rc = rg.cells[Math.floor(rg.cells.length / 2)];
  let landCell = -1; for (let i = 0; i < t.land.length; i++) if (t.land[i] && t.coastDist[i] > 8 && t.riverCell[i] < 0) { landCell = i; break; }
  const lx = landCell % 300, ly = (landCell - lx) / 300;
  return { river: toScreen(rp[0] * cs, rp[1] * cs), range: toScreen((rc % 300 + 0.5) * cs, (Math.floor(rc / 300) + 0.5) * cs), land: toScreen((lx + 0.5) * cs, (ly + 0.5) * cs), centre: toScreen(600, 400) };
});
console.log('points', JSON.stringify(pts));

// 1. Landmark: select river & range
await page.click('[data-tool="landmark"]');
await page.mouse.click(pts.river[0], pts.river[1]);
await page.mouse.click(pts.range[0], pts.range[1]);
console.log('after landmark', await st());
// 2. Add nation and fill
await page.click('#btn-add-nation');
await page.click('[data-tool="fill"]');
await page.mouse.click(pts.land[0], pts.land[1]);
console.log('after fill', await st());
// 3. Freehand boundary
await page.click('[data-tool="freehand"]');
await page.mouse.move(pts.centre[0] - 150, pts.centre[1] - 100);
await page.mouse.down();
for (let i = 0; i <= 20; i++) await page.mouse.move(pts.centre[0] - 150 + i * 12, pts.centre[1] - 100 + Math.sin(i / 3) * 40);
await page.mouse.up();
console.log('after freehand', await st());
// 4. Straight lines: 3 taps then Finish
await page.click('[data-tool="lines"]');
await page.mouse.click(pts.centre[0], pts.centre[1] + 50);
await page.waitForTimeout(400);
await page.mouse.click(pts.centre[0] + 80, pts.centre[1] + 120);
await page.waitForTimeout(400);
await page.mouse.click(pts.centre[0] + 160, pts.centre[1] + 60);
await page.waitForTimeout(100);
await page.click('#btn-line-finish');
console.log('after lines', await st());
// 5. Brush
await page.click('[data-tool="brush"]');
await page.mouse.move(pts.centre[0] - 60, pts.centre[1] + 20);
await page.mouse.down();
await page.mouse.move(pts.centre[0] + 20, pts.centre[1] + 40, { steps: 10 });
await page.mouse.up();
await page.screenshot({ path: 'docs/smoke-2.png' });
// 6. Resources
await page.click('[data-mode="resources"]');
await page.click('#palette .swatch[data-color="#ffe119"]');
await page.mouse.move(pts.centre[0] - 200, pts.centre[1] + 150);
await page.mouse.down();
for (let i = 0; i <= 15; i++) await page.mouse.move(pts.centre[0] - 200 + i * 8, pts.centre[1] + 150 + Math.cos(i / 2) * 20);
await page.mouse.up();
await page.click('[data-tool="shape"]');
await page.click('#shape-grid button[data-kind="star"]');
await page.click('#palette .swatch[data-color="#e6194b"]');
await page.mouse.click(pts.centre[0] + 100, pts.centre[1] - 150);
await page.click('#shape-grid button[data-kind="diamond"]');
await page.click('#palette .swatch[data-color="#4363d8"]');
await page.mouse.click(pts.centre[0] + 140, pts.centre[1] - 120);
console.log('after resources', await st());
// touch tap for shape (iOS style)
await page.touchscreen.tap(pts.centre[0] + 180, pts.centre[1] - 90);
console.log('after touch tap', await st());
await page.screenshot({ path: 'docs/smoke-3.png' });
// eraser
await page.click('[data-tool="eraser"]');
await page.mouse.click(pts.centre[0] + 180, pts.centre[1] - 90);
console.log('after eraser', await st());
// hide layer
await page.click('#chk-res-visible');
await page.screenshot({ path: 'docs/smoke-4.png' });
await page.click('#chk-res-visible');
// undo
await page.keyboard.press('Control+z');
console.log('after undo', await st());
// zoom in via wheel at centre and screenshot detail
await page.mouse.move(pts.centre[0], pts.centre[1]);
for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -300);
await page.waitForTimeout(300);
await page.screenshot({ path: 'docs/smoke-5.png' });
// persistence
await page.waitForTimeout(1000);
await page.reload();
await page.waitForFunction(() => window.__realm && window.__realm.state.terrain);
console.log('after reload', await st());
// mobile viewport
const mp = await ctx.newPage();
await mp.setViewportSize({ width: 390, height: 844 });
await mp.goto('http://localhost:8123/');
await mp.waitForFunction(() => window.__realm && window.__realm.state.terrain);
await mp.waitForTimeout(500);
await mp.screenshot({ path: 'docs/smoke-6.png' });
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
