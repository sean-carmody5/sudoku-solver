<script lang="ts">
  import { onMount } from 'svelte'
  import AdSlot from './components/AdSlot.svelte'
  import Grid from './components/Grid.svelte'
  import ScanBanner from './components/ScanBanner.svelte'
  import ScanOverlay from './components/ScanOverlay.svelte'
  import SizeTabs from './components/SizeTabs.svelte'
  import SolveControls from './components/SolveControls.svelte'
  import ThemeToggle from './components/ThemeToggle.svelte'
  import Toast from './components/Toast.svelte'
  import { board } from './lib/stores/board.svelte'
  import { scan } from './lib/stores/scan.svelte'
  import { toast } from './lib/stores/toast.svelte'
  import { readPuzzleFromHash } from './lib/share'
  import { decodePhoto } from './lib/ui/photo'
  import { grow } from './lib/ui/motion'

  let helpOpen = $state(false)
  let dropping = $state(false)
  /** Deferred PWA install prompt (Chromium), shown as a header button. */
  let installPrompt = $state<(Event & { prompt: () => Promise<unknown> }) | null>(null)

  function onInstallable(e: Event): void {
    e.preventDefault()
    installPrompt = e as Event & { prompt: () => Promise<unknown> }
  }

  async function install(): Promise<void> {
    const p = installPrompt
    if (!p) return
    installPrompt = null
    await p.prompt()
  }

  // The page behind the scan overlay must not scroll (iOS rubber-banding).
  $effect(() => {
    document.documentElement.style.overflow = scan.status === 'idle' ? '' : 'hidden'
  })

  /** A photo dropped anywhere on the page is scanned. */
  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault()
    dropping = false
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    try {
      const { frame, source } = await decodePhoto(file)
      await scan.read(frame, null, source)
    } catch {
      toast.show("That file couldn't be opened as a photo.", 'warn')
    }
  }

  function loadFromHash(): void {
    const shared = readPuzzleFromHash(location.hash)
    if (!shared) return
    scan.close()
    // The board's own notice says where it came from; no toast as well.
    board.loadPuzzle(shared.size, shared.values, shared.convention, 'a shared puzzle')
    history.replaceState(null, '', location.pathname + location.search)
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
    if (e.key === 'Escape') {
      if (helpOpen) helpOpen = false
      else if (scan.status !== 'idle' && scan.status !== 'landing') scan.close()
      return
    }
    if (scan.status !== 'idle') return
    if (typing) return
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      helpOpen = !helpOpen
      e.preventDefault()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      board.undo()
      e.preventDefault()
    } else if (e.key === 'Enter' && board.canSolve) {
      void board.solve()
      e.preventDefault()
    }
  }

  onMount(() => {
    // A share link wins; otherwise pick up where the last visit left off.
    if (!readPuzzleFromHash(location.hash) && board.restore()) {
      toast.show('Restored your last puzzle')
    }
    loadFromHash()
    const installed = (): void => {
      installPrompt = null
    }
    window.addEventListener('hashchange', loadFromHash)
    window.addEventListener('appinstalled', installed)
    return () => {
      window.removeEventListener('hashchange', loadFromHash)
      window.removeEventListener('appinstalled', installed)
    }
  })
</script>

<svelte:window
  onkeydown={onWindowKeydown}
  onbeforeinstallprompt={onInstallable}
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      dropping = true
    }
  }}
  ondragleave={(e) => {
    if (e.relatedTarget === null) dropping = false
  }}
  ondrop={(e) => void onDrop(e)}
/>

