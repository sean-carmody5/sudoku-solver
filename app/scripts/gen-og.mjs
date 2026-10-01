// Render the 1200x630 social share image (og.png) to public/, matching the
// app's identity. Uses Playwright so there are no native image deps.
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const b64 = readFileSync(join(here, '..', 'public', 'fonts', 'inter.woff2')).toString('base64')
mkdirSync(join(here, '..', 'public'), { recursive: true })

const diag = (S) => {
  const g = S * 0.06
  const gw = S * 0.88
  const l1 = g + gw / 3
  const l2 = g + (gw * 2) / 3
  const cell = gw / 3
  const ci = cell * 0.12
  const cw = cell * 0.76
  const cells = [0, 1, 2]
    .map((i) => {
      const p = g + i * cell + ci
      return `<rect x="${p}" y="${p}" width="${cw}" height="${cw}" rx="${cell * 0.16}" fill="url(#c)" opacity="${i === 1 ? 1 : 0.85}"/>`
    })
    .join('')
  return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
    ${cells}
    <g fill="none" stroke="#e8ebf1" stroke-linecap="round">
      <rect x="${g}" y="${g}" width="${gw}" height="${gw}" rx="${gw * 0.14}" stroke-width="${S * 0.045}"/>
      <path d="M${l1} ${g}v${gw}M${l2} ${g}v${gw}M${g} ${l1}h${gw}M${g} ${l2}h${gw}" stroke-width="${S * 0.028}" opacity="0.4"/>
    </g></svg>`
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Inter var'; font-weight:100 900; src:url(data:font/woff2;base64,${b64}) format('woff2'); }
  * { margin:0; box-sizing:border-box; }
  body { width:1200px; height:630px; overflow:hidden; font-family:'Inter var',system-ui,sans-serif;
    background:#0b0e14; color:#e8ebf1;
    background-image:radial-gradient(50% 60% at 18% 0%, rgba(45,212,191,.22), transparent 68%), radial-gradient(52% 60% at 88% 4%, rgba(56,189,248,.20), transparent 68%);
    display:flex; flex-direction:column; justify-content:center; padding:0 96px; }
  .brand { display:flex; align-items:center; gap:26px; margin-bottom:30px; }
  .mark { width:104px; height:104px; color:#e8ebf1; filter:drop-shadow(0 6px 22px rgba(45,212,191,.35)); }
  h1 { font-size:78px; font-weight:780; letter-spacing:-0.035em; }
  h1 span { color:#2dd4bf; }
  p { font-size:33px; line-height:1.4; color:#aeb8c7; max-width:23ch; font-weight:450; }
  p b { color:#e8ebf1; font-weight:650; }
  .url { position:absolute; bottom:52px; left:96px; font-size:24px; font-weight:600; letter-spacing:.02em;
    color:#2dd4bf; }
</style></head><body>
  <div class="brand"><div class="mark">${diag(104)}</div><h1>Sudoku <span>Solver</span></h1></div>
  <p><b>Scan a photo</b> and solve any sudoku - free, private, right in your browser.</p>
  <div class="url">sudoku-solver.carmodys2014.workers.dev</div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.setContent(html)
await page.waitForTimeout(300)
await page.screenshot({ path: join(here, '..', 'public', 'og.png') })
await browser.close()
console.log('wrote public/og.png (1200x630)')
