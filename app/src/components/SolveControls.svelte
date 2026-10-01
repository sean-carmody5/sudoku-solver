<script lang="ts">
  import { board } from '../lib/stores/board.svelte'
  import { toast } from '../lib/stores/toast.svelte'
  import { puzzleUrl } from '../lib/share'
  import { grow } from '../lib/ui/motion'
  import NumberPad from './NumberPad.svelte'

  const solving = $derived(board.status === 'solving')
  const animating = $derived(board.status === 'animating')
  const editing = $derived(board.status === 'editing' || solving || animating)
  const filled = $derived(board.placements.length)
  const timeLabel = $derived(
    board.solveMs < 1 ? '<1 ms' : board.solveMs < 1000 ? `${Math.round(board.solveMs)} ms` : `${(board.solveMs / 1000).toFixed(1)} s`,
  )

  async function share(): Promise<void> {
    const url = puzzleUrl(board.size, board.puzzle, board.convention)
    try {
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        await navigator.share({ title: 'Sudoku', url })
        return
      }
      await navigator.clipboard.writeText(url)
      toast.show('Link copied - anyone who opens it gets this puzzle', 'ok')
    } catch {
      toast.show('Could not copy the link', 'warn')
    }
  }
</script>

<!-- Entering a puzzle: the pad, the tools and Solve. While the solve plays
     the same block stays (disabled) so nothing shifts; the results card
     then takes its place. -->
{#if editing}
  <div class="editor" transition:grow>
    <NumberPad />
    <div class="toolbar">
      <div class="tools">
        <button class="tool" disabled={!board.canUndo} onclick={() => board.undo()} aria-label="Undo">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
          <span>Undo</span>
        </button>
        <button
          class="tool"
          disabled={board.status !== 'editing' || board.selected === -1 || board.puzzle[board.selected] === 0}
          onclick={() => board.clearSelected()}
          aria-label="Erase"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" /><path d="m17 9-6 6M11 9l6 6" />
          </svg>
          <span>Erase</span>
        </button>
        <button class="tool" disabled={board.status !== 'editing' || board.givenCount === 0} onclick={() => board.reset()} aria-label="Clear">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
          <span>Clear</span>
        </button>
        <button class="tool" disabled={board.status !== 'editing'} onclick={() => board.loadExample()} aria-label="Example">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          </svg>
          <span>Example</span>
        </button>
      </div>
      {#if animating}
        <button class="btn btn-ghost solve" onclick={() => board.finishAnimation()}>Skip</button>
      {:else}
        <button class="btn btn-primary solve" disabled={!board.canSolve || solving} onclick={() => board.solve()}>
          {#if solving}
            <span class="spinner" aria-hidden="true"></span>
            Solving
          {:else}
            Solve
            <kbd class="key-hint" aria-hidden="true">↵</kbd>
          {/if}
        </button>
      {/if}
    </div>
  </div>
{:else}
  <div class="result" transition:grow>
    {#if board.status === 'solved'}
      <div class="stats" role="status">
        <span class="stat"><b>{timeLabel}</b></span>
        <span class="dot"></span>
        <span class="stat"><b>{filled}</b> cells</span>
        <span class="dot"></span>
        {#if board.guessCount > 0}
          <span class="stat"><b>{board.guessCount}</b> {board.guessCount === 1 ? 'guess' : 'guesses'}</span>
        {:else}
          <span class="stat">pure logic</span>
        {/if}
        {#if !board.multipleSolutions}
          <span class="dot"></span>
          <span class="stat">unique</span>
        {/if}
      </div>
      {#if filled > 0}
        <div class="timeline">
          <button class="replay" onclick={() => board.replay()} aria-label="Replay the solve">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
            </svg>
          </button>
          <input
            class="scrub"
            type="range"
            min="0"
            max={filled}
            step="1"
            value={board.revealedCount}
            style:--p="{(100 * board.revealedCount) / filled}%"
            aria-label="Step through the solution"
            oninput={(e) => board.scrub(Number((e.currentTarget as HTMLInputElement).value))}
          />
          <span class="scrub-count"><b>{board.revealedCount}</b>/{filled}</span>
        </div>
      {/if}
    {/if}
    <div class="result-actions">
      <button class="btn btn-primary" onclick={() => board.clearSolution()}>Edit puzzle</button>
      <button class="btn btn-ghost" onclick={() => board.reset()}>New puzzle</button>
      <button class="btn btn-ghost" onclick={share}>Share</button>
    </div>
  </div>
{/if}

{#if board.conflicts.size > 0 && board.scanPhoto === null}
  <p class="notice danger" role="alert" transition:grow>Clashing numbers are highlighted.</p>
{:else if board.errorMessage}
  <p class="notice danger" role="alert" transition:grow>{board.errorMessage}</p>
{:else if board.status === 'solved' && board.multipleSolutions}
  <p class="notice warn" transition:grow>This puzzle has more than one solution. Showing one of them.</p>
{:else if board.status === 'editing' && board.source && board.scanPhoto === null}
  <p class="notice info" transition:grow>Loaded {board.source}.</p>
{/if}

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .tools {
    display: flex;
    gap: 2px;
  }

  .tool {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    min-width: 52px;
    padding: 6px 6px;
    border-radius: 12px;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-muted);
    transition:
      transform 0.12s var(--ease-out),
      background-color 0.15s,
      opacity 0.2s;
  }

  .tool:not(:disabled):active {
    transform: scale(0.92);
    background: var(--surface-2);
  }

  @media (hover: hover) {
    .tool:not(:disabled):hover {
      color: var(--text);
      background: var(--surface-2);
    }
  }

  .tool:disabled {
    opacity: 0.38;
    cursor: default;
  }

  .solve {
    min-width: 108px;
    height: 48px;
    padding-inline: 22px;
    border-radius: 999px;
    font-size: 1.02rem;
  }

  .key-hint {
    margin-left: 2px;
    padding: 0 5px;
    border-radius: 5px;
    font: inherit;
    font-size: 0.78rem;
    background: rgba(255, 255, 255, 0.2);
  }

  /* Keyboard hints only where there is a keyboard. */
  @media (hover: none) {
    .key-hint {
      display: none;
    }
  }

  .spinner {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border-radius: 20px;
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }

  .stats {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .stats b {
    color: var(--text);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .dot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--text-faint);
  }

  .timeline {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .replay {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--accent-ink);
    background: var(--accent-soft);
    transition: transform 0.12s var(--ease-out);
  }

  .replay:active {
    transform: scale(0.9) rotate(-30deg);
  }

  .scrub {
    flex: 1;
    min-width: 0;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--accent) calc(var(--p, 100%) - 0.5px), var(--line) var(--p, 100%));
    outline: none;
  }

  .scrub::-webkit-slider-thumb {
    appearance: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--surface);
    border: 2px solid var(--accent);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
    cursor: grab;
  }

  .scrub::-moz-range-thumb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--surface);
    border: 2px solid var(--accent);
    cursor: grab;
  }

  .scrub-count {
    flex: none;
    min-width: 3.4em;
    text-align: right;
    font-size: 0.82rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .scrub-count b {
    color: var(--text);
  }

  .result-actions {
    display: flex;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .result-actions .btn {
    flex: 1;
    min-width: 0;
    padding-inline: 10px;
    border-radius: 999px;
  }
</style>
