<script>
  /**
   * Compare view: N independent, navigable panes side by side plus a difference
   * summary underneath.
   *
   * Each pane's committed selection is fed from the parent (decoded from the page
   * hash). Any change - a pick, a swap, adding or dropping a pane - bubbles up as
   * one "change" event carrying the whole id list, so the parent only has to
   * rewrite the hash as ##COMPARE::A::B::… and the comparison stays shareable.
   */
  import ComparePane from "./ComparePane.svelte";
  import DiffPane from "./DiffPane.svelte";
  import { buildDiff } from "./compareDiff";
  import { MAX_PANES } from "./compareConfig";
  import { createEventDispatcher, onMount, onDestroy } from "svelte";

  export let ids = ["", ""];
  export let sortArticles = false;
  /** Index of the pane to focus on mount, or -1. Used when entering compare
   *  from an article: the left side is prefilled, so you land in the right. */
  export let autofocus = -1;

  const dispatch = createEventDispatcher();

  let containerEl;
  let paneRefs = [];
  let focusedPane = 0;
  let syncScroll = false;
  let highlight = true;
  let showSame = false;
  let diffCollapsed = false;
  let narrow = false;
  let activeTab = 0;
  let syncing = false;
  /**
   * Clip loaded in each pane, parallel to `ids`. Deliberately kept out of the
   * hash: it is a "what if" knob you flick while reading, not part of what the
   * comparison *is*, and it resets sensibly to the first compatible clip.
   */
  let ammoSel = [];

  let ammoFor = [];

  /**
   * Drop a pane's clip when that pane switches to a different article, so the
   * choice cannot leak onto an unrelated weapon in the same slot.
   *
   * Done in a function rather than inline so this only re-runs when `ids`
   * changes - a `$:` block that both read and wrote `ammoSel` would retrigger
   * on its own assignment.
   */
  function syncAmmo(next) {
    let changed = next.length != ammoFor.length;
    const kept = next.map((id, i) => {
      if (ammoFor[i] === id) return ammoSel[i];
      changed = true;
      return undefined;
    });
    if (changed) ammoSel = kept;
    ammoFor = [...next];
  }

  $: syncAmmo(ids);

  $: diff = buildDiff(ids, ammoSel);

  function onAmmo(e) {
    const next = [...ammoSel];
    next[e.detail.index] = e.detail.id;
    ammoSel = next;
  }
  $: if (focusedPane >= ids.length) focusedPane = ids.length - 1;
  $: if (typeof activeTab == "number" && activeTab >= ids.length)
    activeTab = ids.length - 1;

  function emit(next) {
    dispatch("change", next);
  }

  function setId(index, id) {
    let next = [...ids];
    next[index] = id;
    emit(next);
  }

  /** Shift-click inside a pane throws the target at the pane next door. */
  function setOther(index, id) {
    let target = ids.length < 2 ? index : (index + 1) % ids.length;
    setId(target, id);
    focusedPane = target;
    if (narrow) activeTab = target;
  }

  function swap() {
    emit([...ids].reverse());
  }

  function addPane() {
    if (ids.length >= MAX_PANES) return;
    emit([...ids, ""]);
  }

  function removePane() {
    if (ids.length <= 2) return;
    emit(ids.slice(0, -1));
  }

  function onScroll(e) {
    if (!syncScroll || syncing || !containerEl) return;
    let src = e.detail.el;
    let range = src.scrollHeight - src.clientHeight;
    if (range <= 0) return;
    let ratio = src.scrollTop / range;
    syncing = true;
    let all = containerEl.querySelectorAll(".compare-content");
    for (let el of all) {
      if (el == src) continue;
      let r = el.scrollHeight - el.clientHeight;
      if (r > 0) el.scrollTop = ratio * r;
    }
    requestAnimationFrame(() => (syncing = false));
  }

  /** Arrow keys drive whichever pane you last touched, not the whole app. */
  function onKeyDown(e) {
    if (e.key != "ArrowLeft" && e.key != "ArrowRight") return;
    let t = e.target;
    if (t && (t.tagName == "INPUT" || t.tagName == "TEXTAREA" || t.tagName == "SELECT"))
      return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    let pane = paneRefs[narrow ? activeTab : focusedPane];
    if (!pane || !pane.step) return;
    e.preventDefault();
    pane.step(e.key == "ArrowRight" ? 1 : -1);
  }

  let mq;
  function onMedia(e) {
    narrow = e.matches;
  }

  function loadPrefs() {
    try {
      let p = JSON.parse(localStorage.xpediaCompare || "{}");
      if (typeof p.syncScroll == "boolean") syncScroll = p.syncScroll;
      if (typeof p.highlight == "boolean") highlight = p.highlight;
      if (typeof p.showSame == "boolean") showSame = p.showSame;
      if (typeof p.diffCollapsed == "boolean") diffCollapsed = p.diffCollapsed;
    } catch (e) {}
  }

  /** `deps` is unused - it exists so the reactive block below tracks the prefs. */
  function savePrefs(...deps) {
    if (!prefsLoaded) return;
    try {
      localStorage.xpediaCompare = JSON.stringify({
        syncScroll,
        highlight,
        showSame,
        diffCollapsed,
      });
    } catch (e) {}
  }

  // Load at init, not in onMount: reactive statements run before mount, so a
  // save would otherwise fire first and overwrite the stored prefs with defaults.
  let prefsLoaded = false;
  loadPrefs();
  prefsLoaded = true;

  $: savePrefs(syncScroll, highlight, showSame, diffCollapsed);

  onMount(() => {
    if (autofocus >= 0) focusedPane = autofocus;
    mq = window.matchMedia("(max-width: 720px)");
    narrow = mq.matches;
    if (mq.addEventListener) mq.addEventListener("change", onMedia);
    else mq.addListener(onMedia);
    document.addEventListener("keydown", onKeyDown);
  });

  onDestroy(() => {
    if (mq) {
      if (mq.removeEventListener) mq.removeEventListener("change", onMedia);
      else mq.removeListener(onMedia);
    }
    document.removeEventListener("keydown", onKeyDown);
  });
