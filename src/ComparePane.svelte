<script>
  /**
   * One pane of the Compare view: an independent, navigable window onto the pedia.
   *
   * The important trick is `onContentClick`. Every link in the app renders as a
   * plain <a href="##ID"> (see LinkNoTooltip.svelte), so a single capture-phase
   * handler on the pane turns *all* of them - article links, section lists,
   * table cells - into pane-local navigation, without touching any of the
   * components that emit them.
   *
   * The committed selection still lives in the `id` prop (driven by the page
   * hash via the parent) so a comparison stays shareable; per-pane history is
   * kept in memory, since serialising every pane's back-stack into the URL would
   * make it unreadable for no real gain.
   */
  import { rul } from "./Ruleset";
  import Article from "./Article.svelte";
  import { Tr } from "./Components";
  import CogAnimation from "./CogAnimation.svelte";
  import { createEventDispatcher, afterUpdate, onMount } from "svelte";

  export let id = "";
  export let index = 0;
  export let focused = false;
  export let sortArticles = false;
  export let autofocus = false;
  /** Top-level field names that differ from the other pane(s). */
  export let diffKeys = null;
  export let highlight = true;

  const dispatch = createEventDispatcher();

  let query = "";
  let found = null; // array of article ids while searching, else null
  let searching = false; // true => show the results list instead of the article
  let searchHandle = null;
  let busy = false;
  let contentEl;
  let inputEl;
  let section = null;
  let showRecent = false;

  // Per-pane history. `histLock` marks a change we caused ourselves by stepping
  // through the stack, so it does not get pushed back on as a new entry.
  let hist = [];
  let histPos = -1;
  let histLock = false;
  let lastId = null;

  $: article = id && rul.article(id) ? rul.article(id) : null;

  $: onIdChanged(id);

  // Keep the pane's section pinned to whatever the current article belongs to,
  // so the ⇦ ⇨ page-turn buttons walk the right list.
  $: if (article && article.sections && article.sections.length) {
    if (!section || !article.sections.includes(section))
      section = article.sections[0];
  }

  $: recent = hist
    .slice(0, histPos)
    .filter((h) => h && h != id)
    .reverse()
    .filter((h, i, a) => a.indexOf(h) == i)
    .slice(0, 12);

  onMount(() => {
    if (autofocus && inputEl) inputEl.focus();
  });

  function onIdChanged(newId) {
    if (newId === lastId) return;
    lastId = newId;
    if (histLock) {
      histLock = false;
      return;
    }
    if (!newId && hist.length == 0) return;
    hist = [...hist.slice(0, histPos + 1), newId];
    histPos = hist.length - 1;
  }

  function go(delta) {
    const next = histPos + delta;
    if (next < 0 || next >= hist.length) return;
    histPos = next;
    // Leave `lastId` alone: onIdChanged has to see this as a real change so it
    // can clear the lock, otherwise the next genuine navigation gets swallowed.
    histLock = true;
    commit(hist[next]);
  }

  function commit(newId) {
    found = null;
    searching = false;
    query = "";
    showRecent = false;
    dispatch("select", newId);
  }

  /** Picking from search/links/recents - a normal navigation, so push history. */
  function pick(newId) {
    histLock = false;
    commit(newId);
  }

  function contains(text, substr) {
    return text.toLowerCase().indexOf(substr) != -1;
  }

  async function runSearch() {
    let q = query.trim().toLowerCase();
    if (q.length < 2) {
      found = null;
      searching = false;
      return;
    }
    busy = true;
    searching = true;
    let res = await rul.search[rul.langName].findArticles(q);
    // surface title/label matches first, mirroring the main search screen
    let hit = res.filter((a) => contains(rul.tr(a).toLowerCase(), q));
    let rest = res.filter((a) => !contains(rul.tr(a).toLowerCase(), q));
    found = [...hit, ...rest].slice(0, 200);
    busy = false;
  }

  function onKey(e) {
    if (searchHandle) clearTimeout(searchHandle);
    searchHandle = setTimeout(
      () => {
        runSearch();
        searchHandle = null;
      },
      e.key == "Enter" ? 10 : 600
    );
  }

  /**
   * Intercept every ##-link inside the pane so it navigates this pane instead of
   * the whole app. Shift-click sends the target to the neighbouring pane, which
   * is how you compare something you just spotted mid-article.
   */
  function onContentClick(e) {
    let el = e.target;
    while (el && el != contentEl && el.tagName != "A") el = el.parentNode;
    if (!el || el.tagName != "A") return;

    let href = el.getAttribute("href") || "";
    if (href.substring(0, 2) != "##") return;

    // Swallow it either way - a dead link must not blow the whole app out of
    // compare mode just because the target article does not exist.
    e.preventDefault();
    e.stopPropagation();

    let target = decodeURI(href.substring(2));
    let dd = target.indexOf("::");
    if (dd != -1) target = target.substring(0, dd);
    if (!target || !rul.article(target)) return;

    if (e.shiftKey) dispatch("selectOther", target);
    else pick(target);
  }

  /** ⇦ ⇨ on the article header - walk the pane's current section. */
  export function step(delta) {
    if (!article) return;
    let next = rul.findNextArticle(article, delta, section, sortArticles);
    if (next) pick(next.id);
  }

  export function focusSearch() {
    if (inputEl) inputEl.focus();
  }

  /**
   * In-place difference highlighting. The comparison itself is done on the
   * ruleset objects by compareDiff; here we only need to find the matching rows,
   * which MainTable/Item/Armor/Craft/Facility tag with data-key.
   */
  afterUpdate(() => {
    if (!contentEl) return;
    let rows = contentEl.querySelectorAll("tr[data-key]");
    for (let row of rows) {
      let on = highlight && diffKeys && diffKeys.has(row.getAttribute("data-key"));
      row.classList.toggle("diff-row", !!on);
    }
  });
