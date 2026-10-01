<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Point } from '../lib/cv/image'
  import { board } from '../lib/stores/board.svelte'
  import { scan, type ScanFrame } from '../lib/stores/scan.svelte'
  import { toast } from '../lib/stores/toast.svelte'
  import { fitMapping, lerpQuad, matrix3dFor, spring } from '../lib/ui/morph'
  import { SMOOTH } from '../lib/ui/motion'
  import { decodePhoto, samplePhoto } from '../lib/ui/photo'
  import CameraView from './CameraView.svelte'

  /** Size of the straightened photo element that flies onto the board. */
  const MORPH_DIM = 480
  /** The flight: a critically damped spring (as --spring-smooth). */
  const FLIGHT = spring(0.42, 1)
  /** Keyframes sampled along the flight; the compositor interpolates between. */
  const FLIGHT_FRAMES = 36
  const FADE_MS = 320

  let stageEl = $state<HTMLDivElement>()
  let frozenEl = $state<HTMLCanvasElement>()
  let morphHost = $state<HTMLDivElement>()
  let stageW = $state(0)
  let stageH = $state(0)
  let leaving = $state(false)
  /** Opening out of the button that was tapped (phones). */
  let hero = $state(false)
  let tintEl = $state<HTMLDivElement>()
  /** Corner radius of the scan buttons the opening grows out of. */
  const BUTTON_RADIUS = 20

  const open = $derived(scan.status !== 'idle')
  const showFrozen = $derived(scan.status === 'processing' || scan.status === 'landing' || scan.status === 'pick-size')
  const stageLabel = $derived(
    scan.stage === 'read' ? 'Reading the digits' : scan.stage === 'check' ? 'Checking' : 'Finding the grid',
  )

  /** Where the frame sits inside the stage. */
  const mapping = $derived(
    scan.frame && stageW > 0 ? fitMapping(scan.frame.width, scan.frame.height, stageW, stageH, scan.frame.fit, scan.frame.view) : null,
  )
  const stageQuad = $derived.by((): Point[] | null => {
    const m = mapping
    const q = scan.quad
    if (!m || !q) return null
    return q.map((p) => ({ x: m.ox + p.x * m.scale, y: m.oy + p.y * m.scale }))
  })
  const quadPath = $derived(stageQuad ? `M${stageQuad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z` : '')
  /** The reading shimmer lives on a square laid onto the grid in
   * perspective, so the light moves across the paper itself. */
  const SURFACE = 400
  const surface = $derived(stageQuad ? matrix3dFor(SURFACE, SURFACE, stageQuad) : null)
  /** A camera capture arrives with the live view's dimming already on. */
  const fromCamera = $derived(scan.frame?.fit === 'cover')

  // Paint the frozen still at the stage's resolution.
  $effect(() => {
    const f = scan.frame
    const canvas = frozenEl
    const m = mapping
    if (!f || !canvas || !m || !showFrozen) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(stageW * dpr)
    canvas.height = Math.round(stageH * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(f.canvas, m.ox, m.oy, f.width * m.scale, f.height * m.scale)
  })

  $effect(() => {
    if (scan.status === 'landing') void land()
  })

  $effect(() => {
    if (!open) return
    // Pinching inside the scanner zooms the camera, not the page: a zoomed
    // page pushes the overlay's buttons off screen. Fixing the scale also
    // undoes any zoom the page already had.
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const before = meta?.content
    meta?.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0')
    const block = (e: Event): void => e.preventDefault()
    const blockPinch = (e: TouchEvent): void => {
      if (e.touches.length > 1) e.preventDefault()
    }
    document.addEventListener('gesturestart', block)
    document.addEventListener('gesturechange', block)
    document.addEventListener('touchmove', blockPinch, { passive: false })
    return () => {
      if (meta && before !== undefined) meta.setAttribute('content', before)
      document.removeEventListener('gesturestart', block)
      document.removeEventListener('gesturechange', block)
      document.removeEventListener('touchmove', blockPinch)
    }
  })

  // The scanner grows out of the button that opened it: the stage's clip
  // opens from the button's box to the whole screen on a spring while the
  // button's colour fades into the dark of the camera. The camera starts up
  // underneath, so its start-up time is spent inside the motion.
  $effect(() => {
    const stage = stageEl
    const tint = tintEl
    if (!stage || !tint) return
    untrack(() => {
      const o = scan.origin
      const s = stage.getBoundingClientRect()
      const inside = o && o.left >= s.left && o.right <= s.right && o.top >= s.top && o.bottom <= s.bottom
      if (!o || !inside || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        hero = false
        return
      }
      hero = true
      const from = `inset(${o.top - s.top}px ${s.right - o.right}px ${s.bottom - o.bottom}px ${o.left - s.left}px round ${BUTTON_RADIUS}px)`
      const to = `inset(0px 0px 0px 0px round ${getComputedStyle(stage).borderTopLeftRadius})`
      const ease = getComputedStyle(document.documentElement).getPropertyValue('--spring-smooth').trim() || 'ease-out'
      stage.animate([{ clipPath: from }, { clipPath: to }], { duration: SMOOTH.ms, easing: ease })
      tint.animate([{ opacity: 1 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 420, easing: 'ease-out', fill: 'forwards' })
    })
  })

  $effect(() => {
    // Leaving the overlay resets the fade state for next time.
    if (!open) leaving = false
  })

  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

  /**
   * The straightened photo flies from where the grid sits in the frozen
   * frame onto the board. The corners follow a spring; the path is baked
   * into keyframes the compositor plays, so the board's own update (every
   * cell re-rendering, started once the flight is under way) cannot make it
   * stutter. Then the digits ripple in over the photo as it fades.
   */
  async function land(): Promise<void> {
    const r = scan.result
    const straight = scan.straight
    const outline = scan.quad
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    await tick()
    const gridEl = document.querySelector<HTMLElement>('.grid')
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!r || !straight || !outline || !gridEl || !stageEl || !mapping || !morphHost || reduced) {
      scan.toBoard()
      board.revealScan()
      scan.landed()
      return
    }
    const g = gridEl.getBoundingClientRect()
    const s = stageEl.getBoundingClientRect()
    const m = mapping
    const from = outline.map((p) => ({ x: s.left + m.ox + p.x * m.scale, y: s.top + m.oy + p.y * m.scale }))
    const inset = 2
    const to = [
      { x: g.left + inset, y: g.top + inset },
      { x: g.right - inset, y: g.top + inset },
      { x: g.right - inset, y: g.bottom - inset },
      { x: g.left + inset, y: g.bottom - inset },
    ]
    const el = straight
    el.className = 'morph'
    el.style.width = `${MORPH_DIM}px`
    el.style.height = `${MORPH_DIM}px`
    el.style.transform = matrix3dFor(MORPH_DIM, MORPH_DIM, from)
    morphHost.appendChild(el)
    const keyframes = Array.from({ length: FLIGHT_FRAMES + 1 }, (_, i) => ({
      transform: matrix3dFor(MORPH_DIM, MORPH_DIM, lerpQuad(from, to, FLIGHT.ease(i / FLIGHT_FRAMES))),
    }))
    const flight = el.animate(keyframes, { duration: FLIGHT.ms, easing: 'linear', fill: 'forwards' })
    leaving = true
    // Let the flight reach the compositor, then do the heavy board update.
    await nextFrame()
    await nextFrame()
    scan.toBoard()
    await flight.finished.catch(() => undefined)
    board.revealScan()
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' })
    await fade.finished.catch(() => undefined)
    el.remove()
    scan.landed()
  }

  async function readFile(file: Blob): Promise<void> {
    try {
      const { frame, source } = await decodePhoto(file)
      await scan.read(frame, null, source)
    } catch {
      toast.show("That file couldn't be opened as a photo.", 'warn')
      scan.open()
    }
  }

  async function readSample(): Promise<void> {
    try {
      await readFile(await samplePhoto())
    } catch {
      toast.show("The sample photo couldn't be loaded.", 'warn')
    }
  }

  function onCapture(frame: ScanFrame, hint: Point[] | null): void {
    void scan.read(frame, hint)
  }
</script>

{#if open}
  <div class="scan-overlay" class:leaving role="dialog" aria-modal="true" aria-label="Scan a sudoku">
    <div class="stage" class:hero bind:this={stageEl} bind:clientWidth={stageW} bind:clientHeight={stageH}>
      <div class="tint" bind:this={tintEl} aria-hidden="true"></div>
      {#if scan.status === 'camera'}
        <CameraView
          oncapture={onCapture}
          onupload={(f) => void readFile(f)}
          onsample={() => void readSample()}
          onclose={() => scan.close()}
          message={scan.message}
        />
      {:else}
        <canvas class="frozen" bind:this={frozenEl}></canvas>
        <svg class="marks" class:instant={fromCamera} width={stageW} height={stageH} aria-hidden="true">
          {#if quadPath}
            <path class="dim" d="M0,0H{stageW}V{stageH}H0Z {quadPath}" fill-rule="evenodd" />
            <path class="halo" d={quadPath} />
            <path class="edge" d={quadPath} />
          {/if}
        </svg>
        {#if scan.status === 'processing' && surface}
          <div class="shimmer" style:width="{SURFACE}px" style:height="{SURFACE}px" style:transform={surface} aria-hidden="true">
            <span class="band"></span>
          </div>
        {/if}

        {#if scan.status === 'processing'}
          <p class="pill" role="status" aria-live="polite">
            <span class="dot" aria-hidden="true"></span>
            {#key stageLabel}<span class="pill-text">{stageLabel}</span>{/key}
          </p>
        {/if}

        {#if scan.status === 'pick-size'}
          <div class="sheet" role="group" aria-label="Choose the grid size">
            <p class="sheet-title">Found a grid. Which size is it?</p>
            <div class="sizes">
              {#each [4, 9, 16] as const as n (n)}
                <button class="size" onclick={() => void scan.chooseSize(n)}>{n}×{n}</button>
              {/each}
            </div>
            <button class="retake" onclick={() => scan.open()}>Retake</button>
          </div>
        {/if}

        {#if scan.status !== 'landing'}
          <button class="close" aria-label="Close" onclick={() => scan.close()}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        {/if}
      {/if}
    </div>
    <div class="morph-host" bind:this={morphHost}></div>
  </div>
{/if}

<style>
  .scan-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    touch-action: none;
    display: grid;
    place-items: center;
  }

  /* The dimmed, blurred page behind the scanner. It fades by opacity: a
     transition of the blur radius re-renders the blur every frame. */
  .scan-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(5, 7, 11, 0.72);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    animation: overlay-in 0.28s var(--ease-out) backwards;
    transition: opacity 0.42s var(--ease-out);
  }

  .scan-overlay.leaving {
    pointer-events: none;
  }

  .scan-overlay.leaving::before {
    opacity: 0;
  }

  @keyframes overlay-in {
    from {
      opacity: 0;
    }
  }

  /* A tall card on larger screens; the whole screen on phones. */
  .stage {
    position: relative;
    height: min(88svh, 860px);
    aspect-ratio: 3 / 4;
    max-width: 94vw;
    border-radius: 28px;
    overflow: hidden;
    background: #05070b;
    box-shadow: 0 40px 120px -40px rgba(0, 0, 0, 0.8);
    animation: stage-in 0.42s var(--ease-out) backwards;
    transition:
      opacity 0.38s var(--ease-out),
      transform 0.42s var(--ease-out);
  }

  .leaving .stage {
    opacity: 0;
    transform: scale(1.02);
  }

  /* Growing out of a button: the clip does the entrance. */
  .stage.hero {
    animation: none;
  }

  /* The tapped button's colour, fading into the camera's dark. */
  .tint {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    opacity: 0;
    pointer-events: none;
  }

  @keyframes stage-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
  }

  @media (max-width: 640px), (pointer: coarse) and (max-width: 900px) {
    .stage {
      width: 100vw;
      height: 100svh;
      max-width: none;
      aspect-ratio: auto;
      border-radius: 0;
      box-shadow: none;
    }
  }

  .frozen {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .marks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .marks {
    animation: fade-in 0.3s var(--ease-out) backwards;
  }

  .marks.instant {
    animation: none;
  }

  /* Matches the live view's dimming at the lock, so the hand-over is seamless. */
  .dim {
    fill: rgba(0, 0, 0, 0.4);
  }

  .halo,
  .edge {
    fill: none;
    stroke-linejoin: round;
  }

  .halo {
    stroke: var(--accent);
    stroke-opacity: 0.35;
    stroke-width: 9;
  }

  .edge {
    stroke: var(--accent);
    stroke-width: 2.5;
  }

  /* Reading: a soft band of tinted light passing over the grid's surface
     (in its perspective), again and again. Accent-tinted so it shows on
     white paper as well as on a dark screen. */
  .shimmer {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
    overflow: hidden;
    pointer-events: none;
    animation: fade-in 0.4s var(--ease-out) backwards;
  }

  .band {
    position: absolute;
    inset: -10% 0;
    background: linear-gradient(
      112deg,
      transparent 28%,
      color-mix(in srgb, var(--accent) 16%, transparent) 40%,
      color-mix(in srgb, var(--accent-2) 30%, rgba(255, 255, 255, 0.35)) 50%,
      color-mix(in srgb, var(--accent) 16%, transparent) 60%,
      transparent 72%
    );
    transform: translateX(-100%);
    animation: shimmer 1.6s var(--ease-in-out) 0.1s infinite;
  }

  @keyframes shimmer {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(100%);
    }
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  .pill {
    position: absolute;
    left: 50%;
    bottom: calc(34px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    padding: 10px 18px;
    border-radius: 999px;
    color: #fff;
    font-size: 0.92rem;
    font-weight: 600;
    white-space: nowrap;
    background: rgba(12, 16, 24, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }

  .pill-text {
    animation: text-in 0.3s var(--ease-out) backwards;
  }

  @keyframes text-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
    animation: breathe 1.1s ease-in-out infinite;
  }

  @keyframes breathe {
    50% {
      transform: scale(0.6);
      opacity: 0.6;
    }
  }

  .sheet {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: calc(22px + env(safe-area-inset-bottom));
    padding: 18px;
    border-radius: 22px;
    color: #fff;
    text-align: center;
    background: rgba(14, 18, 27, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    animation: sheet-in 0.36s var(--ease-out) backwards;
  }

  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
  }

  .sheet-title {
    margin: 0 0 12px;
    font-weight: 600;
  }

  .sizes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .size {
    padding: 12px 0;
    border-radius: 14px;
    font-weight: 700;
    font-size: 1.05rem;
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
    transition: background-color 0.15s;
  }

  .size:hover {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }

  .retake {
    margin-top: 10px;
    padding: 6px 12px;
    font-size: 0.86rem;
    color: rgba(255, 255, 255, 0.75);
    background: none;
  }

  .close {
    position: absolute;
    top: calc(14px + env(safe-area-inset-top));
    left: 14px;
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
  }

  .morph-host {
    position: fixed;
    inset: 0;
    pointer-events: none;
  }

  .morph-host :global(.morph) {
    position: fixed;
    left: 0;
    top: 0;
    transform-origin: 0 0;
    border-radius: 16px;
    box-shadow: 0 30px 80px -30px rgba(0, 0, 0, 0.6);
    will-change: transform;
  }

  @media (prefers-reduced-motion: reduce) {
    .band,
    .dot {
      animation: none;
    }
  }
</style>