<div class="page">
  <header>
    <div class="brand">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="30" height="30">
          <defs>
            <linearGradient id="cellFill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="var(--accent)" />
              <stop offset="1" stop-color="var(--accent-2)" />
            </linearGradient>
          </defs>
          <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.3" fill="url(#cellFill)" opacity="0.85" />
          <rect class="solved" x="12.6" y="12.6" width="6.8" height="6.8" rx="1.3" fill="url(#cellFill)" />
          <rect x="20.6" y="20.6" width="6.8" height="6.8" rx="1.3" fill="url(#cellFill)" opacity="0.85" />
          <g fill="none" stroke="currentColor" stroke-linecap="round">
            <rect x="4" y="4" width="24" height="24" rx="5" stroke-width="1.9" />
            <path d="M12 4.5v23M20 4.5v23M4.5 12h23M4.5 20h23" stroke-width="1.1" opacity="0.4" />
          </g>
        </svg>
      </div>
      <h1 class="wordmark">Sudoku<span>Solver</span></h1>
    </div>
    <div class="header-actions">
      {#if installPrompt}
        <button class="btn btn-ghost install" onclick={install}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          Install
        </button>
      {/if}
      <button class="icon-btn" aria-label="Help" aria-expanded={helpOpen} onclick={() => (helpOpen = !helpOpen)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
        </svg>
      </button>
      <ThemeToggle />
    </div>
  </header>

  {#if helpOpen}
    <div class="help" role="dialog" aria-label="How it works" transition:grow>
      <div class="help-cols">
        <section>
          <h2>Scan</h2>
          <p>
            Tap Scan and point your camera at a sudoku, printed or on a screen. It takes the picture by itself once
            the outline locks. Pinch to zoom in on one puzzle when there are several.
          </p>
        </section>
        <section>
          <h2>Type</h2>
          <p>Tap a cell, then a number. Solve fills in the rest, then drag the slider to step through how.</p>
        </section>
      </div>
      <div class="help-keys">
        <span><kbd>1</kbd>–<kbd>9</kbd> <em>or</em> <kbd>A</kbd>–<kbd>F</kbd></span><span>enter a value</span>
        <span><kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd></span><span>move</span>
        <span><kbd>⌫</kbd></span><span>clear the cell</span>
        <span><kbd>↵</kbd></span><span>solve</span>
        <span><kbd>Ctrl</kbd>+<kbd>Z</kbd></span><span>undo</span>
        <span><kbd>Esc</kbd></span><span>deselect / close</span>
      </div>
      <p class="help-note">Everything happens on your device. Photos are never uploaded.</p>
    </div>
  {/if}

  <main>
    <section class="panel">
      <div class="panel-top">
        <SizeTabs />
      </div>

      <Grid />

      <ScanBanner />

      <SolveControls />

      <!-- The scanner is the main act: under the thumb on phones (sticking to
           the bottom edge if the page grows), at the foot of the side column
           on larger screens. -->
      <button class="scan-cta" onclick={(e) => scan.open(e.currentTarget)}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
          <path d="M7 12h10" />
        </svg>
        Scan a sudoku
      </button>
    </section>

    <AdSlot slot="footer" />
  </main>

  <footer>
    <p>Solves entirely in your browser - nothing is uploaded, ever.</p>
    <p class="build">build {__BUILD_ID__}</p>
  </footer>
</div>

<ScanOverlay />

{#if dropping}
  <div class="drop-hint" aria-hidden="true"><span>Drop to scan</span></div>
{/if}

<Toast />

<style>
  .page {
    min-height: 100svh;
    display: flex;
    flex-direction: column;
    max-width: 720px;
    margin: 0 auto;
    padding: 0 16px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .mark {
    display: grid;
    place-items: center;
    color: var(--text);
  }

  /* A still glow: an endlessly animated filter restyled and repainted the
     logo on every frame, even with nothing else happening. */
  .mark .solved {
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--accent) 55%, transparent));
  }

  .wordmark {
    margin: 0;
    font-size: 1.32rem;
    font-weight: 750;
    letter-spacing: -0.035em;
    color: var(--text);
  }

  .wordmark span {
    color: var(--accent);
    margin-left: 0.28em;
    font-weight: 650;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .install {
    padding: 7px 12px;
    font-size: 0.86rem;
    animation: rise var(--dur) var(--ease-out) backwards;
  }

  .icon-btn {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    color: var(--text-muted);
    border: 1px solid var(--line);
    background: var(--surface);
    transition:
      color var(--dur-fast),
      background-color var(--dur-fast);
  }

  .icon-btn:hover,
  .icon-btn[aria-expanded='true'] {
    color: var(--text);
    background: var(--surface-2);
  }

  .help {
    margin: -4px 0 16px;
    padding: 16px 18px;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    font-size: 0.9rem;
    line-height: 1.45;
    color: var(--text-muted);
  }

  .help-cols {
    display: grid;
    gap: 12px;
  }

  @media (min-width: 640px) {
    .help-cols {
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
  }

  .help h2 {
    margin: 0 0 4px;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
  }

  .help p {
    margin: 0;
  }

  .help-keys {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    align-items: center;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
    font-size: 0.84rem;
  }

  /* Shortcuts only where there is a keyboard. */
  @media (hover: none) {
    .help-keys {
      display: none;
    }
  }

  .help-keys em {
    font-style: normal;
    opacity: 0.7;
    margin: 0 2px;
  }

  .help-note {
    margin-top: 12px !important;
    font-size: 0.8rem;
    color: var(--text-faint);
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-bottom: 12px;
  }

  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: rise 0.5s var(--ease-spring) backwards;
  }

  .panel-top {
    display: flex;
    justify-content: center;
  }

  .scan-cta {
    position: sticky;
    bottom: calc(14px + env(safe-area-inset-bottom));
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: 100%;
    min-height: 62px;
    margin-top: auto;
    padding: 0 28px;
    border-radius: 20px;
    white-space: nowrap;
    font-size: 1.16rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: #fff;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow:
      0 16px 36px -14px var(--accent-glow),
      0 2px 0 inset rgba(255, 255, 255, 0.18);
    transition: transform 0.15s var(--ease-out);
  }

  .scan-cta:active {
    transform: scale(0.97);
  }

  /* Larger screens: the grid on the left, everything else in a column on
     the right. */
  @media (min-width: 900px) {
    .page {
      max-width: 1040px;
      padding: 0 32px;
    }

    .panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      column-gap: 44px;
      row-gap: 16px;
      align-content: start;
      align-items: start;
      padding-top: 12px;
    }

    .panel > :global(*) {
      grid-column: 2;
    }

    .panel > :global(.grid-wrap) {
      grid-column: 1;
      grid-row: 1 / span 12;
      width: min(100%, 76vh, 600px);
      justify-self: end;
    }

    .panel-top {
      justify-content: stretch;
    }

    .scan-cta {
      position: static;
      margin-top: 6px;
    }
  }

  .drop-hint {
    position: fixed;
    inset: 12px;
    z-index: 70;
    display: grid;
    place-items: center;
    border-radius: 24px;
    border: 2px dashed color-mix(in srgb, var(--accent) 70%, transparent);
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(6px);
    pointer-events: none;
    animation: rise var(--dur) var(--ease-out) backwards;
  }

  .drop-hint span {
    padding: 10px 18px;
    border-radius: 999px;
    font-weight: 700;
    color: var(--accent-ink);
    background: var(--accent-soft);
  }

  footer {
    padding: 14px 0 calc(16px + env(safe-area-inset-bottom));
    text-align: center;
  }

  footer p {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  footer .build {
    margin-top: 3px;
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    opacity: 0.55;
  }
</style>
