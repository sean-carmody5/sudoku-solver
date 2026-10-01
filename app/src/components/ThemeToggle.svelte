<script lang="ts">
  import { theme } from '../lib/stores/theme.svelte'
</script>

<button
  class="toggle"
  onclick={() => theme.toggle()}
  aria-label="Switch to {theme.current === 'dark' ? 'light' : 'dark'} theme"
>
  {#key theme.current}
  {#if theme.current === 'dark'}
    <svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  {:else}
    <svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
    </svg>
  {/if}
  {/key}
</button>

<style>
  .toggle {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    color: var(--text-muted);
    border: 1px solid var(--line);
    background: var(--surface);
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  /* The new icon turns in on a spring. */
  .icon {
    animation: icon-in var(--spring-bouncy-ms) var(--spring-bouncy) backwards;
  }

  @keyframes icon-in {
    from {
      opacity: 0;
      transform: rotate(-70deg) scale(0.6);
    }
    40% {
      opacity: 1;
    }
  }

  .toggle:hover {
    color: var(--text);
    background: var(--surface-2);
  }
</style>
