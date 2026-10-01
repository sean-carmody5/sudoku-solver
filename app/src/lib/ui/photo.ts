import { SCAN_MAX_DIM, type ScanFrame, type ScanSource } from '../stores/scan.svelte'

/**
 * Decode an image file into a scan frame (capped at SCAN_MAX_DIM, which keeps
 * the RGBA buffer well under mobile-Safari memory limits) plus, when that
 * was a downscale, the decoded original for a full-resolution second pass
 * on small grids.
 */
export async function decodePhoto(file: Blob): Promise<{ frame: ScanFrame; source: ScanSource | null }> {
  if (file.type && !file.type.startsWith('image/')) throw new Error('not an image')
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, SCAN_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.round(img.naturalWidth * scale)
    const h = Math.round(img.naturalHeight * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    const source: ScanSource | null =
      scale < 1
        ? {
            width: img.naturalWidth,
            height: img.naturalHeight,
            draw: (c, sx, sy, sw, sh, dw, dh) => c.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh),
          }
        : null
    return { frame: { canvas, rgba: data.data, width: w, height: h, fit: 'contain' }, source }
  } finally {
    // The Image keeps its decoded bitmap; the URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** The bundled sample photo (a real newspaper sudoku). */
export async function samplePhoto(): Promise<Blob> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/newspaper.jpg`)
  if (!res.ok) throw new Error('sample unavailable')
  return res.blob()
}
