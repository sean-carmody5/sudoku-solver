<script lang="ts">
  import { board } from '../lib/stores/board.svelte'
  import { scan } from '../lib/stores/scan.svelte'
  import { grow } from '../lib/ui/motion'

  const show = $derived(board.scanPhoto !== null && board.entering !== 'hidden')
  const flagged = $derived(board.flaggedCount)
  const title = $derived.by(() => {
    if (board.status === 'solved' || board.status === 'animating') {
      return flagged > 0 ? `Solved. ${flagged} ${flagged === 1 ? 'digit was' : 'digits were'} unclear in the photo` : 'Solved from your photo'
    }
    if (board.status === 'solving') return 'Solving…'
    if (board.conflicts.size > 0) return 'Some digits clash. Tap one to fix it'
    if (!board.scanUnique) {
      return flagged > 0
        ? `Check the ${flagged} highlighted ${flagged === 1 ? 'cell' : 'cells'}, then solve`
        : 'Some digits may be missing. Check against the photo'
    }
    return 'Read from your photo'
  })
  const puzzles = $derived(board.scanOthers + 1)

  function hold(on: boolean): void {
    board.comparing = on
  }
</script>

{#if show}
  <div class="banner" transition:grow class:attention={board.status === 'editing' && (!board.scanUnique || board.conflicts.size > 0)}>
    <p class="title">{title}</p>
    <div class="actions">
      <button
        class="chip"
        aria-pressed={board.comparing}
        onpointerdown={() => hold(true)}
        onpointerup={() => hold(false)}
        onpointerleave={() => hold(false)}
        onpointercancel={() => hold(false)}
        onkeydown={(e) => (e.key === ' ' || e.key === 'Enter') && hold(true)}
        onkeyup={() => hold(false)}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Hold to compare
      </button>
      {#if puzzles > 1}
        <button class="chip" onclick={() => void scan.pickGrid((board.scanChosen + 1) % puzzles)}>
          Puzzle {board.scanChosen + 1} of {puzzles}
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      {/if}
      <button class="chip" onclick={() => scan.open()}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
        Retake
      </button>
    </div>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px 14px;
    flex-wrap: wrap;
    width: min(100%, 78vmin, 540px);
    margin: -4px auto 0;
    padding: 10px 12px 10px 16px;
    border-radius: 16px;
    background: color-mix(in srgb, var(--surface) 80%, transparent);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }

  .banner.attention {
    border-color: color-mix(in srgb, var(--warn) 45%, var(--line));
    background: color-mix(in srgb, var(--warn) 7%, var(--surface));
  }

  .title {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
  }

  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 11px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--line);
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    transition:
      color var(--dur-fast),
      background-color var(--dur-fast),
      transform 0.12s var(--ease-out);
  }

  .chip:hover {
    color: var(--text);
  }

  .chip:active,
  .chip[aria-pressed='true'] {
    transform: scale(0.97);
    color: var(--accent-ink);
    background: var(--accent-soft);
  }
</style>
