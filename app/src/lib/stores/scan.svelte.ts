import type { Point } from '../cv/image'
import type { GridSize } from '../solver/board'
import { createRpcClient, RpcTimeoutError, type RpcClient } from '../workers/rpc'
import type { FrameView, ScanStage, WorkerScanResult, WorkerScanSuccess } from '../ocr/scan.worker'
import { gridOutline, STRAIGHT_DIM, straighten } from '../ui/morph'
import { board } from './board.svelte'

/**
 * The scan flow as one state machine, shown by ScanOverlay:
 *   camera     live view (or the upload picker when there is no camera)
 *   processing the frozen frame is being read (a light sweep plays)
 *   landing    the straightened grid is flying onto the board
 *   pick-size  a grid was found but its size is unclear
 * Failures return to `camera` with a short message instead of a dead end.
 */
export type ScanStatus = 'idle' | 'camera' | 'processing' | 'landing' | 'pick-size'

/** A frozen still being read: what the user sees, and its pixels - an
 * ImageBitmap (camera captures: read in the worker, never on the main
 * thread) or an RGBA buffer (decoded uploads). */
export interface ScanFrame {
  canvas: HTMLCanvasElement
  bitmap?: ImageBitmap
  rgba?: Uint8ClampedArray
  width: number
  height: number
  /** Camera frames fill the screen (cover); uploads are shown whole. */
  fit: 'cover' | 'contain'
  /** Camera captures: the part of the frame that was on screen. The capture
   * reaches a little past it, so a grid just over the edge still reads. */
  view?: FrameView
}


/** The decoded original photo, when the scanned frame is a downscale of it,
 * so a small grid can be re-read from a full-resolution crop. */
export interface ScanSource {
  draw: (ctx: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) => void
  width: number
  height: number
}

/** Fewest clues a real puzzle of each size has (9x9: 17 is the proven
 * minimum for a unique solution; 16x16 is a conservative floor). A read
 * with fewer found the wrong region - a fragment, a whole page - or missed
 * most digits, and is retaken rather than landed. */
const MIN_CLUES: Record<number, number> = { 4: 4, 9: 17, 16: 40 }

/** Longest side of what the worker receives. */
export const SCAN_MAX_DIM = 1600
/** A chosen grid covering less of the frame than this gets a full-res pass. */
const REFINE_COVERAGE = 0.3
/** A scan that has not answered by now is treated as lost (a worker the
 * browser killed for memory never replies): the worker is replaced. */
const SCAN_TIMEOUT_MS = 20_000
/** Downloading the runtime + models on a slow connection. */
const WARMUP_TIMEOUT_MS = 90_000

const MESSAGES = {
  noGrid: "Couldn't find a sudoku. Fit the whole grid in view.",
  sparse: "Couldn't read enough digits. Fill more of the view and hold steady.",
  timeout: 'That took too long. Try again, a little closer.',
  error: 'Something went wrong reading that. Try again.',
} as const

/** Workers can draw and encode images themselves (OffscreenCanvas 2D). */
const OFFSCREEN = typeof OffscreenCanvasRenderingContext2D !== 'undefined'

class ScanStore {
  status = $state<ScanStatus>('idle')
  stage = $state<ScanStage | null>(null)
  /** The still being read or landed (raw: pixel buffers, not reactive). */
  frame = $state.raw<ScanFrame | null>(null)
  /** Outline shown on the frozen frame: the live lock, then the detected grid. */
  quad = $state.raw<Point[] | null>(null)
  /** The read being landed. */
  result = $state.raw<WorkerScanSuccess | null>(null)
  /** Straightened colour photo of the chosen grid. */
  straight = $state.raw<HTMLCanvasElement | null>(null)
  /** Short guidance after a failed read (shown over the camera). */
  message = $state<string | null>(null)
  /** Where the scanner was opened from (a button's box), for the opening
   * to grow out of it. */
  origin = $state.raw<DOMRect | null>(null)

  #client: RpcClient | null = null
  /** Resolves once the worker has its runtime and models (first use can be
   * a slow download; the scan timeout only starts after it). */
  #ready: Promise<void> | null = null
  #source: ScanSource | null = null
  #refined = new Set<number>()
  #generation = 0
  /** Object URL of the board's compare photo (revoked when replaced). */
  #photoUrl: string | null = null
  /** The frame's pixels kept on this thread, only where the worker cannot
   * straighten the photo itself (no OffscreenCanvas). */
  #pixels: Uint8ClampedArray | null = null
  /** The read waiting to go onto the board once the landing is in flight. */
  #toBoard: Parameters<typeof board.loadScan>[0] | null = null

