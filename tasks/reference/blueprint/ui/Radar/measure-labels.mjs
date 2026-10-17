// Measures how the Radar sizes its labels, on a real page in Chromium, without
// editing the component: it wraps getBBox before the app loads, records what each
// label was measured in, then re-measures the same strings in the font that
// actually renders and recomputes Radar.svelte's sizing formula from both.
//
// Run it against blueprint-ng's landing page (the fixture is LandingRadar.svelte):
//   cd ~/Projects/blueprint-ng && npx vite dev --port 5199
//   node tasks/reference/blueprint/ui/Radar/measure-labels.mjs http://localhost:5199/landing
// For a production build: `npx vite build && npx vite preview --port 5198`, then
// pass http://localhost:5198/landing.
//
// It loads the page twice in one browser context: "cold" with an empty HTTP
// cache, then "warm" on reload. It prints a report and writes three PNGs to the
// output directory: the radar cold, warm, and with its labels set to the sizes
// the formula gives from the rendered font's widths.
//
// The geometry below is LandingRadar's (radarSize 150, 11 practices, the six
// discipline labels). A port with other data has to change those constants.
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5199/landing';
const OUT = process.argv[3] ?? '.';

const RENDERED_FONT = { family: "'Roboto Condensed', sans-serif", weight: '300' };
const DISCIPLINES = ['Engineering Excellence', 'Runtime Protection', 'Training', '1st Party Code', 'SBoM 3rd Party Code', 'Second Set of Eyes'];

function instrument() {
  window.__measured = [];
  // Google Fonts registers one face per unicode-range subset, so report the
  // furthest along of them; a variable font's weight is a range like "400 1000".
  const faceStatus = (family, weight) => {
    const statuses = [...document.fonts]
      .filter((f) => {
        const [lo, hi = lo] = f.weight.split(' ').map(Number);
        return f.family.replaceAll('"', '') === family && lo <= weight && weight <= hi;
      })
      .map((f) => f.status);
    return ['loaded', 'loading', 'unloaded'].find((s) => statuses.includes(s)) ?? 'no face';
  };
  const orig = SVGGraphicsElement.prototype.getBBox;
  SVGGraphicsElement.prototype.getBBox = function (...args) {
    const box = orig.apply(this, args);
    if (this.tagName === 'text' && this.id && !window.__measured.some((m) => m.id === this.id)) {
      const cs = getComputedStyle(this);
      window.__measured.push({
        ms: Math.round(performance.now()),
        id: this.id,
        text: this.textContent.trim(),
        // Radar.svelte's measuring elements carry dy="-100"; Sidebar's do not.
        where: this.getAttribute('dy') === '-100' ? 'ring' : 'legend',
        fontSize: +this.getAttribute('font-size'),
        measuredIn: `${cs.fontFamily.split(',')[0].replaceAll('"', '')} ${cs.fontWeight}`,
        robotoFace: faceStatus('Roboto Condensed', 300),
        dmSansFace: faceStatus('DM Sans', 400),
        w: box.width,
        h: box.height,
      });
      // Would `await document.fonts.load(...)` have waited for anything here?
      if (window.__fontsLoadAtMeasure === undefined) {
        window.__fontsLoadAtMeasure = 'pending';
        document.fonts.load('300 16px "Roboto Condensed"').then((faces) => { window.__fontsLoadAtMeasure = faces.length; });
      }
    }
    return box;
  };
}

