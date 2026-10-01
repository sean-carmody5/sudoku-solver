<script lang="ts">
  import { valueToChar } from '../lib/solver/board'
  import { board } from '../lib/stores/board.svelte'

  interface Props {
    cell: number
    /** Called on click (in the gesture) so the grid can focus its input. */
    onpick?: () => void
  }

  const { cell, onpick }: Props = $props()

  const n = $derived(board.size)
  const row = $derived(Math.floor(cell / n))
  const col = $derived(cell % n)
  const boxSize = $derived(Math.sqrt(n))

  const value = $derived(board.displayValue(cell))
  const isGiven = $derived(board.puzzle[cell] !== 0)
  const isSelected = $derived(board.selected === cell)
  const isConflict = $derived(board.conflicts.has(cell))
  const isRevealed = $derived(!isGiven && value !== 0)
  const isGuess = $derived.by(() => {
    const idx = board.placementIndex[cell]
    return idx !== -1 && board.placements[idx]?.kind === 'guess'
  })
  /** Peer highlight: same row/col/box as selection, softly tinted. */
  const isPeer = $derived.by(() => {
    if (board.selected === -1 || isSelected || board.status !== 'editing') return false
    const sr = Math.floor(board.selected / n)
    const sc = board.selected % n
    return (
      sr === row ||
      sc === col ||
      (Math.floor(sr / boxSize) === Math.floor(row / boxSize) &&
        Math.floor(sc / boxSize) === Math.floor(col / boxSize))
    )
  })
  /** Same-number highlight: every cell showing the selected cell's value. */
  const isSame = $derived(
    !isSelected && board.selectedValue !== 0 && value === board.selectedValue && board.status === 'editing',
  )
  /** Subtle checkerboard tint on alternating boxes to make structure legible. */
  const isAltBox = $derived(
    (Math.floor(row / boxSize) + Math.floor(col / boxSize)) % 2 === 1,
  )

  /** This cell's place in the solve cascade (CSS delay while it plays). */
  const revealDelay = $derived(
    board.status === 'animating' && isRevealed ? Math.max(0, board.placementIndex[cell]) * board.revealInterval : 0,
  )
  /** Remount the digit on each cascade so a replay plays its entrance. */
  const digitKey = $derived(`${value}:${isRevealed ? board.cascade : 0}`)

  /** A scanned read worth a second look (unclear or corrected). */
  const isFlagged = $derived(board.flagged.has(cell))
  /** Entrance stagger after a scan lands: ripples out from the centre. */
  const enterDelay = $derived.by(() => {
    const mid = (n - 1) / 2
    return Math.round(Math.hypot(row - mid, col - mid) * (n === 16 ? 26 : 42))
  })

  const label = $derived(
    `Row ${row + 1}, column ${col + 1}${value === 0 ? ', empty' : `, ${valueToChar(n, value, board.convention)}`}`,
  )
</script>

<button
  class="cell"
  class:given={isGiven}
  class:revealed={isRevealed}
  class:guess={isGuess}
  class:selected={isSelected}
  class:peer={isPeer}
  class:same={isSame}
  class:conflict={isConflict}
  class:alt-box={isAltBox}
  class:flagged={isFlagged}
  class:enter-hidden={board.entering === 'hidden'}
  class:enter-in={board.entering === 'in' && isGiven}
  style:--enter-delay="{enterDelay}ms"
  style:--reveal-delay="{revealDelay}ms"
  class:box-right={col % boxSize === boxSize - 1 && col !== n - 1}
  class:box-bottom={row % boxSize === boxSize - 1 && row !== n - 1}
  aria-label={label}
  aria-pressed={isSelected}
  tabindex="-1"
  onclick={() => {
    board.select(cell)
    onpick?.()
  }}
>
  {#if value !== 0}
    {#key digitKey}
      <span class="value settle">{valueToChar(n, value, board.convention)}</span>
    {/key}
  {/if}
</button>

<style>
  .cell {
    position: relative;
    display: grid;
    place-items: center;
    background: var(--surface);
    border-right: 1px solid var(--grid-line);
    border-bottom: 1px solid var(--grid-line);
    border-radius: 0;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    aspect-ratio: 1;
    min-width: 0;
    min-height: 0;
    padding: 0;
    font-size: var(--cell-font, 1.2rem);
  }

  .cell:focus-visible {
    box-shadow: none;
  }

  @media (hover: hover) {
    .cell:hover {
      background: color-mix(in srgb, var(--accent) 9%, var(--surface));
    }
  }

  .box-right {
    border-right: 2px solid var(--grid-box);
  }

  .box-bottom {
    border-bottom: 2px solid var(--grid-box);
  }

  .alt-box {
    background: color-mix(in srgb, var(--surface-2) 45%, var(--surface));
  }

  .peer {
    background: color-mix(in srgb, var(--surface-3) 70%, var(--surface));
  }

  .same {
    background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  }

  .same .value {
    color: var(--accent-ink);
    font-weight: 700;
  }

  .selected {
    background: var(--accent-soft);
    z-index: 1;
  }

  .given .value {
    font-weight: 700;
    color: var(--cell-given);
  }

  .revealed {
    color: var(--cell-solved);
  }

  /* The solve's tint on each newly filled cell, faded on its own layer (a
     background-colour animation repaints every animating cell each frame). */
  .revealed::before {
    content: '';
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    opacity: 0;
    pointer-events: none;
    animation: tint-fade 0.6s var(--ease-out) var(--reveal-delay, 0ms);
  }

  .revealed .settle {
    animation-delay: var(--reveal-delay, 0ms);
  }

  .revealed .value {
    font-weight: 600;
  }

  .guess.revealed {
    color: var(--cell-guess);
  }

  .conflict {
    background: var(--danger-soft);
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--danger) 55%, transparent);
    z-index: 1;
    animation: shake 0.35s var(--ease-out);
  }

  .conflict .value {
    color: var(--danger);
  }

  .value {
    line-height: 1;
  }

  .settle {
    animation: settle var(--spring-snappy-ms) var(--spring-snappy) backwards;
  }

  /* Scanned digits: invisible while the photo lands on them, then a ripple
     from the centre. */
  .enter-hidden .value {
    opacity: 0;
    animation: none;
  }

  .enter-in .value {
    animation: settle var(--spring-snappy-ms) var(--spring-snappy) var(--enter-delay) backwards;
  }

  .flagged::after {
    content: '';
    position: absolute;
    inset: 2px;
    border-radius: 6px;
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--warn) 75%, transparent);
    background: color-mix(in srgb, var(--warn) 9%, transparent);
    pointer-events: none;
    animation: flag-in 0.5s var(--ease-out) backwards;
  }

  /* One animation (a second one on the same element kept Chrome ticking
     it on the main thread): opacity is full a third of the way in, and the
     spring's overshoot only moves the digit. */
  @keyframes settle {
    0% {
      opacity: 0;
      transform: translateY(8%) scale(0.8);
    }
    35% {
      opacity: 1;
    }
    100% {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes flag-in {
    from {
      opacity: 0;
      transform: scale(1.12);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes tint-fade {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }

  /* Opacity reaches 1 quickly while the spring handles the motion (an
     overshooting spring would otherwise push opacity past 1 and back). */
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes shake {
    0%,
    100% {
      transform: translateX(0);
    }
    25% {
      transform: translateX(-2px);
    }
    75% {
      transform: translateX(2px);
    }
  }
</style>
