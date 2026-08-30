// Palette derivation tool — NOT a test. Run by hand when a palette needs to change; its OUTPUT is
// pasted into the source, and test-ui/palette-distinctness.js is what then guards the result.
//
//   node test-ui/derive-palette.js            # report only
//   node test-ui/derive-palette.js --search   # run the search and print candidate palettes
//
// The problem it solves: a categorical palette has to keep every pair of colours far enough apart to
// be told apart in a legend. "Far enough apart" is CIEDE2000, not string inequality, and eyeballing
// 276 pairs is not something anyone does reliably. The search below moves each colour in LCh space
// (so a proposal reads as "same colour, a bit lighter" rather than an arbitrary jump), keeps it
// within an identity budget of where it started so the palette still looks like itself, and
// maximises the SMALLEST pairwise ΔE00 — the pair that decides whether the chart is readable.
//
// Constraints every candidate must satisfy:
//   · within `identityBudget` ΔE00 of the colour it replaces (recognisably the same swatch)
//   · in the sRGB gamut without clamping (a clamped colour is not the one that was measured)
//   · at least `contrastFloor` contrast against the background it is drawn on
//   · inside `hueRange`, when the palette has a hue identity to preserve (the PDF's amber family)
const M = require('./color-metrics.js');

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// Lexicographic score: maximise the smallest ΔE00, then the second smallest, and so on. Comparing
// only the mean would happily trade a readable chart for a prettier average.
function score(labs, depth = 6) {
  const ds = [];
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) ds.push(M.ciede2000(labs[i], labs[j]));
  }
  ds.sort((a, b) => a - b);
  return ds.slice(0, depth);
}
const better = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] - b[i] > 1e-9) return true;
    if (b[i] - a[i] > 1e-9) return false;
  }
  return false;
};

function search(originalHexes, opts) {
  const {
    identityBudget = 12, contrastFloor = 3.0, background = '#111113',
    hueRange = null, rounds = 60, itersPerRound = 6000, frozen = new Set(),
  } = opts;

  const origLabs = originalHexes.map((h) => M.labOf(h));
  const inHue = (h) => {
    if (!hueRange) return true;
    const [lo, hi] = hueRange;
    return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;
  };

  // A proposal is valid only if it satisfies every constraint; ΔE is measured on the ROUNDED sRGB
  // value, because that is the colour that actually ships.
  const validate = (lab, idx) => {
    const { rgb, inGamut } = M.labToRgb(lab);
    if (!inGamut) return null;
    const hex = M.toHex(rgb);
    const snapped = M.labOf(hex);                       // re-measure after 8-bit rounding
    if (M.ciede2000(snapped, origLabs[idx]) > identityBudget) return null;
    if (M.contrastRatio(hex, background) < contrastFloor) return null;
    if (!inHue(M.labToLch(snapped)[2])) return null;
    return { hex, lab: snapped };
  };

  let bestHexes = originalHexes.slice();
  let bestLabs = origLabs.slice();
  let bestScore = score(bestLabs);

  for (let round = 0; round < rounds; round++) {
    // Start each round from the incumbent; jitter width decays so early rounds explore and later
    // ones polish.
    let hexes = bestHexes.slice(), labs = bestLabs.slice(), sc = bestScore;
    const heat = 1 - round / rounds;
    for (let it = 0; it < itersPerRound; it++) {
      // Target the colour that is currently in the worst pair — that is the only one whose movement
      // can raise the minimum.
      let wi = 0, wj = 1, wd = Infinity;
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
          const d = M.ciede2000(labs[i], labs[j]);
          if (d < wd) { wd = d; wi = i; wj = j; }
        }
      }
      let idx = Math.random() < 0.5 ? wi : wj;
      if (frozen.has(idx)) idx = frozen.has(wi === idx ? wj : wi) ? -1 : (idx === wi ? wj : wi);
      if (idx < 0) break; // both ends of the worst pair are frozen — nothing to move

      const [L, C, h] = M.labToLch(labs[idx]);
      const proposal = M.lchToLab([
        Math.min(100, Math.max(0, L + rand(-10, 10) * heat)),
        Math.max(0, C + rand(-14, 14) * heat),
        h + rand(-14, 14) * heat,
      ]);
      const ok = validate(proposal, idx);
      if (!ok) continue;

      const trialLabs = labs.slice(); trialLabs[idx] = ok.lab;
      const trialScore = score(trialLabs);
      if (better(trialScore, sc)) {
        labs = trialLabs; hexes = hexes.slice(); hexes[idx] = ok.hex; sc = trialScore;
      }
    }
    if (better(sc, bestScore)) { bestScore = sc; bestHexes = hexes; bestLabs = labs; }
  }
  return { hexes: bestHexes, score: bestScore };
}

