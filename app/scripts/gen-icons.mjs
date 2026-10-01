// Render the app icon (sudoku grid with a filling diagonal) at PWA sizes using
// Playwright, so it matches the header mark. Light tile. No native image deps.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

// maskable: bg fills the whole square (OS masks it) and the mark sits in the
// safe zone; otherwise a rounded light tile.
function markHtml(s, { maskable = false } = {}) {
  const bg = maskable
    ? `<rect x="0" y="0" width="${s}" height="${s}" fill="#f3f5f9"/>`
    : `<rect x="0" y="0" width="${s}" height="${s}" rx="${s * 0.22}" fill="#f3f5f9"/>`
  const inset = maskable ? 0.28 : 0.17
  const g = s * inset
  const gw = s * (1 - inset * 2)
  const l1 = g + gw / 3
  const l2 = g + (gw * 2) / 3
  const cell = gw / 3
  const ci = cell * 0.12
  const cw = cell * 0.76
  const diag = [0, 1, 2]
    .map((i) => {
      const p = g + i * cell + ci
      return `<rect x="${p}" y="${p}" width="${cw}" height="${cw}" rx="${cell * 0.16}" fill="url(#c)" opacity="${i === 1 ? 1 : 0.85}"/>`
    })
    .join('')
  return `
    <svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="c" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#38bdf8"/>
        </linearGradient>
      </defs>
      ${bg}
      ${diag}
      <g fill="none" stroke="#334155" stroke-linecap="round">
        <rect x="${g}" y="${g}" width="${gw}" height="${gw}" rx="${gw * 0.14}" stroke-width="${s * 0.045}"/>
        <path d="M${l1} ${g + gw * 0.02}v${gw * 0.96}M${l2} ${g + gw * 0.02}v${gw * 0.96}M${g + gw * 0.02} ${l1}h${gw * 0.96}M${g + gw * 0.02} ${l2}h${gw * 0.96}" stroke-width="${s * 0.028}" opacity="0.4"/>
      </g>
    </svg>`
}

const browser = await chromium.launch()
for (const [size, name, opts] of [
  [512, 'icon-512.png', {}],
  [192, 'icon-192.png', {}],
  [512, 'icon-maskable-512.png', { maskable: true }],
  [180, 'apple-touch-icon.png', {}],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<body style="margin:0;background:transparent">${markHtml(size, opts)}</body>`)
  await page.screenshot({ path: join(outDir, name), omitBackground: true })
  await page.close()
}
await browser.close()
console.log('icons written to', outDir)
