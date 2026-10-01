/** DOM-free image containers used across the CV pipeline. */

export interface GrayImage {
  data: Uint8Array
  width: number
  height: number
}

export interface BinaryImage {
  /** 0 or 1 per pixel. */
  data: Uint8Array
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export function makeGray(width: number, height: number): GrayImage {
  return { data: new Uint8Array(width * height), width, height }
}

/** Rec.601 luma from RGBA bytes (e.g. canvas ImageData). */
export function grayFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  }
  return { data: out, width, height }
}

/** Photographic negative (light ink on dark -> dark ink on light). */
export function invertGray(img: GrayImage): GrayImage {
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < out.length; i++) out[i] = 255 - img.data[i]
  return { data: out, width: img.width, height: img.height }
}

/** Median of the central half of the frame (where the user aims), sampled
 * sparsely: cheap enough to run on every live frame. */
export function centralMedian(img: GrayImage): number {
  const hist = new Uint32Array(256)
  let n = 0
  const step = Math.max(1, Math.round(Math.min(img.width, img.height) / 160))
  for (let y = Math.floor(img.height / 4); y < (img.height * 3) / 4; y += step) {
    for (let x = Math.floor(img.width / 4); x < (img.width * 3) / 4; x += step) {
      hist[img.data[y * img.width + x]]++
      n++
    }
  }
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc * 2 >= n) return v
  }
  return 255
}

/** Copy a rectangular region (clamped to the image bounds). */
export function cropGray(img: GrayImage, x0: number, y0: number, w: number, h: number): GrayImage {
  const cx0 = Math.max(0, Math.round(x0))
  const cy0 = Math.max(0, Math.round(y0))
  const cw = Math.min(img.width - cx0, Math.round(w))
  const ch = Math.min(img.height - cy0, Math.round(h))
  const out = new Uint8Array(Math.max(0, cw) * Math.max(0, ch))
  for (let y = 0; y < ch; y++) {
    out.set(img.data.subarray((cy0 + y) * img.width + cx0, (cy0 + y) * img.width + cx0 + cw), y * cw)
  }
  return { data: out, width: cw, height: ch }
}

/** Area-averaged downscale to fit within maxDim (no-op if already smaller). */
export function downscale(img: GrayImage, maxDim: number): GrayImage {
  const { width, height, data } = img
  const scale = maxDim / Math.max(width, height)
  if (scale >= 1) return img
  const ow = Math.max(1, Math.round(width * scale))
  const oh = Math.max(1, Math.round(height * scale))
  const out = new Uint8Array(ow * oh)
  for (let oy = 0; oy < oh; oy++) {
    const sy0 = Math.floor((oy * height) / oh)
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * height) / oh))
    for (let ox = 0; ox < ow; ox++) {
      const sx0 = Math.floor((ox * width) / ow)
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * width) / ow))
      let sum = 0
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * width
        for (let sx = sx0; sx < sx1; sx++) sum += data[row + sx]
      }
      out[oy * ow + ox] = sum / ((sy1 - sy0) * (sx1 - sx0))
    }
  }
  return { data: out, width: ow, height: oh }
}

/** Separable 3x3 box blur (replicate borders). */
export function boxBlur3(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img
  const tmp = new Uint16Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const l = data[row + Math.max(0, x - 1)]
      const c = data[row + x]
      const r = data[row + Math.min(w - 1, x + 1)]
      tmp[row + x] = l + c + r
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w
    const mid = y * w
    const dn = Math.min(h - 1, y + 1) * w
    for (let x = 0; x < w; x++) {
      out[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 9
    }
  }
  return { data: out, width: w, height: h }
}
