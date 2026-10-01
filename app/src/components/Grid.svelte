<script lang="ts">
  import type { TransitionConfig } from 'svelte/transition'
  import { board } from '../lib/stores/board.svelte'
  import { SMOOTH } from '../lib/ui/motion'
  import Cell from './Cell.svelte'

  /** A new grid size settles in rather than swapping in one frame. */
  function sizeIn(_node: Element): TransitionConfig {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return { duration: 0 }
    return {
      duration: SMOOTH.ms,
      easing: SMOOTH.ease,
      css: (t) => `opacity: ${Math.min(1, t * 1.8)}; transform: scale(${0.965 + 0.035 * t})`,
    }
  }

  const n = $derived(board.size)
  const cellFont = $derived(n === 16 ? 'clamp(0.65rem, 3.6vmin, 1.05rem)' : 'clamp(1rem, 5.8vmin, 1.6rem)')
  const showHint = $derived(
    board.status === 'editing' && board.givenCount === 0 && board.selected === -1,
  )
  const cursorRow = $derived(Math.floor(board.selected / n))
  const cursorCol = $derived(board.selected % n)
  const showCursor = $derived(board.selected !== -1 && board.status === 'editing')

  // A hidden, focusable input takes physical-keyboard typing. Touch devices
  // enter digits with the on-screen number pad, so there the input asks for
  // no virtual keyboard (inputmode none) while still taking a paired one.
  let entry = $state<HTMLInputElement>() as HTMLInputElement
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

  // Re-focus when selection moves via the keyboard (arrow keys).
  $effect(() => {
    if (board.status === 'editing' && board.selected !== -1 && entry) {
      entry.focus({ preventScroll: false })
    }
  })

  // Clicking a cell button takes focus; restore it to the hidden input on the
  // same click (after board.select from the cell's own handler). Running in
  // the click gesture is also what lets iOS open its keyboard.
  function focusEntry() {
    if (board.status === 'editing' && entry) entry.focus({ preventScroll: false })
  }

  function onKeydown(e: KeyboardEvent) {
    if (board.status === 'animating') {
      board.finishAnimation()
      e.preventDefault()
      return
    }
    if (board.status !== 'editing') return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      board.undo()
      e.preventDefault()
      return
    }
    switch (e.key) {
      case 'ArrowUp':
        board.moveSelection(-1, 0)
        break
      case 'ArrowDown':
        board.moveSelection(1, 0)
        break
      case 'ArrowLeft':
        board.moveSelection(0, -1)
        break
      case 'ArrowRight':
        board.moveSelection(0, 1)
        break
      case 'Backspace':
      case 'Delete':
        board.clearSelected()
        break
      case ' ':
        board.moveSelection(0, 1)
        break
      case 'Enter':
        if (board.canSolve) void board.solve()
        else board.moveSelection(0, 1)
        break
      case 'Escape':
        board.deselect()
        entry.blur()
        break
      default:
        return // let printable keys go to beforeinput (avoids double entry)
    }
    e.preventDefault()
  }

  // Character entry via beforeinput fires reliably on both physical and
  // on-screen keyboards (keydown is unreliable for mobile soft keyboards).
  function onBeforeInput(e: InputEvent) {
    if (board.status !== 'editing') return
    if (e.inputType === 'insertText' && e.data) board.input(e.data)
    else if (e.inputType.startsWith('delete')) board.clearSelected()
    e.preventDefault()
  }
</script>

