<script lang="ts">
  import { valueToChar } from '../lib/solver/board'
  import { board } from '../lib/stores/board.svelte'

  /** On-screen keys for the selected cell: 1-4, 1-9, or 16 keys in two rows
   * (0-F or 1-G per the puzzle's convention). A key does not move the
   * selection, so a mistyped digit can be corrected in place. */
  const n = $derived(board.size)
  const values = $derived(Array.from({ length: n }, (_, i) => i + 1))
  /** A value already placed n times is complete: its key dims. */
  const counts = $derived.by(() => {
    const c = new Array(n + 1).fill(0)
    for (const v of board.puzzle) if (v) c[v]++
    return c
  })
  const ready = $derived(board.status === 'editing' && board.selected !== -1)

  function press(v: number): void {
    if (ready) board.setCell(board.selected, v)
  }
</script>

<div class="numpad" class:sixteen={n === 16} class:four={n === 4} role="group" aria-label="Number pad">
  {#each values as v (v)}
    {@const ch = valueToChar(n, v, board.convention)}
    <button
      class="key"
      class:done={counts[v] >= n}
      disabled={!ready}
      aria-label="Enter {ch}"
      onpointerdown={(e) => e.pointerType === 'mouse' && e.preventDefault()}
      onclick={() => press(v)}
    >
      {ch}
    </button>
  {/each}
</div>

<style>
  .numpad {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 6px;
    width: 100%;
  }

  .numpad.four {
    grid-template-columns: repeat(4, 1fr);
  }

  .numpad.sixteen {
    grid-template-columns: repeat(8, 1fr);
  }

  .key {
    display: grid;
    place-items: center;
    height: 52px;
    border-radius: 12px;
    font-size: 1.45rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    background: var(--surface);
    box-shadow:
      0 1px 0 color-mix(in srgb, var(--text) 8%, transparent),
      0 0 0 1px var(--line);
    transition:
      transform 0.12s var(--ease-out),
      background-color 0.15s,
      opacity 0.2s;
    touch-action: manipulation;
  }

  .sixteen .key {
    height: 44px;
    font-size: 1.15rem;
  }

  .key:not(:disabled):active {
    transform: scale(0.92);
    background: var(--accent-soft);
  }

  @media (hover: hover) {
    .key:not(:disabled):hover {
      background: var(--surface-2);
    }
  }

  /* Larger screens: a keypad block in the side column (3x3, or 4x4). */
  @media (min-width: 900px) {
    .numpad {
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }

    .numpad.four,
    .numpad.sixteen {
      grid-template-columns: repeat(4, 1fr);
    }

    .key,
    .sixteen .key {
      height: 56px;
      font-size: 1.5rem;
    }
  }

  .key:disabled {
    cursor: default;
    color: var(--text-faint);
  }

  .key.done:not(:disabled) {
    color: var(--text-faint);
  }
</style>
