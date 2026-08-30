// Palette distinctness — measured on the RENDERED chart, with all 24 mains present.
//
// This replaces an assertion that was passing while the chart was wrong. The old visual suite
// checked `new Set(swatches).size === 24`: twenty-four distinct STRINGS. Two of those strings were
// #aaffc3 and #7cf5a0, ΔE00 6.30 apart — two pale greens, listed one above the other in the legend,
// and the test was perfectly happy. String inequality is not a claim about what anything looks like.
//
// So: seed every main ledger with spend, render the real page in a real browser, read the colours
// back off the SVG slices and the legend swatches as the browser actually resolved them, and measure
// all 276 pairs with CIEDE2000. Reading them back from the DOM rather than from the source constant
// is deliberate — it also catches the pie and the legend disagreeing, and any CSS that alters a
// swatch after it is set.
//
// Run: node test-ui/palette-distinctness.js
const H = require('../test/helpers');
const M = require('./color-metrics.js');
const { chromium } = require('playwright');

// The bar. ΔE00 10 is "separable at a glance for a non-adjacent pair"; the fixed palette is derived
// to clear 12, so the threshold sits at 12 to catch a regression rather than only a catastrophe.
const MIN_DE_SCREEN = 12;
// The PDF palette is one hue family on white paper by design, which caps how far 24 categories can
// be pushed apart — measured ceiling ~11.6 while still reading as amber, ~20 if the hue constraint
// is dropped. 5.5 pins the improvement that was made (from 2.99, and from an outright duplicate)
// without pretending the printed pie is as readable as the screen one. See PDF_PALETTE in server.js.
const MIN_DE_PDF = 5.5;
const MIN_CONTRAST = 3.0;
const PANEL = '#111113';

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

