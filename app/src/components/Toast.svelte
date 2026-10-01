<script lang="ts">
  import { fly } from 'svelte/transition'
  import { toast } from '../lib/stores/toast.svelte'
</script>

<div class="toasts" aria-live="polite">
  {#each toast.items as t (t.id)}
    <div class="toast {t.kind}" out:fly={{ y: -14, duration: 220, opacity: 0 }}>
      {#if t.kind === 'ok'}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      {/if}
      <span>{t.message}</span>
    </div>
  {/each}
</div>

<style>
  /* At the top, clear of the pad and the Scan button, dropping in like a
     system notice. */
  .toasts {
    position: fixed;
    left: 50%;
    top: calc(12px + env(safe-area-inset-top));
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100vw - 32px);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 80;
    pointer-events: none;
  }

  .toast {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 999px;
    text-align: center;
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(10px);
    animation: toast-in var(--spring-bouncy-ms) var(--spring-bouncy) backwards;
  }

  .toast.ok {
    color: var(--accent-ink);
  }

  .toast.warn {
    color: var(--warn);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(-18px) scale(0.92);
    }
    30% {
      opacity: 1;
    }
  }
</style>