</script>

<div
  class="compare-pane"
  class:compare-focused={focused}
  on:mousedown={() => dispatch("focus")}
  on:focusin={() => dispatch("focus")}
>
  <div class="compare-search">
    <button
      class="compare-nav"
      title="Back"
      disabled={histPos <= 0}
      on:click={() => go(-1)}>⬅</button
    >
    <button
      class="compare-nav"
      title="Forward"
      disabled={histPos >= hist.length - 1}
      on:click={() => go(1)}>➡</button
    >

    <div class="compare-recent-wrap">
      <button
        class="compare-nav"
        title="Recent in this pane"
        disabled={!recent.length}
        on:click={() => (showRecent = !showRecent)}>⏱</button
      >
      {#if showRecent && recent.length}
        <div class="compare-recent">
          {#each recent as rid}
            <button class="compare-result" on:click={() => pick(rid)}>
              {@html rul.tr(rid)}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <input
      class="input"
      type="text"
      bind:this={inputEl}
      id={"compare-search-" + index}
      bind:value={query}
      on:keyup={onKey}
      placeholder={rul.tr("Search...")}
    />

    {#if article}
      <button
        class="compare-nav"
        title="Open in full view"
        on:click={() => dispatch("open", id)}>↗</button
      >
      <button class="compare-clear" title="Clear this side" on:click={() => pick("")}
        >✕</button
      >
    {/if}
  </div>

  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div
    class="compare-content"
    bind:this={contentEl}
    on:click|capture={onContentClick}
    on:scroll={(e) => dispatch("scroll", { index, el: e.target })}
  >
    {#if searching}
      {#if busy}
        <CogAnimation size={30} />
      {:else if found && found.length}
        <div class="compare-results">
          {#each found as rid}
            <button class="compare-result" on:click={() => pick(rid)}>
              {@html rul.tr(rid)}
            </button>
          {/each}
        </div>
      {:else}
        <i><Tr s="Nothing found" /></i>
      {/if}
    {:else if article}
      {#key article.id}
        <Article
          {article}
          {query}
          on:prev={() => step(-1)}
          on:next={() => step(1)}
        />
      {/key}
    {:else}
      <div class="compare-empty"><Tr s="Type above to search" /></div>
    {/if}
  </div>
</div>
