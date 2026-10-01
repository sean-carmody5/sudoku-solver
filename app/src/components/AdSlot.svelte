<script lang="ts">
  interface Props {
    /** Placement id, used when real ad units are wired in. */
    slot: string
  }

  const { slot }: Props = $props()

  // Placeholder until AdSense is configured with a real publisher id.
  const enabled = false
</script>

{#if enabled}
  <div class="ad" data-slot={slot}></div>
{/if}

<style>
  .ad {
    width: min(100%, 728px);
    min-height: 90px;
    margin: 0 auto;
    border-radius: 10px;
    background: var(--surface-2);
  }
</style>