function analyze({ RENDERED_FONT, DISCIPLINES }) {
  const svg = document.querySelector('svg:has(textPath)');
  const probe = (text, size, { family, weight }) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    el.setAttribute('font-size', size);
    el.setAttribute('dy', '-100');
    el.style.fontFamily = family;
    el.style.fontWeight = weight;
    el.textContent = text;
    svg.appendChild(el);
    const box = el.getBBox();
    el.remove();
    return { w: box.width, h: box.height };
  };
  const rows = window.__measured.map((m) => {
    const rendered = probe(m.text, m.fontSize, RENDERED_FONT);
    return { ...m, renderedW: rendered.w, renderedH: rendered.h };
  });

  // Radar.svelte's sizing, with LandingRadar's props.
  const radarSize = 150, practiceCount = 11, outerRadius = radarSize / 2 - 0.5;
  const disciplineBand = 0.07 * radarSize, practiceBand = 0.06 * radarSize, slice = 2 * Math.PI / practiceCount;
  const disciplineMaxW = 0.95 * slice * (outerRadius - disciplineBand / 2);
  const practiceMaxW = 0.95 * slice * (outerRadius - disciplineBand - practiceBand / 2);
  const disciplineMaxH = 0.8 * disciplineBand, practiceMaxH = 0.8 * practiceBand, margin = 1.05;
  const ring = rows.filter((r) => r.where === 'ring');
  const disc = ring.filter((r) => DISCIPLINES.includes(r.text));
  const prac = ring.filter((r) => !DISCIPLINES.includes(r.text));
  const max = (list, key) => Math.max(...list.map((r) => r[key]));
  const sizes = (w, h) => {
    const d = Math.min(disciplineMaxW / (max(disc, w) * margin), disciplineMaxH / (max(disc, h) * margin));
    return { discipline: d, practice: Math.min(d, practiceMaxW / (max(prac, w) * margin), practiceMaxH / (max(prac, h) * margin)) };
  };

  const labels = [...svg.querySelectorAll('text:has(textPath)')]
    .map((t) => ({ text: t.textContent.trim(), size: +t.getAttribute('font-size'), len: t.getComputedTextLength() }))
    .filter((l) => l.text);
  const practiceLabels = labels.filter((l) => !DISCIPLINES.includes(l.text));
  const widest = practiceLabels.reduce((a, b) => (b.len > a.len ? b : a));

  // Canvas at 100px, divided by 100, against SVG getBBox at font-size 1.
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${RENDERED_FONT.weight} 100px ${RENDERED_FONT.family}`;
  const canvasCheck = ['Security Peer Review', 'DDoS'].map((s) => ({
    text: s, canvasPerUnit: ctx.measureText(s).width / 100, svgPerUnit: probe(s, 1, RENDERED_FONT).w,
  }));
  const linearity = [1, 10, 100].map((s) => probe('Security Peer Review', s, RENDERED_FONT).w / s);

  return {
    rows,
    fromMeasured: sizes('w', 'h'),
    fromRendered: sizes('renderedW', 'renderedH'),
    rendered: { discipline: labels.find((l) => DISCIPLINES.includes(l.text)).size, practice: practiceLabels[0].size },
    widest: { text: widest.text, fill: widest.len / practiceMaxW },
    legendSizes: [...new Set(rows.filter((r) => r.where === 'legend')
      .map((r) => document.getElementById(r.id)?.getAttribute('font-size')).filter(Boolean))],
    fontsLoadAtMeasure: window.__fontsLoadAtMeasure,
    canvasCheck,
    linearity,
  };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(instrument);
const page = await context.newPage();
const results = {};
for (const run of ['cold', 'warm']) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  results[run] = await page.evaluate(analyze, { RENDERED_FONT, DISCIPLINES });
  await page.locator('svg:has(textPath)').first().screenshot({ path: `${OUT}/radar-${run}.png` });
}
const want = results.warm.fromRendered;
await page.evaluate(({ want, DISCIPLINES }) => {
  for (const t of document.querySelectorAll('svg:has(textPath) text:has(textPath)')) {
    t.setAttribute('font-size', DISCIPLINES.includes(t.textContent.trim()) ? want.discipline : want.practice);
  }
}, { want, DISCIPLINES });
await page.locator('svg:has(textPath)').first().screenshot({ path: `${OUT}/radar-intended.png` });
const chromiumVersion = browser.version();
await browser.close();

const f = (n, d = 3) => n.toFixed(d);
console.log(`${URL}  (Chromium ${chromiumVersion}, 1440x900)`);
for (const [run, r] of Object.entries(results)) {
  console.log(`\n== ${run}`);
  console.log('ms    where   label                     measured in             Roboto 300  DM Sans 400  measured  in rendered font  ratio');
  for (const m of r.rows) {
    console.log(`${String(m.ms).padStart(4)}  ${m.where.padEnd(6)}  ${m.text.slice(0, 24).padEnd(24)}  ${m.measuredIn.padEnd(22)}  ${m.robotoFace.padEnd(10)}  ${m.dmSansFace.padEnd(11)}  ${f(m.w).padStart(8)}  ${f(m.renderedW).padStart(16)}  ${f(m.w / m.renderedW)}`);
  }
  console.log(`ring sizes, formula on measured widths : discipline ${f(r.fromMeasured.discipline)}  practice ${f(r.fromMeasured.practice)}`);
  console.log(`ring sizes, formula on rendered widths : discipline ${f(r.fromRendered.discipline)}  practice ${f(r.fromRendered.practice)}`);
  console.log(`ring sizes, actually rendered          : discipline ${f(r.rendered.discipline)}  practice ${f(r.rendered.practice)}`);
  console.log(`widest practice label (${r.widest.text}) fills ${f(100 * r.widest.fill, 1)}% of its slot; the formula aims for ${f(100 / 1.05, 1)}%`);
  console.log(`legend font sizes rendered: ${r.legendSizes.map((s) => f(+s)).join(', ')}`);
  console.log(`document.fonts.load('300 16px "Roboto Condensed"') called at first measurement resolved with ${r.fontsLoadAtMeasure} face(s)`);
  console.log(`width per unit font-size, SVG at 1/10/100: ${r.linearity.map((x) => f(x, 4)).join(' / ')}`);
  for (const c of r.canvasCheck) console.log(`canvas measureText at 100px / 100 vs SVG at 1, "${c.text}": ${f(c.canvasPerUnit, 4)} vs ${f(c.svgPerUnit, 4)}`);
}
