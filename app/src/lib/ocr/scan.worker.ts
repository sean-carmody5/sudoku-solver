/**
 * Scan worker: full still-image path (grid detection in either polarity,
 * warp, cell extraction, classification, convention resolution, repair) off
 * the main thread.
 *
 * Results carry the chosen grid's corners in the scanned image's own pixels
 * and, where workers have OffscreenCanvas, the straightened colour photo (a
 * bitmap for the landing, a JPEG for the compare view), so the main thread
 * neither resamples nor encodes anything. A camera frame arrives as an
 * ImageBitmap and its pixels are read here, off the main thread. A page can
 * hold several puzzles: every verified grid is
 * kept here so the user can switch without re-scanning. A grid that is a
 * small part of the frame can be re-read from a full-resolution crop of the
 * original (see `refine`).
 */

import { serveRpc, transferring, type RpcContext } from '../workers/rpc'
import { grayFromRgba, type GrayImage, type Point } from '../cv/image'
import type { CellTensor } from '../cv/cells'
import { runDetector } from '../cv/detectSession'
import { gridCells, locateGrid, processWithKnownSize, type Proposal, type VerifiedGrid } from '../cv/pipeline'
import type { Convention, GridSize } from '../solver/board'
import { classifyGlyphs } from './classify'
import { detectConvention, glyphsToReadings } from './convention'
import { repairGrid, type RepairResult } from './repair'
import { browserRunner } from './session'
import { gridOutline, STRAIGHT_DIM, straightenPixels } from '../ui/morph'

/** Stages reported while a scan runs, in order. */
export type ScanStage = 'detect' | 'read' | 'check'

/** A puzzle found on the page, for the "other puzzles" picker. */
export interface FoundGrid {
  size: GridSize
  /** Corners in scanned-image pixels (tl, tr, br, bl). */
  corners: Point[]
}

/** A region of a frame, in its px. */
export interface FrameView {
  x: number
  y: number
  w: number
  h: number
}

export interface WorkerScanSuccess {
  ok: true
  size: GridSize
  convention: Convention
  reading: RepairResult
  sizeConfidence: number
  /** The chosen grid's corners in scanned-image pixels (tl, tr, br, bl). */
  corners: Point[]
  /** Grid lines as fractions (0..1) of the straightened grid's side. */
  rowLines: number[]
  colLines: number[]
  /** Read from the negative (a dark-mode screen). */
  inverted: boolean
  /** Every distinct puzzle on the page, best first; `chosen` indexes it. */
  grids: FoundGrid[]
  chosen: number
  /** The straightened colour photo of the grid (absent where workers lack
   * OffscreenCanvas: the main thread then makes it). */
  straight?: ImageBitmap
  photo?: Blob
}

export interface WorkerScanFailure {
  ok: false
  reason: 'no-grid' | 'ambiguous-size'
  /** For ambiguous-size: the grid outline, so the UI can show what it saw. */
  corners?: Point[]
}

export type WorkerScanResult = WorkerScanSuccess | WorkerScanFailure

/** Confidence given to the live camera's locked outline: what the user saw
 * outlined is what gets read, unless verification rejects it. */
const HINT_SCORE = 0.95

let pendingGrids: VerifiedGrid[] = []
/** The frame being read, for straightening the chosen grid's photo. */
let image: { rgba: Uint8ClampedArray | Uint8Array; width: number; height: number } | null = null

const OFFSCREEN = typeof OffscreenCanvas !== 'undefined'

function bitmapPixels(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return ctx.getImageData(0, 0, width, height).data
}

/** The grid's photo straightened from its own border (not the detected
 * outline, which can sit a little loose). */
async function withPhoto(result: WorkerScanSuccess): Promise<WorkerScanSuccess> {
  if (!OFFSCREEN || !image) return result
  const outline = gridOutline(result.corners, result.rowLines, result.colLines)
  const px = straightenPixels(image.rgba, image.width, image.height, outline, STRAIGHT_DIM)
  const canvas = new OffscreenCanvas(STRAIGHT_DIM, STRAIGHT_DIM)
  canvas.getContext('2d')!.putImageData(new ImageData(px, STRAIGHT_DIM, STRAIGHT_DIM), 0, 0)
  const photo = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
  const straight = canvas.transferToImageBitmap()
  return transferring({ ...result, straight, photo }, [straight])
}
let pendingInverted = false
let pendingAmbiguous: { warped: GrayImage; corners: Point[]; inverted: boolean } | null = null

/** Bounding-box intersection over union of two quads. */
function quadIoU(a: Point[], b: Point[]): number {
  const bbox = (q: Point[]) => {
    const xs = q.map((p) => p.x)
    const ys = q.map((p) => p.y)
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }
  const p = bbox(a)
  const q = bbox(b)
  const ix = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0))
  const iy = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0))
  const inter = ix * iy
  const union = (p.x1 - p.x0) * (p.y1 - p.y0) + (q.x1 - q.x0) * (q.y1 - q.y0) - inter
  return union > 0 ? inter / union : 0
}

function proposer(hint: Point[] | null): (img: GrayImage) => Promise<Proposal[]> {
  return async (img) => {
    const dets = (await runDetector(img)) ?? []
    return hint ? [{ corners: hint, score: HINT_SCORE }, ...dets] : dets
  }
}