<div class="grid-wrap">
<!-- The solved glow lives outside the (clipped) grid and only fades. -->
<div class="glow" class:on={board.status === 'solved'} aria-hidden="true"></div>
{#key n}
<div in:sizeIn
  class="grid"
  class:solved={board.status === 'solved'}
  class:solving={board.status === 'solving'}
  style:--n={n}
  style:--cell-font={cellFont}
  role="group"
  aria-label="Sudoku grid, {n} by {n}"
>
  <input
    bind:this={entry}
    class="entry"
    value=""
    inputmode={touch ? 'none' : n === 16 ? 'text' : 'numeric'}
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    aria-label="Type a value for the selected cell"
    onkeydown={onKeydown}
    onbeforeinput={onBeforeInput}
  />
  {#each { length: n * n } as _, cell (cell)}
    <Cell {cell} onpick={focusEntry} />
  {/each}

  {#if board.scanPhoto}
    <img class="compare" class:on={board.comparing} src={board.scanPhoto} alt="" aria-hidden="true" />
  {/if}

  {#if showCursor}
    <div
      class="cursor"
      aria-hidden="true"
      style:width="{100 / n}%"
      style:height="{100 / n}%"
      style:transform="translate({cursorCol * 100}%, {cursorRow * 100}%)"
    ></div>
  {/if}

  {#if showHint}
    <div class="hint">
      <p>Tap a cell, then a number</p>
      <div class="hint-actions">
        <button class="btn btn-ghost" onclick={() => board.loadExample()}>Try an example</button>
      </div>
    </div>
  {/if}
</div>
{/key}
</div>

<style>
  /* As wide as the column on a portrait phone, bounded by the screen's
     height so the pad and the Scan button still fit below it. */
  .grid-wrap {
    position: relative;
    width: min(100%, 540px, 58svh);
    margin: 0 auto;
  }

  .glow {
    position: absolute;
    inset: 0;
    border-radius: 14px;
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent),
      0 0 46px -4px color-mix(in srgb, var(--accent) 35%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.7s var(--ease-out);
  }

  .glow.on {
    opacity: 1;
  }

  .grid {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    width: 100%;
    border: 2px solid var(--grid-box);
    border-radius: 14px;
    overflow: hidden;
    background: var(--surface);
    box-shadow:
      var(--shadow),
      inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent);
    touch-action: manipulation;
  }


  /* The scanned photo, straightened onto the board while "compare" is held. */
  .compare {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
    z-index: 3;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s var(--ease-out);
  }

  .compare.on {
    opacity: 1;
  }

  /* Focusable but invisible: drives keyboard entry without an on-screen pad.
     16px font-size stops iOS from zooming in when it takes focus. */
  .entry {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    font-size: 16px;
    opacity: 0;
    pointer-events: none;
    caret-color: transparent;
    z-index: -1;
  }

  /* Selection ring that glides between cells instead of snapping. */
  .cursor {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    z-index: 2;
    border-radius: 5px;
    box-shadow:
      inset 0 0 0 2px var(--accent),
      0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent),
      0 0 14px color-mix(in srgb, var(--accent) 35%, transparent);
    transition: transform 0.16s var(--ease-out);
    animation: cursor-in 0.2s var(--ease-spring);
  }

  @keyframes cursor-in {
    from {
      opacity: 0;
      scale: 1.15;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }

  /* Taps go through to the cells beneath; only the buttons take them. */
  .hint {
    pointer-events: none;
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    padding: 16px;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--surface) 55%, transparent);
    animation: fade-in var(--dur-slow) var(--ease-out) backwards;
    z-index: 3;
  }

  .hint p {
    margin: 0;
    font-size: 0.98rem;
    font-weight: 500;
  }

  .hint-actions :global(button) {
    pointer-events: auto;
  }

  .hint-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
  }

  /* Solved: one soft light sweep across the grid (a band moved by transform,
     not a repainted background), while the glow fades in around it. */
  .solved::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    pointer-events: none;
    z-index: 4;
    background: linear-gradient(
      110deg,
      transparent 20%,
      color-mix(in srgb, var(--accent) 20%, transparent) 44%,
      color-mix(in srgb, #fff 55%, transparent) 50%,
      color-mix(in srgb, var(--accent) 20%, transparent) 56%,
      transparent 80%
    );
    transform: translateX(-100%);
    animation: sweep 1.05s var(--ease-in-out) 0.05s backwards;
  }

  @keyframes sweep {
    0% {
      transform: translateX(-100%);
      opacity: 1;
    }
    85% {
      opacity: 1;
    }
    100% {
      transform: translateX(100%);
      opacity: 0;
    }
  }
</style>