</script>

<div class="compare-wrap">
  <div class="compare-toolbar">
    <button class="compare-tool" title="Swap sides" on:click={swap}>⇄</button>
    <button
      class="compare-tool"
      title="Add a pane"
      disabled={ids.length >= MAX_PANES}
      on:click={addPane}>＋</button
    >
    <button
      class="compare-tool"
      title="Remove last pane"
      disabled={ids.length <= 2}
      on:click={removePane}>－</button
    >
    <button
      class="compare-tool"
      class:compare-tool-on={syncScroll}
      title="Sync scrolling"
      on:click={() => (syncScroll = !syncScroll)}>⇅</button
    >

    {#if narrow}
      <span class="stretcher" />
      <div class="compare-tabs">
        {#each ids as id, i}
          <button
            class="compare-tab"
            class:compare-tab-on={activeTab == i}
            on:click={() => {
              activeTab = i;
              focusedPane = i;
            }}
          >
            {i + 1}
          </button>
        {/each}
        <button
          class="compare-tab"
          class:compare-tab-on={activeTab == "diff"}
          on:click={() => (activeTab = "diff")}>Δ</button
        >
      </div>
    {/if}
  </div>

  <div class="compare-container" bind:this={containerEl}>
    {#each ids as id, i (i)}
      {#if i > 0}
        <div class="compare-divider" />
      {/if}
      <div
        class="compare-slot"
        class:compare-hidden={narrow && activeTab !== i}
      >
        <ComparePane
          bind:this={paneRefs[i]}
          {id}
          index={i}
          {sortArticles}
          {highlight}
          autofocus={autofocus == i}
          focused={focusedPane == i}
          diffKeys={diff.diffKeys}
          on:select={(e) => setId(i, e.detail)}
          on:selectOther={(e) => setOther(i, e.detail)}
          on:open={(e) => dispatch("open", e.detail)}
          on:focus={() => (focusedPane = i)}
          on:scroll={onScroll}
        />
      </div>
    {/each}
  </div>

  <div class="compare-diff-slot" class:compare-hidden={narrow && activeTab !== "diff"}>
    <DiffPane
      {diff}
      {highlight}
      bind:showSame
      collapsed={diffCollapsed && !narrow}
      on:collapse={() => (diffCollapsed = !diffCollapsed)}
      on:highlight={(e) => (highlight = e.detail)}
      on:ammo={onAmmo}
      on:pick={(e) => setId(narrow ? (activeTab === "diff" ? focusedPane : activeTab) : focusedPane, e.detail)}
    />
  </div>
</div>