async function analyse(
  cells: CellTensor[],
  size: GridSize,
  ctx: RpcContext,
): Promise<{ reading: RepairResult; convention: Convention }> {
  const runner = await browserRunner()
  ctx.progress('read')
  const glyphs = await classifyGlyphs(cells, size, runner)
  const convention = detectConvention(glyphs, size)
  const readings = glyphsToReadings(glyphs, size, convention)
  ctx.progress('check')
  return { reading: repairGrid(readings, size), convention }
}

async function readGrid(index: number, ctx: RpcContext): Promise<WorkerScanSuccess> {
  const grid = pendingGrids[index]
  const { reading, convention } = await analyse(gridCells(grid), grid.size, ctx)
  const dim = grid.warped.width
  return withPhoto({
    ok: true,
    size: grid.size,
    convention,
    reading,
    sizeConfidence: grid.sizeConfidence,
    corners: grid.corners,
    rowLines: grid.rowLines.map((v) => v / dim),
    colLines: grid.colLines.map((v) => v / dim),
    inverted: pendingInverted,
    grids: pendingGrids.map((g) => ({ size: g.size, corners: g.corners })),
    chosen: index,
  })
}

serveRpc({
  /** Warm the wasm runtime + models while the user is still framing. */
  warmup: async () => {
    await browserRunner()
    await runDetector({ data: new Uint8Array(64 * 64).fill(128), width: 64, height: 64 })
    return true
  },

  /** `hint`: the live camera's outline (scanned-image px), if it had one.
   * `view`: for a framed capture (not a photo of a page: no page search),
   * the part of the image that was on screen. */
  scan: async (
    input: Uint8Array | ImageBitmap,
    width: number,
    height: number,
    hint: Point[] | null,
    view: FrameView | null,
    ctx: RpcContext,
  ): Promise<WorkerScanResult> => {
    ctx.progress('detect')
    const rgba = input instanceof Uint8Array ? input : bitmapPixels(input, width, height)
    image = { rgba, width, height }
    const gray = grayFromRgba(rgba, width, height)
    // A camera capture is one framed puzzle: no page search for neighbours.
    const result = await locateGrid(gray, proposer(hint), {
      pageSearch: !view,
      prefer: hint ?? undefined,
      aim: view && !hint ? { x: view.x + view.w / 2, y: view.y + view.h / 2 } : undefined,
    })
    pendingGrids = []
    pendingAmbiguous = null
    if (!result.ok) {
      if (result.reason === 'ambiguous-size' && result.warped && result.corners) {
        pendingAmbiguous = { warped: result.warped, corners: result.corners, inverted: !!result.inverted }
      }
      return { ok: false, reason: result.reason, corners: result.corners }
    }
    const { alternatives, inverted, ...chosen } = result
    pendingInverted = !!inverted
    pendingGrids = [chosen, ...alternatives]
    return readGrid(0, ctx)
  },

  /** Read another of the puzzles found on the page. */
  scanGrid: async (index: number, ctx: RpcContext): Promise<WorkerScanResult> => {
    if (!pendingGrids[index]) return { ok: false, reason: 'no-grid' }
    return readGrid(index, ctx)
  },

  /**
   * Second pass at full resolution. The main thread caps scans at 1600px,
   * which starves a grid that is a small part of a page photo; it then
   * sends a crop of the ORIGINAL around the chosen grid. `origin` is the
   * crop's top-left in scan-image px and `k` its px per scan px. The refined
   * grid replaces the chosen one (its outline is mapped back to scan space)
   * and is read straight away.
   */
  refine: async (
    rgba: Uint8Array,
    width: number,
    height: number,
    index: number,
    origin: Point,
    k: number,
    ctx: RpcContext,
  ): Promise<WorkerScanResult> => {
    const target = pendingGrids[index]
    if (!target) return { ok: false, reason: 'no-grid' }
    ctx.progress('detect')
    const gray = grayFromRgba(rgba, width, height)
    const toCrop = (p: Point): Point => ({ x: (p.x - origin.x) * k, y: (p.y - origin.y) * k })
    const result = await locateGrid(gray, proposer(target.corners.map(toCrop)))
    if (result.ok) {
      const { alternatives, ...grid } = result
      const toScan = (p: Point): Point => ({ x: origin.x + p.x / k, y: origin.y + p.y / k })
      // Only accept a grid that is the one we cropped around.
      const match = [grid, ...alternatives].find(
        (g) => quadIoU(g.corners.map(toScan), target.corners) > 0.5,
      )
      if (match) {
        pendingGrids[index] = { ...match, cells: gridCells(match), corners: match.corners.map(toScan) }
      }
    }
    return readGrid(index, ctx)
  },

  /** Re-run cell extraction on the kept warp with a user-chosen size. */
  scanWithSize: async (size: GridSize, ctx: RpcContext): Promise<WorkerScanResult> => {
    const kept = pendingAmbiguous
    if (!kept) return { ok: false, reason: 'no-grid' }
    const { cells, lines } = processWithKnownSize(kept.warped, size)
    const { reading, convention } = await analyse(cells, size, ctx)
    const dim = kept.warped.width
    const frac = lines.map((v) => v / dim)
    return withPhoto({
      ok: true,
      size,
      convention,
      reading,
      sizeConfidence: 1,
      corners: kept.corners,
      rowLines: frac,
      colLines: frac,
      inverted: kept.inverted,
      grids: [{ size, corners: kept.corners }],
      chosen: 0,
    })
  },
})