// ---- the metric implementation is only trustworthy if it is itself pinned ----------------------
// Reference pairs from Sharma, Wu & Dalal's CIEDE2000 test data. Without these, a subtly wrong ΔE
// implementation would report whatever the palette needed it to report.
const CIEDE2000_REFERENCE = [
  [[50.0000, 2.6772, -79.7751], [50.0000, 0.0000, -82.7485], 2.0425],
  [[50.0000, 3.1571, -77.2803], [50.0000, 0.0000, -82.7485], 2.8615],
  [[50.0000, 2.8361, -74.0200], [50.0000, 0.0000, -82.7485], 3.4412],
  [[50.0000, -1.3802, -84.2814], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, 0.0000, 0.0000], [50.0000, -1.0000, 2.0000], 2.3669],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0009], 7.1792],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0011], 7.2195],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0009, -2.4900], 4.8045],
  [[50.0000, 2.5000, 0.0000], [50.0000, 0.0000, -2.5000], 4.3065],
  [[50.0000, 2.5000, 0.0000], [73.0000, 25.0000, -18.0000], 27.1492],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
  [[36.4612, 47.8580, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
];

function selfCheck() {
  const off = CIEDE2000_REFERENCE.filter(([a, b, want]) => Math.abs(M.ciede2000(a, b) - want) > 0.0001);
  check(`ΔE00 matches ${CIEDE2000_REFERENCE.length} published reference pairs to 1e-4`, off.length === 0,
    off.length ? `${off.length} mismatched` : undefined);
  const w = M.labOf('#ffffff')[0], k = M.labOf('#000000')[0];
  check('sRGB→Lab endpoints are right (white L=100, black L=0)', Math.abs(w - 100) < 0.01 && Math.abs(k) < 0.01, `L ${w.toFixed(2)} / ${k.toFixed(2)}`);
}

// ---- reporting -------------------------------------------------------------------------------
function assertDistinct(label, colors, minDE) {
  const pairs = M.pairwise(colors);
  const bad = pairs.filter((p) => p.dE < minDE);
  check(`${label}: all ${pairs.length} pairs ≥ ΔE00 ${minDE}`, bad.length === 0,
    `min ${pairs[0].dE.toFixed(2)} (${pairs[0].a} / ${pairs[0].b})`
    + (bad.length ? ` — ${bad.length} under: ` + bad.slice(0, 5).map((p) => `${p.a}/${p.b} ${p.dE.toFixed(1)}`).join(', ') : ''));
  return pairs;
}

(async () => {
  console.log('── ΔE implementation ──────────────────────────────────────────────');
  selfCheck();

  const base = (await H.startApp()).base;
  const { user, cookie } = H.seedLoggedIn();
  const token = cookie.split('=')[1];

  // Every main ledger gets spend, so every one of them produces a slice. Varying amounts so the
  // slices are different sizes — a thin sliver next to a large wedge is the hardest read.
  const mains = H.db.prepare('SELECT code FROM ledger_mains ORDER BY sort_order ASC').all().map((r) => r.code);
  mains.forEach((code, i) => H.seedCashOut({ amountPaise: 100000 + (i * 7919) % 400000, byUserId: user.id, ledgerCode: code }));

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1800 } });
  await ctx.addCookies([{ name: 'plannr_session', value: token, domain: new URL(base).hostname, path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(base + '/overview', { waitUntil: 'networkidle' });
  await page.waitForSelector('.ov-pie path, .ov-pie circle', { timeout: 10000 });
  await page.waitForTimeout(600);

  console.log('\n── rendered chart, all mains present ──────────────────────────────');
  const sliceFills = await page.$$eval('.ov-pie path', (els) => els.map((e) => e.getAttribute('fill')));
  const swatchBgs = await page.$$eval('.ov-swatch', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  check(`every main ledger rendered a slice (${mains.length} seeded)`, sliceFills.length === mains.length, `${sliceFills.length} slices`);
  check('the legend has a swatch per slice', swatchBgs.length === sliceFills.length, `${swatchBgs.length} swatches`);

  // The pie and the legend must agree; a mismatch means the chart and its key disagree about which
  // colour means which category, which no amount of pairwise distance would reveal.
  const asHex = (c) => M.toHex(M.parseColor(c));
  const mismatched = sliceFills.map((f, i) => [asHex(f), asHex(swatchBgs[i])]).filter(([a, b]) => a !== b);
  check('slice colour === legend swatch colour, row by row', mismatched.length === 0,
    mismatched.length ? `${mismatched.length} differ, first ${mismatched[0].join(' vs ')}` : undefined);

  const rendered = sliceFills.map(asHex);
  const pairs = assertDistinct('rendered pie', rendered, MIN_DE_SCREEN);

  const worstContrast = rendered.map((c) => ({ c, r: M.contrastRatio(c, PANEL) })).sort((a, b) => a.r - b.r)[0];
  check(`every slice ≥ ${MIN_CONTRAST}:1 against the panel`, worstContrast.r >= MIN_CONTRAST, `lowest ${worstContrast.r.toFixed(2)}:1 (${worstContrast.c})`);

  console.log(`    distribution: min ${pairs[0].dE.toFixed(1)}  p10 ${pairs[Math.floor(pairs.length * 0.1)].dE.toFixed(1)}  median ${pairs[Math.floor(pairs.length / 2)].dE.toFixed(1)}  max ${pairs[pairs.length - 1].dE.toFixed(1)}`);
  console.log(`    closest 3: ` + pairs.slice(0, 3).map((p) => `${p.a}/${p.b} ${p.dE.toFixed(1)}`).join('   '));

  // Custom is its own slice and must not collide with any ledger's colour either.
  const CUSTOM_SCREEN = '#cbd5e1';
  const nearestToCustom = rendered.map((c) => ({ c, d: M.deltaE(c, CUSTOM_SCREEN) })).sort((a, b) => a.d - b.d)[0];
  check(`the Custom slice (${CUSTOM_SCREEN}) is distinct from every ledger colour`, nearestToCustom.d >= MIN_DE_SCREEN,
    `nearest ${nearestToCustom.c} at ΔE00 ${nearestToCustom.d.toFixed(2)}`);

  await browser.close();

  // ---- the source constants: the extension table, and the PDF's copies -------------------------
  // Past the fixed 24 the extension table takes over, and it is not reachable from a rendered page
  // without inventing 24 extra ledgers, so it is measured from source — together with the fixed 24,
  // because the whole point of the table is that it does not collide with them.
  console.log('\n── source constants ──────────────────────────────────────────────');
  const fs = require('fs');
  const grab = (file, name) => {
    const src = fs.readFileSync(file, 'utf8');
    const start = src.indexOf('const ' + name + ' = [');
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    return src.slice(start, src.indexOf('];', start)).match(/#[0-9a-f]{6}/gi);
  };

  const screenFixed = grab('public/overview.html', 'LEDGER_PALETTE');
  const screenExt = grab('public/overview.html', 'LEDGER_PALETTE_EXT');
  check('the rendered colours are the shipped palette, in order', JSON.stringify(rendered) === JSON.stringify(screenFixed.slice(0, rendered.length)));
  assertDistinct(`screen palette + extension (${screenFixed.length + screenExt.length} colours)`, screenFixed.concat(screenExt), MIN_DE_SCREEN);

  // server.js and public/local-api.js are deliberately duplicated files; a palette that drifts
  // between them means the on-device PDF and the desktop PDF are different documents.
  const pdfSrv = grab('server.js', 'PDF_PALETTE'), pdfLocal = grab('public/local-api.js', 'PDF_PALETTE');
  const pdfSrvExt = grab('server.js', 'PDF_PALETTE_EXT'), pdfLocalExt = grab('public/local-api.js', 'PDF_PALETTE_EXT');
  check('PDF_PALETTE is identical in server.js and local-api.js', JSON.stringify(pdfSrv) === JSON.stringify(pdfLocal));
  check('PDF_PALETTE_EXT is identical in server.js and local-api.js', JSON.stringify(pdfSrvExt) === JSON.stringify(pdfLocalExt));

  // The Custom colour used to be a bare literal that was ALSO in the palette — the 18th ledger and
  // the Custom slice came out byte-identical. It is a named constant now precisely so it can be
  // included here.
  const pdfCustom = /const PDF_CUSTOM_COLOR = '(#[0-9a-f]{6})'/.exec(fs.readFileSync('server.js', 'utf8'));
  check('PDF_CUSTOM_COLOR is declared as a constant', !!pdfCustom, pdfCustom ? pdfCustom[1] : 'missing');
  const pdfAll = pdfSrv.concat(pdfCustom ? [pdfCustom[1]] : []);
  check('the PDF Custom colour is not also a ledger colour', new Set(pdfAll).size === pdfAll.length,
    `${pdfAll.length - new Set(pdfAll).size} exact duplicate(s)`);
  assertDistinct('PDF palette + Custom', pdfAll, MIN_DE_PDF);
  assertDistinct('PDF palette + extension', pdfSrv.concat(pdfSrvExt), MIN_DE_PDF);

  await H.stopApp();
  console.log(failures === 0 ? '\n✓ PALETTE DISTINCTNESS PASSED' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