// ---- extension set for ledgers past the fixed palette ------------------------------------------
// The shipped generator was `hsl(extraIndex * 137.508, 65%, 50%)` — golden-angle hue rotation. It
// spreads the extras apart FROM EACH OTHER and is completely blind to the 24 fixed colours it is
// extending, so the first generated colour landed ΔE00 3.99 from a fixed one. It also assumes equal
// hue steps are equal perceptual steps, which they are not: the greens compress, and two generated
// colours 32.5° apart in hue came out ΔE00 6.49 from each other.
//
// Farthest-point insertion over an LCh grid fixes both at once: each new colour is the grid point
// whose closest neighbour among ALL already-used colours (fixed + previously generated) is as far
// away as possible. Greedy, deterministic, and it never has to guess whether hue distance means
// anything.
function deriveExtension(fixedHexes, count, { contrastFloor = 3.0, background = '#111113' } = {}) {
  const candidates = [];
  for (let L = 35; L <= 92; L += 3.5) {
    for (let C = 8; C <= 120; C += 6) {
      for (let h = 0; h < 360; h += 4) {
        const { rgb, inGamut } = M.labToRgb(M.lchToLab([L, C, h]));
        if (!inGamut) continue;
        const hex = M.toHex(rgb);
        if (M.contrastRatio(hex, background) < contrastFloor) continue;
        candidates.push({ hex, lab: M.labOf(hex) });
      }
    }
  }
  const used = fixedHexes.map((h) => M.labOf(h));
  const out = [];
  for (let n = 0; n < count; n++) {
    let bestHex = null, bestDist = -1;
    for (const c of candidates) {
      let nearest = Infinity;
      for (const u of used) {
        const d = M.ciede2000(c.lab, u);
        if (d < nearest) { nearest = d; if (nearest <= bestDist) break; }
      }
      if (nearest > bestDist) { bestDist = nearest; bestHex = c; }
    }
    if (!bestHex) break;
    used.push(bestHex.lab);
    out.push({ hex: bestHex.hex, minDE: bestDist });
  }
  return out;
}

// ---- reporting ---------------------------------------------------------------------------------
function report(name, hexes, background) {
  const pairs = M.pairwise(hexes);
  const worstContrast = hexes.map((c) => ({ c, r: M.contrastRatio(c, background) })).sort((a, b) => a.r - b.r)[0];
  console.log(`\n${name}: ${hexes.length} colours, ${pairs.length} pairs`);
  console.log(`  min ΔE00 ${pairs[0].dE.toFixed(2)}   below 5: ${pairs.filter((p) => p.dE < 5).length}   below 10: ${pairs.filter((p) => p.dE < 10).length}   below 12: ${pairs.filter((p) => p.dE < 12).length}`);
  console.log(`  lowest contrast vs ${background}: ${worstContrast.r.toFixed(2)}:1 (${worstContrast.c})`);
  console.log('  worst 5 pairs: ' + pairs.slice(0, 5).map((p) => `${p.a}/${p.b} ${p.dE.toFixed(1)}`).join('  '));
  return pairs[0].dE;
}

const fmt = (hexes, per = 8, indent = '  ') => {
  const out = [];
  for (let i = 0; i < hexes.length; i += per) out.push(indent + hexes.slice(i, i + per).map((h) => `'${h}'`).join(', ') + ',');
  return out.join('\n').replace(/,$/, '');
};

if (require.main === module) {
  const fs = require('fs');
  const grab = (file, name) => (new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(fs.readFileSync(file, 'utf8'))[1]).match(/#[0-9a-f]{6}/gi);

  const screen = grab('public/overview.html', 'LEDGER_PALETTE');
  const pdf = grab('server.js', 'PDF_PALETTE');

  console.log('=== CURRENT ===');
  report('screen LEDGER_PALETTE', screen, '#111113');
  report('PDF_PALETTE', pdf, '#ffffff');

  if (!process.argv.includes('--search')) { console.log('\n(run with --search to derive replacements)'); process.exit(0); }

  console.log('\n=== SEARCH ===');
  const s = search(screen, { identityBudget: 14, contrastFloor: 3.0, background: '#111113' });
  report('screen (derived)', s.hexes, '#111113');
  console.log('LEDGER_PALETTE:\n' + fmt(s.hexes));

  // The PDF palette is deliberately one hue family (amber/brown, matching the app's accent) on white
  // paper. That is a hard ceiling on how far 24 colours can be pushed apart — hue is the axis that
  // separates categories best, and this palette has given it up by design. Search it anyway, so the
  // ceiling is a measured number rather than an assumption.
  const p = search(pdf, { identityBudget: 16, contrastFloor: 1.6, background: '#ffffff', hueRange: [20, 95] });
  report('PDF (derived, amber-only)', p.hexes, '#ffffff');
  console.log('PDF_PALETTE:\n' + fmt(p.hexes));

  const pFree = search(pdf, { identityBudget: 60, contrastFloor: 1.6, background: '#ffffff' });
  report('PDF (derived, hue unconstrained — for comparison only)', pFree.hexes, '#ffffff');
}

module.exports = { search, score, report, deriveExtension };
