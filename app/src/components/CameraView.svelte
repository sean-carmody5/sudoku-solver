<script lang="ts">
  import { onMount } from 'svelte'
  import { openCamera, type CameraError, type CameraHandle } from '../lib/camera/stream'
  import type { DetectRequest, DetectResponse } from '../lib/cv/detect.worker'
  import type { Point } from '../lib/cv/image'
  import type { FrameView } from '../lib/ocr/scan.worker'
  import { SCAN_MAX_DIM, type ScanFrame } from '../lib/stores/scan.svelte'
  import { OneEuro } from '../lib/ui/oneEuro'

  interface Props {
    /** A frozen frame to read, plus the locked outline in its pixels. */
    oncapture: (frame: ScanFrame, hint: Point[] | null) => void
    onupload: (file: File) => void
    onsample: () => void
    onclose: () => void
    /** Guidance after a failed read, shown for a few seconds. */
    message?: string | null
  }

  const { oncapture, onupload, onsample, onclose, message = null }: Props = $props()

  const DETECT_DIM = 512
  /** Keep the last outline through this much silence (blur/shadow frames). */
  const HOLD_MS = 600
  /** Keep the locked styling through intermittent verification misses. */
  const LOCK_LATCH_MS = 1200
  /** Show brackets at this score; keep an existing outline down to KEEP. */
  const SHOW_SCORE = 0.6
  const KEEP_SCORE = 0.45
  /** Locked and this still for this long: capture without a tap. */
  const AUTO_CAPTURE_MS = 700
  /** No lock for this long: suggest tapping the shutter. */
  const STALL_HINT_MS = 4500
  /** Hand-held steadiness: over the last STEADY_WINDOW_MS the (smoothed)
   * outline may wander this share of the grid's side and still count as
   * held still - normal hand tremor and drift pass, re-aiming does not. */
  const STEADY_WINDOW_MS = 400
  const STEADY_DRIFT = 0.1
  /** Frames grabbed on capture; the sharpest is read (hand shake blurs some). */
  const BURST_FRAMES = 3
  /** Detection and capture reach this share of the view past each edge,
   * where the sensor has it: a grid that just overflows the screen still
   * locks and reads whole. */
  const REACH = 0.1
  /** Zoom cap: the camera's own zoom where it has one, else a digital crop. */
  const MAX_ZOOM = 5
  const MAX_DIGITAL_ZOOM = 3
  /** Reply watchdog: strict once the worker has proven alive, generous while
   * it is still downloading the runtime + model on a slow connection. */
  const REPLY_TIMEOUT_MS = 2500
  const COLD_REPLY_TIMEOUT_MS = 12000

  let videoEl = $state<HTMLVideoElement>() as HTMLVideoElement
  let overlayEl = $state<HTMLCanvasElement>() as HTMLCanvasElement
  let fileInput = $state<HTMLInputElement>() as HTMLInputElement
  let handle: CameraHandle | null = null
  let error = $state<CameraError | null>(null)
  let starting = $state(true)
  let torchOn = $state(false)
  let hasTorch = $state(false)
  let detected = $state(false)
  let locked = $state(false)
  let edge = $state(false)
  /** 0..1 progress of the auto-capture hold (drives the ring). */
  let steady = $state(0)
  let flashing = $state(false)
  let shownMessage = $state<string | null>(null)
  /** Worker repeatedly failing: preview + shutter still work, say so. */
  let detectionDead = $state(false)
  /** No lock for a while: the shutter still works, so say so. */
  let stalled = $state(false)
  let lastLockOrStartAt = 0
  /** Pinch or the zoom pill. With no camera zoom the preview is scaled and
   * detection and capture read the same centre crop, so what is seen is
   * what is read. */
  let zoom = $state(1)
  let hwZoom = $state<{ min: number; max: number } | null>(null)
  const digitalZoom = $derived(hwZoom ? 1 : zoom)
  const zoomMax = $derived(hwZoom ? Math.min(MAX_ZOOM, hwZoom.max) : MAX_DIGITAL_ZOOM)
  const zoomLabel = $derived(`${zoom < 1.05 ? '1' : zoom.toFixed(1).replace(/\.0$/, '')}×`)
  /** Bumped on every zoom change; detections sent before it are stale. */
  let zoomGen = 0
  let zoomApplying = false
  let zoomDirty = false
  const pointers = new Map<number, { x: number; y: number }>()
  let pinch: { spread: number; zoom: number } | null = null

  let worker: Worker | null = null
  let workerBusy = false
  let sentAt = 0
  let workerFailures = 0
  let workerSucceeded = false
  let frameCanvas: HTMLCanvasElement | null = null
  /** Frames cropped and scaled on the GPU (createImageBitmap) with their
   * pixels read in the workers. Off until a probe shows the browser honours
   * the resize options (one that ignores them would hand the worker whole
   * sensor frames), and off where workers cannot draw (no OffscreenCanvas)
   * or the browser refuses a video source. */
  let bitmapFrames = false
  async function probeBitmapFrames(): Promise<boolean> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvasRenderingContext2D === 'undefined') return false
    try {
      const b = await createImageBitmap(new ImageData(8, 8), { resizeWidth: 4, resizeHeight: 4, resizeQuality: 'low' })
      const ok = b.width === 4 && b.height === 4
      b.close()
      return ok
    } catch {
      return false
    }
  }
  let freezeEl = $state<HTMLCanvasElement>()
  let frozen = $state(false)
  let targetCorners: Point[] | null = null
  let shownCorners: Point[] | null = null
  let shownAlpha = 0
  let lockMix = 0
  let lastGoodAt = 0
  let lastLockedAt = 0
  let lockPulseAt = 0
  let wasLocked = false
  let lastPumpAt = 0
  let steadySince = 0
  /** Recent smoothed outlines, for the steadiness window. */
  let recent: { t: number; q: Point[] }[] = []
  /** Per-corner smoothing (x and y of each of the four corners). */
  const smooth = Array.from({ length: 8 }, () => new OneEuro())
  /** The in-flight request: detect px -> source px, and where the visible
   * crop starts in the region sent. */
  let sentCrop = { srcPerDetect: 1, ox: 0, oy: 0, gen: 0 }
  let captured = false
  let rafId = 0
  let videoFrameId = 0
  let safetyTimer: ReturnType<typeof setInterval> | undefined
  let messageTimer: ReturnType<typeof setTimeout> | undefined
  /** Theme colours as plain rgb triples (read once; the canvas gets rgba()
   * strings, never color-mix(), which some canvases reject silently). */
  let accentRgb = [45, 212, 191]
  let accent2Rgb = [56, 189, 248]
  const rgba = (c: number[], a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`

  function readColour(name: string, fallback: number[]): number[] {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const m = getComputedStyle(probe).color.match(/[\d.]+/g)
    probe.remove()
    return m && m.length >= 3 ? m.slice(0, 3).map(Number) : fallback
  }

  const guide = $derived.by(() => {
    if (shownMessage) return { text: shownMessage, tone: 'warn' }
    if (starting) return { text: 'Starting camera…', tone: '' }
    if (detectionDead) return { text: 'Tap the shutter to scan', tone: '' }
    if (locked && edge) return { text: 'Move back to fit the whole grid', tone: 'warn' }
    if (locked) return { text: 'Hold steady', tone: 'ok' }
    if (stalled && detected) return { text: 'Tap the shutter to scan', tone: '' }
    if (detected) return { text: 'Lining up…', tone: '' }
    return { text: 'Point at a sudoku', tone: '' }
  })

  $effect(() => {
    if (!message) return
    shownMessage = message
    clearTimeout(messageTimer)
    messageTimer = setTimeout(() => (shownMessage = null), 3800)
  })

  /**
   * The region of the sensor frame the user actually sees: the video element
   * is object-fit: cover, so a portrait phone shows only a centre crop of the
   * (usually landscape) sensor. Detection and capture use this region.
   */
  function visibleCrop(): { sx: number; sy: number; sw: number; sh: number } {
    const vw = videoEl.videoWidth
    const vh = videoEl.videoHeight
    // Layout size: the digital zoom's CSS scale does not change it.
    const bw = videoEl.clientWidth
    const bh = videoEl.clientHeight
    if (!bw || !bh) return { sx: 0, sy: 0, sw: vw, sh: vh }
    const scale = Math.max(bw / vw, bh / vh) * digitalZoom
    const sw = Math.min(vw, bw / scale)
    const sh = Math.min(vh, bh / scale)
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh }
  }

  /** The visible crop widened by REACH within the sensor frame, and where
   * the visible crop sits inside it (source px). */
  function reachCrop(): { sx: number; sy: number; sw: number; sh: number; view: FrameView } {
    const v = visibleCrop()
    const sx = Math.max(0, v.sx - v.sw * REACH)
    const sy = Math.max(0, v.sy - v.sh * REACH)
    const sw = Math.min(videoEl.videoWidth, v.sx + v.sw * (1 + REACH)) - sx
    const sh = Math.min(videoEl.videoHeight, v.sy + v.sh * (1 + REACH)) - sy
    return { sx, sy, sw, sh, view: { x: v.sx - sx, y: v.sy - sy, w: v.sw, h: v.sh } }
  }

  function setZoom(z: number): void {
    const next = Math.min(zoomMax, Math.max(1, z))
    if (Math.abs(next - zoom) < 0.01) return
    zoom = next
    // The outline so far is in the old zoom's pixels: start the lock afresh.
    zoomGen++
    targetCorners = null
    shownCorners = null
    shownAlpha = 0
    prevAccepted = null
    heldCorner = -1
    edge = false
    lastGoodAt = 0
    lastLockedAt = 0
    steadySince = 0
    recent = []
    for (const f of smooth) f.reset()
    if (hwZoom) void applyHwZoom()
  }

  /** One constraint change at a time; a pinch fires far faster than that. */
  async function applyHwZoom(): Promise<void> {
    zoomDirty = true
    if (zoomApplying) return
    zoomApplying = true
    while (zoomDirty) {
      zoomDirty = false
      await handle?.setZoom(zoom)
    }
    zoomApplying = false
  }

  const spread = (): number => {
    const [a, b] = [...pointers.values()]
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) pinch = { spread: spread(), zoom }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && pointers.size === 2) setZoom((pinch.zoom * spread()) / pinch.spread)
  }

  function onPointerUp(e: PointerEvent): void {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
  }

  function capture(): void {
    if (captured || !videoEl?.videoWidth) return
    captured = true
    const { sx, sy, sw, sh } = visibleCrop()
    const r = reachCrop()
    const scale = Math.min(1, SCAN_MAX_DIM / Math.max(r.sw, r.sh))
    // The locked outline and the on-screen region, in the captured frame's px.
    const hint =
      locked && targetCorners && !edge
        ? targetCorners.map((p) => ({ x: (p.x + r.view.x) * scale, y: (p.y + r.view.y) * scale }))
        : null
    const view = { x: r.view.x * scale, y: r.view.y * scale, w: sw * scale, h: sh * scale }
    freeze(sx, sy, sw, sh)
    flashing = true
    try {
      navigator.vibrate?.(18)
    } catch {
      /* not available - fine */
    }
    void burst(r.sx, r.sy, r.sw, r.sh, scale, hint, view)
  }

  /** Hold what the user saw at the shutter: the burst reads the next few
   * frames, which must not play on screen. */
  function freeze(sx: number, sy: number, sw: number, sh: number): void {
    if (!freezeEl) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    freezeEl.width = Math.round(videoEl.clientWidth * dpr)
    freezeEl.height = Math.round(videoEl.clientHeight * dpr)
    freezeEl.getContext('2d')!.drawImage(videoEl, sx, sy, sw, sh, 0, 0, freezeEl.width, freezeEl.height)
    frozen = true
  }

  /** Grab a few consecutive frames and hand on the sharpest: a hand-held
   * phone blurs some frames, and a blurred capture is what gets misread.
   * Frames are cropped and scaled on the GPU and read in the scan worker, so
   * the shutter never stalls the page. */
  async function burst(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    scale: number,
    hint: Point[] | null,
    view: FrameView,
  ): Promise<void> {
    const w = Math.round(sw * scale)
    const h = Math.round(sh * scale)
    if (bitmapFrames) {
      const shots: ImageBitmap[] = []
      try {
        for (let i = 0; i < BURST_FRAMES; i++) {
          if (i > 0) await nextFrame()
          if (!videoEl?.videoWidth) break
          shots.push(await createImageBitmap(videoEl, sx, sy, sw, sh, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }))
        }
      } catch {
        for (const s of shots) s.close()
        shots.length = 0
        bitmapFrames = false
      }
      if (shots.length > 0) {
        stopAll()
        const best = sharpest(shots, hint, w, h)
        for (const s of shots) if (s !== best) s.close()
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')!.drawImage(best, 0, 0, w, h)
        testHook(canvas, hint, view)
        oncapture({ canvas, bitmap: best, width: w, height: h, fit: 'cover', view }, hint)
        return
      }
    }
    let best: { canvas: HTMLCanvasElement; data: ImageData; score: number } | null = null
    for (let i = 0; i < BURST_FRAMES; i++) {
      if (i > 0) await nextFrame()
      if (!videoEl?.videoWidth) break
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h)
      const score = focus(data, region(hint, w, h))
      if (!best || score > best.score) {
        if (best) best.canvas.width = 0
        best = { canvas, data, score }
      } else {
        canvas.width = 0
      }
    }
    stopAll()
    if (!best) {
      onclose()
      return
    }
    testHook(best.canvas, hint, view)
    oncapture({ canvas: best.canvas, rgba: best.data.data, width: w, height: h, fit: 'cover', view }, hint)
  }

  /** Test hook (scripts/screen/e2e-live-scan.mjs): the frame read, its hint and view. */
  function testHook(canvas: HTMLCanvasElement, hint: Point[] | null, view: FrameView): void {
    const test = window as unknown as { __camTrace?: unknown[]; __camCapture?: unknown }
    if (test.__camTrace && (window as unknown as { __camCaptureWanted?: boolean }).__camCaptureWanted) test.__camCapture = { png: canvas.toDataURL('image/png'), hint, view }
  }

  function nextFrame(): Promise<void> {
    const video = videoEl as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    return new Promise((resolve) => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve())
      else setTimeout(resolve, 40)
    })
  }

  /** The part of a w x h frame that matters for focus: the grid's bounding
   * box, or the middle of the frame. */
  function region(hint: Point[] | null, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
    if (!hint) return { x0: w * 0.2, y0: h * 0.3, x1: w * 0.8, y1: h * 0.7 }
    return {
      x0: Math.max(1, Math.min(...hint.map((p) => p.x))),
      y0: Math.max(1, Math.min(...hint.map((p) => p.y))),
      x1: Math.min(w - 2, Math.max(...hint.map((p) => p.x))),
      y1: Math.min(h - 2, Math.max(...hint.map((p) => p.y))),
    }
  }

  /** The sharpest shot of a burst, judged on a small copy of the grid region
   * (a few KB read back, not whole frames). */
  function sharpest(shots: ImageBitmap[], hint: Point[] | null, w: number, h: number): ImageBitmap {
    if (shots.length === 1) return shots[0]
    const r = region(hint, w, h)
    const k = shots[0].width / w
    const side = Math.max(r.x1 - r.x0, r.y1 - r.y0)
    const s = Math.min(1, 360 / side)
    const cw = Math.max(8, Math.round((r.x1 - r.x0) * s))
    const ch = Math.max(8, Math.round((r.y1 - r.y0) * s))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    let best = shots[0]
    let bestScore = -1
    for (const shot of shots) {
      ctx.drawImage(shot, r.x0 * k, r.y0 * k, (r.x1 - r.x0) * k, (r.y1 - r.y0) * k, 0, 0, cw, ch)
      const score = focus(ctx.getImageData(0, 0, cw, ch), { x0: 1, y0: 1, x1: cw - 2, y1: ch - 2 })
      if (score > bestScore) {
        bestScore = score
        best = shot
      }
    }
    canvas.width = 0
    return best
  }

  /** Focus measure: mean squared Laplacian of the luma over a region,
   * sampled on a coarse lattice. */
  function focus(img: ImageData, r: { x0: number; y0: number; x1: number; y1: number }): number {
    const { width: w, data } = img
    const step = Math.max(1, Math.round(Math.min(r.x1 - r.x0, r.y1 - r.y0) / 160))
    const luma = (x: number, y: number): number => {
      const i = (y * w + x) * 4
      return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    }
    let sum = 0
    let n = 0
    for (let y = Math.round(r.y0); y < r.y1; y += step) {
      for (let x = Math.round(r.x0); x < r.x1; x += step) {
        const lap = 4 * luma(x, y) - luma(x - 1, y) - luma(x + 1, y) - luma(x, y - 1) - luma(x, y + 1)
        sum += lap * lap
        n++
      }
    }
    return n > 0 ? sum / n : 0
  }

  function pumpFrame(): void {
    if (captured || !worker || !videoEl?.videoWidth) return
    const now = performance.now()
    if (workerBusy) {
      const limit = workerSucceeded ? REPLY_TIMEOUT_MS : COLD_REPLY_TIMEOUT_MS
      if (now - sentAt > limit) {
        workerBusy = false
        if (workerSucceeded) workerFailures++
        if (workerFailures >= 3) detectionDead = true
      } else {
        return
      }
    }
    const { sx, sy, sw, sh, view: v } = reachCrop()
    const scale = DETECT_DIM / Math.max(sw, sh)
    const w = Math.round(sw * scale)
    const h = Math.round(sh * scale)
    if (w < 8 || h < 8) return
    workerBusy = true
    sentAt = now
    lastPumpAt = now
    sentCrop = { srcPerDetect: sw / w, ox: v.x, oy: v.y, gen: zoomGen }
    // The on-screen part, in detect px: live detection aims at its centre.
    const view = { x: (v.x * w) / sw, y: (v.y * h) / sh, w: (v.w * w) / sw, h: (v.h * h) / sh }
    if (bitmapFrames) {
      const target = worker
      createImageBitmap(videoEl, sx, sy, sw, sh, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }).then(
        (bitmap) => {
          if (captured || worker !== target) {
            bitmap.close()
            workerBusy = false
            return
          }
          target.postMessage({ bitmap, width: w, height: h, view } satisfies DetectRequest, [bitmap])
        },
        () => {
          bitmapFrames = false
          workerBusy = false
        },
      )
      return
    }
    frameCanvas ??= document.createElement('canvas')
    frameCanvas.width = w
    frameCanvas.height = h
    const ctx = frameCanvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    const buffer = data.data.buffer
    worker.postMessage({ buffer, width: w, height: h, view } satisfies DetectRequest, [buffer])
  }

  let prevAccepted: Point[] | null = null
  let heldCorner = -1

  /**
   * One corner leaping while the other three hold still is a misdetection,
   * not motion (moving the phone moves all four). Hold that corner at its
   * previous position for one frame and accept only if the leap repeats.
   */
  function stabiliseSingleCorner(next: Point[]): Point[] {
    if (prevAccepted === null) {
      prevAccepted = next.map((p) => ({ ...p }))
      return next
    }
    const prev = prevAccepted
    const side = sideOf(prev)
    const d = next.map((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y))
    const jumped = d.map((v) => v > side * 0.08)
    const calm = d.map((v) => v < side * 0.03)
    const jumpIdx = jumped.findIndex(Boolean)
    if (
      jumpIdx >= 0 &&
      jumped.filter(Boolean).length === 1 &&
      calm.filter(Boolean).length === 3 &&
      heldCorner !== jumpIdx
    ) {
      heldCorner = jumpIdx
      next = next.map((p, i) => (i === jumpIdx ? { ...prev[i] } : p))
    } else {
      heldCorner = -1
    }
    prevAccepted = next.map((p) => ({ ...p }))
    return next
  }

  function sideOf(q: Point[]): number {
    return q.reduce((a, p, i) => a + Math.hypot(q[(i + 1) % 4].x - p.x, q[(i + 1) % 4].y - p.y), 0) / 4
  }

  function onDetection(msg: DetectResponse): void {
    workerBusy = false
    workerSucceeded = true
    workerFailures = 0
    detectionDead = false
    if (!videoEl?.videoWidth || captured || sentCrop.gen !== zoomGen) return
    const now = performance.now()

    const keepScore = targetCorners !== null ? KEEP_SCORE : SHOW_SCORE
    if (msg.corners && (msg.score >= keepScore || msg.size > 0)) {
      // Visible-crop-relative source px (the overlay and capture work in
      // that space; a grid overflowing the view has corners outside it).
      const { srcPerDetect, ox, oy } = sentCrop
      const raw = stabiliseSingleCorner(msg.corners.map((p) => ({ x: p.x * srcPerDetect - ox, y: p.y * srcPerDetect - oy })))
      // Detection noise (a few px frame to frame) is what made the outline
      // shimmer and the steadiness check fail on a perfectly still phone.
      targetCorners = raw.map((p, i) => ({ x: smooth[2 * i].filter(p.x, now), y: smooth[2 * i + 1].filter(p.y, now) }))
      lastGoodAt = now
      if (msg.size > 0) lastLockedAt = now
      edge = msg.edge
    } else if (now - lastGoodAt > HOLD_MS) {
      targetCorners = null
      prevAccepted = null
      heldCorner = -1
      edge = false
      for (const f of smooth) f.reset()
    }
    detected = targetCorners !== null
    locked = detected && now - lastLockedAt <= LOCK_LATCH_MS
    if (locked || lastLockOrStartAt === 0) lastLockOrStartAt = now
    stalled = !locked && now - lastLockOrStartAt > STALL_HINT_MS
    if (locked && !wasLocked) {
      lockPulseAt = now
      try {
        navigator.vibrate?.(12)
      } catch {
        /* not available - fine */
      }
    }
    wasLocked = locked

    // Auto-capture once locked, fully in view and held still: the outline
    // has stayed within a small wander over the last half second.
    if (locked && !edge && targetCorners) {
      const q = targetCorners
      recent.push({ t: now, q: q.map((p) => ({ ...p })) })
      recent = recent.filter((r) => now - r.t <= STEADY_WINDOW_MS)
      const side = Math.max(1, sideOf(q))
      const wander = Math.max(
        ...recent.map((r) => Math.max(...r.q.map((p, i) => Math.hypot(p.x - q[i].x, p.y - q[i].y)))),
      )
      if (wander > STEADY_DRIFT * side) steadySince = 0
      else if (steadySince === 0) steadySince = now
    } else {
      steadySince = 0
      recent = []
    }
  }

  function drawOverlay(): void {
    try {
      renderOverlay()
    } catch {
      // Drawing must never take down the loop - skip the frame.
    }
    if (!captured) rafId = requestAnimationFrame(drawOverlay)
  }

  function roundedQuad(ctx: CanvasRenderingContext2D, q: Point[], r: number, begin = true): void {
    if (begin) ctx.beginPath()
    const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const start = mid(q[3], q[0])
    ctx.moveTo(start.x, start.y)
    for (let i = 0; i < 4; i++) {
      const c = q[i]
      const n = q[(i + 1) % 4]
      const m = mid(c, n)
      ctx.arcTo(c.x, c.y, m.x, m.y, r)
    }
    ctx.closePath()
  }

  function renderOverlay(): void {
    const now = performance.now()
    // Auto-capture progress; fires the capture when full.
    steady = steadySince && locked && !edge ? Math.min(1, (now - steadySince) / AUTO_CAPTURE_MS) : 0
    if (steady >= 1) {
      capture()
      return
    }
    if (!overlayEl || !videoEl?.videoWidth || captured) return
    const rect = { width: videoEl.clientWidth, height: videoEl.clientHeight }
    if (rect.width < 1 || rect.height < 1) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = Math.round(rect.width * dpr)
    const H = Math.round(rect.height * dpr)
    if (overlayEl.width !== W || overlayEl.height !== H) {
      overlayEl.width = W
      overlayEl.height = H
    }
    const ctx = overlayEl.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.scale(dpr, dpr)

    const { sw, sh } = visibleCrop()
    const scale = Math.max(rect.width / sw, rect.height / sh)

    if (targetCorners) {
      const display = targetCorners.map((p) => ({ x: p.x * scale, y: p.y * scale }))
      if (!shownCorners) {
        shownCorners = display
        shownAlpha = 0
      } else {
        // 60fps glide over a ~15fps detection stream.
        for (let i = 0; i < 4; i++) {
          shownCorners[i].x += (display[i].x - shownCorners[i].x) * 0.35
          shownCorners[i].y += (display[i].y - shownCorners[i].y) * 0.35
        }
      }
      shownAlpha = Math.min(1, shownAlpha + 0.1)
    } else {
      shownAlpha = Math.max(0, shownAlpha - 0.08)
      if (shownAlpha <= 0) {
        shownCorners = null
        return
      }
    }
    if (!shownCorners) return
    lockMix += ((locked ? 1 : 0) - lockMix) * 0.2
    // Test hook (scripts/screen/e2e-live-scan.mjs --shake): outline per frame.
    const trace = (window as unknown as { __camTrace?: unknown[] }).__camTrace
    trace?.push({ t: now, c: shownCorners.map((p) => [p.x, p.y]), locked, steady })

    const accent = rgba(accentRgb, 1)
    const accent2 = rgba(accent2Rgb, 1)
    const q = shownCorners
    const side = sideOf(q)
    const radius = Math.min(18, side * 0.05)
    const cx = q.reduce((a, p) => a + p.x, 0) / 4
    const cy = q.reduce((a, p) => a + p.y, 0) / 4

    // Dim the world outside the grid as the lock firms up.
    if (lockMix > 0.02) {
      ctx.save()
      ctx.globalAlpha = shownAlpha * lockMix * 0.38
      ctx.beginPath()
      ctx.rect(0, 0, rect.width, rect.height)
      roundedQuad(ctx, q, radius, false)
      ctx.fillStyle = '#000'
      ctx.fill('evenodd')
      ctx.restore()
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const grad = ctx.createLinearGradient(q[0].x, q[0].y, q[2].x, q[2].y)
    grad.addColorStop(0, accent)
    grad.addColorStop(1, accent2)

    // Corner brackets while lining up; they grow into the full outline and
    // turn from white to the accent as the lock firms up. The halo is a wide
    // faint stroke under the line: shadowBlur re-rasterised the whole canvas
    // every frame and was most of the camera's main-thread time.
    const reach = 0.22 + 0.28 * lockMix
    ctx.beginPath()
    for (let i = 0; i < 4; i++) {
      const c = q[i]
      const next = q[(i + 1) % 4]
      const prev = q[(i + 3) % 4]
      ctx.moveTo(c.x + (prev.x - c.x) * reach, c.y + (prev.y - c.y) * reach)
      ctx.arcTo(c.x, c.y, c.x + (next.x - c.x) * reach, c.y + (next.y - c.y) * reach, radius)
      ctx.lineTo(c.x + (next.x - c.x) * reach, c.y + (next.y - c.y) * reach)
    }
    ctx.save()
    ctx.globalAlpha = shownAlpha
    ctx.lineWidth = 10
    ctx.strokeStyle = lockMix > 0.5 ? rgba(accentRgb, 0.3 * lockMix) : 'rgba(0,0,0,0.14)'
    ctx.stroke()
    ctx.lineWidth = 3.5
    ctx.globalAlpha = shownAlpha * (1 - lockMix)
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.stroke()
    ctx.globalAlpha = shownAlpha * lockMix
    ctx.strokeStyle = grad
    ctx.stroke()
    ctx.restore()

    if (locked) {
      // The auto-capture progress tracing the outline.
      if (steady > 0) {
        ctx.save()
        ctx.globalAlpha = shownAlpha * lockMix
        const perimeter = side * 4
        ctx.setLineDash([perimeter * steady, perimeter])
        roundedQuad(ctx, q, radius)
        ctx.lineWidth = 9
        ctx.strokeStyle = 'rgba(255,255,255,0.28)'
        ctx.stroke()
        ctx.lineWidth = 3.5
        ctx.strokeStyle = '#fff'
        ctx.stroke()
        ctx.restore()
      }
      // One soft ring expanding on the lock moment.
      const pt = (now - lockPulseAt) / 600
      if (pt < 1) {
        const grow = 1 + 0.06 * pt
        ctx.save()
        ctx.globalAlpha = (1 - pt) * 0.6 * shownAlpha
        ctx.strokeStyle = accent
        ctx.lineWidth = 2 + 4 * (1 - pt)
        roundedQuad(
          ctx,
          q.map((p) => ({ x: cx + (p.x - cx) * grow, y: cy + (p.y - cy) * grow })),
          radius * grow,
        )
        ctx.stroke()
        ctx.restore()
      }
    }
  }

  function scheduleFramePump(): void {
    const video = videoEl as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
    }
    if (video.requestVideoFrameCallback) {
      const loop = (): void => {
        pumpFrame()
        if (!captured) videoFrameId = video.requestVideoFrameCallback!(loop)
      }
      videoFrameId = video.requestVideoFrameCallback(loop)
    } else {
      const loop = (): void => {
        pumpFrame()
        if (!captured) videoFrameId = window.setTimeout(loop, 66) as unknown as number
      }
      loop()
    }
  }

  function stopAll(): void {
    cancelAnimationFrame(rafId)
    clearInterval(safetyTimer)
    worker?.terminate()
    worker = null
    handle?.stop()
    handle = null
  }

  function pick(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0]
    ;(e.target as HTMLInputElement).value = ''
    if (!file) return
    captured = true
    stopAll()
    onupload(file)
  }

  onMount(() => {
    let disposed = false
    // The first frame of the opening paints before anything heavy starts
    // (the camera, the detection worker).
    const start = async (): Promise<void> => {
      if (disposed) return
      bitmapFrames = await probeBitmapFrames()
      accentRgb = readColour('--accent', accentRgb)
      accent2Rgb = readColour('--accent-2', accent2Rgb)
      const result = await openCamera(videoEl, () => {
        // Stream lost (backgrounding etc.) - close rather than show a frozen feed.
        if (!captured) onclose()
      })
      starting = false
      if (disposed) {
        if (typeof result !== 'string') result.stop()
        return
      }
      if (typeof result === 'string') {
        error = result
        return
      }
      handle = result
      hasTorch = result.hasTorch
      if (result.zoom && result.zoom.max > 1) hwZoom = result.zoom
      worker = new Worker(new URL('../lib/cv/detect.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<DetectResponse>) => onDetection(e.data)
      worker.onerror = () => {
        workerBusy = false
        workerFailures++
        if (workerFailures >= 3 && !workerSucceeded) detectionDead = true
      }
      scheduleFramePump()
      // Safety net: requestVideoFrameCallback can stall after backgrounding.
      safetyTimer = setInterval(() => {
        if (!captured && performance.now() - lastPumpAt > 700) pumpFrame()
      }, 500)
      rafId = requestAnimationFrame(drawOverlay)
    }
    const startId = requestAnimationFrame(() => setTimeout(() => void start(), 0))
    return () => {
      cancelAnimationFrame(startId)
      disposed = true
      clearTimeout(messageTimer)
      stopAll()
    }
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (the pinch-to-zoom surface; every control inside is a button) -->
<div
  class="camera"
  class:flash={flashing}
  class:captured={frozen}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
  <!-- svelte-ignore a11y_media_has_caption (live camera preview) -->
  <video bind:this={videoEl} playsinline muted autoplay class:hidden={error !== null} style:scale={digitalZoom}></video>
  <canvas bind:this={freezeEl} class="freeze" class:on={frozen} aria-hidden="true"></canvas>
  <canvas bind:this={overlayEl} class="overlay"></canvas>

  {#if error}
    <div class="no-camera">
      <div class="art" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="10" y="10" width="44" height="44" rx="7" />
          <path d="M24.7 10v44M39.3 10v44M10 24.7h44M10 39.3h44" opacity="0.4" />
        </svg>
      </div>
      <p class="lead">
        {#if error === 'denied'}
          Camera access is off. Choose a photo instead.
        {:else if error === 'insecure'}
          The live camera needs https. Choose a photo instead.
        {:else}
          No camera here. Choose a photo of a sudoku.
        {/if}
      </p>
      <div class="no-camera-actions">
        <button class="btn btn-primary" onclick={() => fileInput.click()}>Choose a photo</button>
        <button class="btn btn-ghost light" onclick={onsample}>Try a sample</button>
      </div>
      <p class="fine">Or drop an image anywhere. Photos never leave your device.</p>
    </div>
  {:else}
    <p class="guide {guide.tone}" role="status" aria-live="polite">{guide.text}</p>
  {/if}

  <div class="top">
    <button class="round" aria-label="Close" onclick={onclose}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
    </button>
    {#if hasTorch}
      <button
        class="round"
        class:on={torchOn}
        aria-label="Toggle torch"
        aria-pressed={torchOn}
        onclick={() => {
          torchOn = !torchOn
          void handle?.setTorch(torchOn)
        }}
      >
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13 2 4.5 13.5a.5.5 0 0 0 .4.8H11l-1 7 8.5-11.5a.5.5 0 0 0-.4-.8H12z" />
        </svg>
      </button>
    {/if}
  </div>

  {#if !error && !starting}
    <button class="zoom" class:on={zoom > 1.05} aria-label="Zoom" onclick={() => setZoom(zoom < 1.9 ? 2 : 1)}>
      {zoomLabel}
    </button>
  {/if}

  {#if !error}
    <div class="bottom">
      <button class="round" aria-label="Choose a photo" onclick={() => fileInput.click()}>
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <circle cx="9" cy="9" r="1.8" />
          <path d="m21 15-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5 19.6" />
        </svg>
      </button>
      <button class="shutter" class:ready={locked && !edge} aria-label="Scan now" onclick={capture}>
        <svg viewBox="0 0 80 80" aria-hidden="true">
          <circle class="ring-bg" cx="40" cy="40" r="36" />
          <circle class="ring" cx="40" cy="40" r="36" style:stroke-dashoffset={226.2 * (1 - steady)} />
        </svg>
        <span class="core"></span>
      </button>
      <button class="round text" onclick={onsample} aria-label="Try a sample photo">Sample</button>
    </div>
  {/if}

  <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={pick} />
</div>

<style>
  .camera {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #05070b;
    color: #fff;
    /* Pinch zooms the camera, never the page. */
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    animation: video-in 0.5s var(--ease-out) backwards;
    transition: scale 0.14s var(--ease-out);
  }

  video.hidden {
    display: none;
  }

  @keyframes video-in {
    from {
      opacity: 0;
      transform: scale(1.03);
    }
  }

  /* At the shutter the controls step aside for the reading view. */
  .captured .bottom,
  .captured .zoom,
  .captured .guide {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s var(--ease-out);
  }

  /* The frame at the shutter, held while the burst reads the next ones. */
  .freeze {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    visibility: hidden;
  }

  .freeze.on {
    visibility: visible;
  }

  /* The controls settle in once the opening is under way. */
  .top,
  .bottom,
  .zoom,
  .guide {
    animation: controls-in 0.5s var(--ease-out) 0.16s backwards;
  }

  @keyframes controls-in {
    from {
      opacity: 0;
      translate: 0 8px;
    }
  }

  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* Shutter flash: a quick white veil when the frame is taken. */
  .camera::after {
    content: '';
    position: absolute;
    inset: 0;
    background: #fff;
    opacity: 0;
    pointer-events: none;
  }

  .camera.flash::after {
    animation: flash 0.32s ease-out;
  }

  @keyframes flash {
    0% {
      opacity: 0.55;
    }
    100% {
      opacity: 0;
    }
  }

  /* Centred between the close and torch buttons; longer messages wrap. */
  .guide {
    position: absolute;
    top: calc(20px + env(safe-area-inset-top));
    left: 0;
    right: 0;
    width: fit-content;
    max-width: calc(100% - 140px);
    margin: 0 auto;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 0.9rem;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.01em;
    text-align: center;
    text-wrap: balance;
    color: #fff;
    background: rgba(12, 16, 24, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(14px) saturate(1.4);
    -webkit-backdrop-filter: blur(14px) saturate(1.4);
    transition:
      background-color 0.25s,
      border-color 0.25s;
  }

  .guide.ok {
    background: color-mix(in srgb, var(--accent) 38%, rgba(12, 16, 24, 0.55));
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  }

  .guide.warn {
    background: color-mix(in srgb, #f59e0b 34%, rgba(12, 16, 24, 0.6));
    border-color: color-mix(in srgb, #f59e0b 55%, transparent);
  }

  .top {
    position: absolute;
    top: calc(14px + env(safe-area-inset-top));
    left: 14px;
    right: 14px;
    display: flex;
    justify-content: space-between;
    pointer-events: none;
  }

  .top > * {
    pointer-events: auto;
  }

  .round {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 50%;
    color: #fff;
    background: rgba(12, 16, 24, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.16);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    transition:
      transform 0.15s var(--ease-out),
      background-color 0.2s;
  }

  .round:active {
    transform: scale(0.92);
  }

  .round.on {
    color: #111;
    background: #fde68a;
  }

  .round.text {
    width: auto;
    padding: 0 14px;
    border-radius: 999px;
    font-size: 0.82rem;
    font-weight: 600;
  }

  .zoom {
    position: absolute;
    left: 50%;
    bottom: calc(122px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    min-width: 44px;
    height: 32px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: #fff;
    background: rgba(12, 16, 24, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.16);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    transition: color 0.2s;
  }

  .zoom.on {
    color: #fde68a;
  }

  .bottom {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(26px + env(safe-area-inset-bottom));
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    justify-items: center;
    padding: 0 22px;
  }

  .bottom > :first-child {
    justify-self: start;
  }

  .bottom > :last-child {
    justify-self: end;
  }

  .shutter {
    position: relative;
    width: 78px;
    height: 78px;
    padding: 0;
    border-radius: 50%;
    background: none;
    transition: transform 0.15s var(--ease-out);
  }

  .shutter:active {
    transform: scale(0.93);
  }

  .shutter svg {
    position: absolute;
    inset: 0;
    transform: rotate(-90deg);
  }

  .ring-bg {
    fill: none;
    stroke: rgba(255, 255, 255, 0.85);
    stroke-width: 4;
  }

  .ring {
    fill: none;
    stroke: var(--accent);
    stroke-width: 4.5;
    stroke-linecap: round;
    stroke-dasharray: 226.2;
    transition: stroke-dashoffset 0.08s linear;
  }

  .core {
    position: absolute;
    inset: 9px;
    border-radius: 50%;
    background: #fff;
    transition:
      transform 0.25s var(--ease-out),
      background-color 0.25s;
  }

  .shutter.ready .core {
    transform: scale(0.9);
    background: color-mix(in srgb, var(--accent) 22%, #fff);
  }

  .no-camera {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 32px 24px;
    text-align: center;
  }

  .no-camera .art {
    color: var(--accent);
    opacity: 0.9;
  }

  .no-camera .lead {
    margin: 0;
    max-width: 22em;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .no-camera-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .btn-ghost.light {
    color: #fff;
    border-color: rgba(255, 255, 255, 0.3);
  }

  .fine {
    margin: 0;
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
  }

  @media (prefers-reduced-motion: reduce) {
    video {
      animation: none;
    }
    .camera.flash::after {
      animation: none;
    }
  }
</style>