  #worker(): RpcClient {
    this.#client ??= createRpcClient(
      new Worker(new URL('../ocr/scan.worker.ts', import.meta.url), { type: 'module' }),
    )
    return this.#client
  }

  async #call<T>(method: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    await this.#whenReady()
    return this.#worker()
      .call<T>(method, args, transfer, (stage) => (this.stage = stage as ScanStage), SCAN_TIMEOUT_MS)
      .catch((err: unknown) => {
        // A stuck or dead worker is replaced; its kept grids go with it.
        this.#client?.terminate()
        this.#client = null
        this.#ready = null
        throw err
      })
  }

  /** Preload wasm + models (when the camera opens). */
  warmup(): void {
    void this.#whenReady()
  }

  #whenReady(): Promise<void> {
    this.#ready ??= this.#worker()
      .call('warmup', [], [], undefined, WARMUP_TIMEOUT_MS)
      .then(
        () => undefined,
        () => {
          // Let the scan itself try (and time out) rather than block here.
          this.#ready = null
        },
      )
    return this.#ready
  }

  /** Open the scanner; `from` is the element that opened it. */
  open(from: Element | null = null): void {
    const opening = this.status === 'idle'
    this.message = null
    this.origin = opening && from ? from.getBoundingClientRect() : null
    this.status = 'camera'
    // Model loading starts after the opening has painted.
    requestAnimationFrame(() => setTimeout(() => this.warmup(), 0))
  }

  close(): void {
    this.#generation++
    this.#reset()
    this.status = 'idle'
  }

  /** Read a frozen still. `hint`: the live outline in frame px, if locked. */
  async read(frame: ScanFrame, hint: Point[] | null, source: ScanSource | null = null): Promise<void> {
    const gen = ++this.#generation
    this.#reset()
    this.frame = frame
    this.quad = hint
    this.#source = source
    this.status = 'processing'
    this.stage = 'detect'
    try {
      // A camera capture is read aimed at the middle of what was on screen.
      const view = frame.fit === 'cover' ? (frame.view ?? { x: 0, y: 0, w: frame.width, h: frame.height }) : null
      let input: Uint8Array | ImageBitmap
      if (frame.bitmap) {
        input = frame.bitmap
      } else {
        // Moved, not copied, when the worker makes the photo itself.
        this.#pixels = OFFSCREEN ? null : new Uint8ClampedArray(frame.rgba!)
        input = new Uint8Array(frame.rgba!.buffer)
      }
      let result = await this.#call<WorkerScanResult>('scan', [input, frame.width, frame.height, hint, view], [input instanceof ImageBitmap ? input : input.buffer])
      if (gen !== this.#generation) return
      if (result.ok && this.#needsRefine(result)) {
        const refined = await this.#refine(result).catch(() => null)
        if (gen !== this.#generation) return
        if (refined) result = refined
      }
      this.#apply(result)
    } catch (err) {
      if (gen !== this.#generation) return
      this.#retry(err instanceof RpcTimeoutError ? MESSAGES.timeout : MESSAGES.error)
    }
  }

  /** Continue after the user picked a size for an ambiguous grid. */
  async chooseSize(size: GridSize): Promise<void> {
    const gen = ++this.#generation
    this.status = 'processing'
    this.stage = 'read'
    try {
      const result = await this.#call<WorkerScanResult>('scanWithSize', [size])
      if (gen === this.#generation) this.#apply(result)
    } catch (err) {
      if (gen === this.#generation) this.#retry(err instanceof RpcTimeoutError ? MESSAGES.timeout : MESSAGES.error)
    }
  }

  /** Switch the board to another puzzle found in the same photo. */
  async pickGrid(index: number): Promise<void> {
    const r = this.result
    if (!r || !this.frame || index === r.chosen || !r.grids[index]) return
    const gen = ++this.#generation
    try {
      let result = await this.#call<WorkerScanResult>('scanGrid', [index])
      if (gen !== this.#generation) return
      if (result.ok && this.#needsRefine(result)) result = (await this.#refine(result).catch(() => null)) ?? result
      if (gen !== this.#generation || !result.ok) return
      this.#land(result, true)
    } catch {
      /* the board keeps the current puzzle */
    }
  }

  /** The landing animation finished: the board now shows the puzzle. */
  landed(): void {
    if (this.status !== 'landing') return
    this.toBoard()
    this.status = 'idle'
    this.frame = null
    this.quad = null
  }

  #apply(result: WorkerScanResult): void {
    this.stage = null
    if (!result.ok) {
      if (result.reason === 'ambiguous-size') {
        this.quad = result.corners ?? this.quad
        this.status = 'pick-size'
      } else {
        this.#retry(MESSAGES.noGrid)
      }
      return
    }
    const clues = result.reading.values.filter((v) => v !== 0).length
    if (clues < (MIN_CLUES[result.size] ?? 0)) {
      this.#retry(MESSAGES.sparse)
      return
    }
    this.#land(result, false)
  }

  /** Hand a read to the board. `instant`: switching puzzles on the board. */
  #land(result: WorkerScanSuccess, instant: boolean): void {
    const frame = this.frame!
    this.result = result
    // The grid's own border, not the detected outline: the outline can sit a
    // little loose (the reader finds the real lines inside it), and a photo
    // cut from it lands misaligned before the digits snap into place.
    const outline = gridOutline(result.corners, result.rowLines, result.colLines)
    this.quad = outline
    let photo: string
    if (result.straight && result.photo) {
      const canvas = document.createElement('canvas')
      canvas.width = STRAIGHT_DIM
      canvas.height = STRAIGHT_DIM
      canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(result.straight)
      this.straight = canvas
      if (this.#photoUrl) URL.revokeObjectURL(this.#photoUrl)
      photo = this.#photoUrl = URL.createObjectURL(result.photo)
    } else {
      this.straight = straighten(this.#pixels ?? new Uint8ClampedArray(0), frame.width, frame.height, outline, STRAIGHT_DIM)
      photo = this.straight.toDataURL('image/jpeg', 0.86)
    }
    const read = {
      size: result.size,
      convention: result.convention,
      values: result.reading.values,
      flags: result.reading.flags,
      unique: result.reading.unique,
      photo,
      others: result.grids.length - 1,
      chosen: result.chosen,
      hold: !instant,
    }
    if (instant) {
      board.loadScan(read)
      return
    }
    // The board update is heavy (every cell re-renders): it happens once the
    // landing is flying on the compositor (toBoard), not before it starts.
    this.#toBoard = read
    this.status = 'landing'
  }

  /** Put the landing read on the board (hidden until revealScan). */
  toBoard(): void {
    if (this.#toBoard) board.loadScan(this.#toBoard)
    this.#toBoard = null
  }

  /** Back to the live camera with a hint of what to change. */
  #retry(message: string): void {
    this.stage = null
    this.frame = null
    this.quad = null
    this.message = message
    this.status = 'camera'
  }

  #reset(): void {
    this.stage = null
    this.frame = null
    this.quad = null
    this.result = null
    this.straight = null
    this.message = null
    this.#source = null
    this.#pixels = null
    this.#refined = new Set()
  }

  #needsRefine(result: WorkerScanSuccess): boolean {
    const frame = this.frame
    if (!this.#source || !frame || this.#refined.has(result.chosen)) return false
    // Nothing to gain unless the original really is larger than the scan.
    if (this.#source.width <= frame.width * 1.15) return false
    const xs = result.corners.map((p) => p.x)
    const ys = result.corners.map((p) => p.y)
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
    return area / (frame.width * frame.height) < REFINE_COVERAGE
  }

  async #refine(result: WorkerScanSuccess): Promise<WorkerScanResult | null> {
    const source = this.#source!
    const frame = this.frame!
    this.#refined.add(result.chosen)
    // Scan px -> source px, with a margin around the grid.
    const toSource = source.width / frame.width
    const xs = result.corners.map((p) => p.x)
    const ys = result.corners.map((p) => p.y)
    const margin = 0.2
    const w = Math.max(...xs) - Math.min(...xs)
    const h = Math.max(...ys) - Math.min(...ys)
    const sx0 = Math.max(0, Math.min(...xs) - w * margin)
    const sy0 = Math.max(0, Math.min(...ys) - h * margin)
    const sw = Math.min(frame.width - sx0, w * (1 + 2 * margin))
    const sh = Math.min(frame.height - sy0, h * (1 + 2 * margin))
    const cap = Math.min(1, SCAN_MAX_DIM / Math.max(sw * toSource, sh * toSource))
    const k = toSource * cap // crop px per scan px
    if (k <= 1.15) return null
    const cw = Math.round(sw * k)
    const ch = Math.round(sh * k)
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    source.draw(ctx, sx0 * toSource, sy0 * toSource, sw * toSource, sh * toSource, cw, ch)
    const data = ctx.getImageData(0, 0, cw, ch)
    canvas.width = 0
    canvas.height = 0
    const buf = new Uint8Array(data.data)
    return this.#call<WorkerScanResult>('refine', [buf, cw, ch, result.chosen, { x: sx0, y: sy0 }, k], [buf.buffer])
  }
}

export const scan = new ScanStore()
