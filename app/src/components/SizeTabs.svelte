<script lang="ts">
  import { GRID_SIZES, type GridSize } from '../lib/solver/board'
  import { board } from '../lib/stores/board.svelte'

  const index = $derived(Math.max(0, GRID_SIZES.indexOf(board.size)))

  function label(s: GridSize): string {
    return `${s}×${s}`
  }
</script>

<!-- A segmented control: the selected segment's thumb slides on a spring. -->
<div class="tabs" role="tablist" aria-label="Grid size" style:--i={index} style:--n={GRID_SIZES.length}>
  <span class="thumb" aria-hidden="true"></span>
  {#each GRID_SIZES as s (s)}
    <button class="tab" class:active={board.size === s} role="tab" aria-selected={board.size === s} onclick={() => board.setSize(s)}>
      {label(s)}
    </button>
  {/each}
</div>

<style>
  .tabs {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    width: min(100%, 320px);
    padding: 3px;
    border-radius: 12px;
    background: var(--surface-2);
  }

  .thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: calc((100% - 6px) / var(--n));
    border-radius: 9px;
    background: var(--surface);
    box-shadow:
      0 1px 3px rgba(0, 0, 0, 0.12),
      0 0 0 0.5px rgba(0, 0, 0, 0.04);
    transform: translateX(calc(var(--i) * 100%));
    transition: transform var(--spring-snappy-ms) var(--spring-snappy);
  }

  .tab {
    position: relative;
    padding: 7px 0;
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text-muted);
    transition: color 0.2s;
  }

  .tab.active {
    color: var(--text);
  }

  .tab:active {
    opacity: 0.6;
  }
</style>
