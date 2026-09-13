<script>
  /**
   * An XPedia article shown over the top of whatever you were doing.
   *
   * A popup rather than a navigation, on purpose. Both callers have state that
   * is expensive to rebuild and annoying to lose: the tech tree's column trail,
   * and CENTCOM's soldier, enemy and filter selection. Sending you to the
   * article page would throw either of them away.
   *
   * Shared so the two never drift apart. Set `id` to open, clear it to close;
   * Escape and a backdrop click both clear it.
   */
  import { rul } from "./Ruleset";
  import { onMount } from "svelte";
  import Article from "./Article.svelte";

  /** The article to show, or "" for closed. Bind it. */
  export let id = "";

  function close() {
    id = "";
  }

  function onKey(e) {
    if (e.key == "Escape" && id) close();
  }

  onMount(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Not every id has an article - a bare armour or an internal topic may not. */
  $: article = id && typeof rul.article == "function" ? rul.article(id) : null;
</script>

{#if id}
  <!-- The backdrop closes; the panel stops propagation so clicks inside do not. -->
  <div class="tech-peek-back" on:click={close}>
    <div class="tech-peek" on:click|stopPropagation>
      <div class="tech-peek-bar">
        <span class="tech-peek-title">{@html rul.tr(id)}</span>
        <button class="notepad-btn" title="Close (Esc)" on:click={close}>✕</button>
      </div>
      <div class="tech-peek-body">
        {#if article}
          {#key id}
            <Article {article} query="" />
          {/key}
        {:else}
          <p class="dmg-hint">No XPedia article for this one.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
