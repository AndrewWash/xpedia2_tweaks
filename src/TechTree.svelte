<script>
  /**
   * Tech tree viewer.
   *
   * Built around one complaint about every existing viewer, in-game and here:
   * clicking a prerequisite or a "leads to" navigates you AWAY from what you
   * were looking at. You cannot compare diverging paths, and backing up to the
   * parent means the back button and losing your branch.
   *
   * So this is a COLUMN BROWSER. Each click opens a column to the right and
   * every ancestor stays on screen. Clicking a row in an earlier column
   * truncates back to it and branches from there, so the whole path you walked
   * is always visible and always re-branchable.
   *
   * The arithmetic lives in techTree.ts, which knows nothing about the UI.
   */
  import { rul } from "./Ruleset";
  import { onMount } from "svelte";
  import ArticlePeek from "./ArticlePeek.svelte";
  import { get } from "svelte/store";
  import { currentSave, currentSavePath, droppedSaves, setCurrentSave } from "./store";
  import { findSaves, stampSaves, sortSaves, loadSave, parseSave } from "./damageSave";
  import {
    topic,
    topicInfo,
    statusOf,
    missingFor,
    pathTo,
    daysFor,
    availableNow,
    inProgress,
    opensUp,
    caveatsFor,
    unblockCounts,
    impactOf,
    routeTopics,
    isRouteTopic,
  } from "./techTree";

  export let topicId = "";

  const SAVE_PREF = "xpediaSave";
  const MARK_PREF = "xpediaTechMarks";

  let saveList = [];
  let savePath = "";
  let saveState = null;
  let saveLoading = false;
  let saveError = "";
  let savesRefreshing = false;

  /** Bookmarked topics, in the order they were starred. */
  let marks = [];

  /**
   * The column trail. Index 0 is the list; every entry after it is a topic
   * opened from the column before. Truncating this array IS backing up.
   */
  let trail = [];

  let filter = "available";
  let search = "";
  let goal = "";
  let todoSort = "impact";
  /**
   * The XPedia article shown over the top, or "".
   *
   * A popup rather than a navigation on purpose: the whole point of the column
   * browser is that you never lose your place, and sending you to the article
   * page would throw the entire trail away.
   */
  let peekId = "";

  function peek(id) {
    peekId = id;
  }


  const TODO_SORTS = [
    { id: "impact", label: "Impact", title: "Value per day: how many topics it unblocks plus what it lets you build or buy, divided by the days it takes. A ratio, so there is nothing to tune - a cheap topic that frees six others beats an expensive one that frees two." },
    { id: "days", label: "Days", title: "Quickest first. Uses the save's own rolled cost for anything already started." },
    { id: "status", label: "Status", title: "What you can act on now first: available, then needs an item, then in progress, then blocked." },
    { id: "name", label: "Name", title: "Alphabetical." },
    { id: "added", label: "Added", title: "The order you starred them." },
  ];

  const FILTERS = [
    { id: "available", label: "Available now", title: "Everything you could start right now: research satisfied AND the item in stores if it wants one." },
    { id: "progress", label: "In progress", title: "Already being researched, from the save's own project list." },
    { id: "needsItem", label: "Needs an item", title: "Research is clear - you just do not hold the thing it wants to examine." },
    { id: "routes", label: "Routes", title: "Branching choices. Taking one rules the others out for the rest of the campaign - Codices, Captains, Embrace or Reject the Power. Sorted so what is still open comes first." },
    { id: "marked", label: "Bookmarked", title: "Topics you have starred." },
    { id: "all", label: "All", title: "Every research topic in the mod." },
  ];

  const STATUS_LABEL = {
    done: "done",
    lockedOut: "ruled out by a choice you made",
    inProgress: "in progress",
    available: "available",
    needsItem: "needs an item",
    blocked: "blocked",
  };

  onMount(() => {
    try {
      const raw = JSON.parse(localStorage[MARK_PREF] || "[]");
      if (Array.isArray(raw)) marks = raw.filter((x) => typeof x == "string");
    } catch (e) {
      marks = [];
    }
    // Whatever the other screen was looking at wins; discoverSaves only
    // fills in the picker list and the remembered fallback.
    adoptSharedSave();
    discoverSaves();
    if (topicId && topic(topicId)) trail = [topicId];
  });

  function persistMarks() {
    try {
      localStorage[MARK_PREF] = JSON.stringify(marks);
    } catch (e) {
      // Losing bookmarks is not worth failing over.
    }
  }

  function toggleMark(id) {
    marks = marks.includes(id) ? marks.filter((x) => x != id) : [...marks, id];
    persistMarks();
  }

  /**
   * Take the save the other screen already has, if there is one.
   *
   * Saves a re-parse on every tab switch, and is the only way a save that was
   * DROPPED in as a file survives the trip - there is no path to fetch it back
   * from. Runs before discoverSaves so the screen is populated immediately.
   */
  function adoptSharedSave() {
    const path = get(currentSavePath);
    const state = get(currentSave);
    if (!path || !state) return false;
    savePath = path;
    saveState = state;
    if (droppedSaves.has(path) && !saveList.some((x) => x.path == path))
      saveList = [{ path, file: path, dir: "", modified: 0 }, ...saveList];
    return true;
  }

  async function discoverSaves() {
    let found = [];
    try {
      found = await findSaves();
    } catch (e) {
      return;
    }
    if (!found.length) return;
    try {
      await stampSaves(found);
    } catch (e) {
      // Alphabetical ordering is fine.
    }
    saveList = [
      ...saveList.filter((x) => droppedSaves.has(x.path)),
      ...sortSaves(found).filter((x) => !droppedSaves.has(x.path)),
    ];
    if (saveState) return;   // already adopted from the other screen
    let remembered = "";
    try {
      remembered = localStorage[SAVE_PREF] || "";
    } catch (e) {
      remembered = "";
    }
    if (remembered && saveList.some((x) => x.path == remembered)) pickSave(remembered);
  }

  /** Rescan and re-read. Saves are never cached, so this is cheap. */
  async function refreshSaves() {
    savesRefreshing = true;
    const keep = savePath;
    await discoverSaves();
    if (keep && saveList.some((x) => x.path == keep)) await pickSave(keep);
    savesRefreshing = false;
  }

  async function pickSave(path) {
    savePath = path;
    saveState = null;
    saveError = "";
    try {
      localStorage[SAVE_PREF] = path;
    } catch (e) {
      // no-op
    }
    if (!path) {
      setCurrentSave("", null);
      return;
    }
    if (droppedSaves.has(path)) {
      saveState = droppedSaves.get(path);
      setCurrentSave(path, saveState);
      return;
    }
    saveLoading = true;
    const loaded = await loadSave(path);
    saveLoading = false;
    if (!loaded) {
      saveError = "Could not read that save";
      return;
    }
    saveState = loaded;
    setCurrentSave(path, loaded);
  }

  /** A .sav handed over by picker or drop - there is no URL to re-fetch it. */
  function readSavFile(file) {
    if (!file) return;
    saveError = "";
    saveLoading = true;
    const reader = new FileReader();
    reader.onerror = () => {
      saveLoading = false;
      saveError = "Could not read that file";
    };
    reader.onload = () => {
      saveLoading = false;
      const parsed = parseSave(String(reader.result), file.name);
      if (!parsed) {
        saveError = "Could not read that save";
        return;
      }
      saveState = parsed;
      savePath = file.name;
      droppedSaves.set(file.name, parsed);
      setCurrentSave(file.name, parsed);
      if (!saveList.some((x) => x.path == file.name))
        saveList = [{ path: file.name, file: file.name, dir: "", modified: 0 }, ...saveList];
    };
    reader.readAsText(file);
  }

  let savDragOver = false;
  function onSavDrop(e) {
    e.preventDefault();
    savDragOver = false;
    const dt = e.dataTransfer;
    readSavFile(dt && dt.files && dt.files[0]);
  }

  const allIds = Object.keys(rul.research || {});

  /**
   * The first column. Rebuilt only when the save or the filter changes, never
   * per keystroke of the search box - `all` is 4612 entries.
   */
  $: pool =
    filter == "available"
      ? availableNow(saveState)
      : filter == "progress"
        ? inProgress(saveState)
        : filter == "marked"
          ? marks.filter((id) => topic(id))
          : filter == "needsItem"
            ? allIds.filter((id) => statusOf(id, saveState) == "needsItem")
            : filter == "routes"
              ? routeTopics()
              : allIds;

  $: needle = search.trim().toLowerCase();
  $: rows = (needle
    ? pool.filter((id) => rul.tr(id).toLowerCase().includes(needle) || id.toLowerCase().includes(needle))
    : pool
  )
    .map((id) => ({ id, title: rul.tr(id), status: statusOf(id, saveState) }))
    .sort((a, b) => {
      // On the Routes tab the useful order is "what can I still choose",
      // then what I already took, then the doors that closed behind me.
      if (filter == "routes") {
        const rank = (x) => (x.status == "lockedOut" ? 2 : x.status == "done" ? 1 : 0);
        const d = rank(a) - rank(b);
        if (d) return d;
      }
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    });

  /** Counts for the filter chips, so you can see the shape before clicking. */
  $: counts = (() => {
    const c = {
      available: 0, progress: 0, needsItem: 0,
      marked: marks.length, all: allIds.length, routes: routeTopics().length,
    };
    if (!saveState) return c;
    c.available = availableNow(saveState).length;
    c.progress = inProgress(saveState).length;
    for (const id of allIds) if (statusOf(id, saveState) == "needsItem") c.needsItem++;
    return c;
  })();

  /**
   * The to-do list. One pass of unblockCounts feeds every impact score, so
   * sorting the list is cheap however long it gets.
   */
  $: unblocks = saveState ? unblockCounts(saveState) : new Map();
  const STATUS_RANK = { available: 0, needsItem: 1, inProgress: 2, blocked: 3, done: 4 };
  $: todo = (() => {
    const items = marks
      .filter((id) => topic(id))
      .map((id, i) => ({
        id,
        title: rul.tr(id),
        added: i,
        status: statusOf(id, saveState),
        days: daysFor(id, saveState),
        impact: impactOf(id, saveState, unblocks),
      }));
    const byName = (a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    if (todoSort == "added") return items;
    if (todoSort == "name") return items.sort(byName);
    if (todoSort == "days")
      // Unknown days sink rather than sorting as zero.
      return items.sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9) || byName(a, b));
    if (todoSort == "status")
      return items.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byName(a, b));
    return items.sort((a, b) => b.impact.score - a.impact.score || byName(a, b));
  })();

  /** Detail for every topic in the trail, recomputed when the save changes. */
  $: cards = trail.map((id) => ({
    id,
    info: topicInfo(id, saveState),
    opens: opensUp(id),
  }));

  $: goalPath = goal && topic(goal) ? pathTo(goal, saveState) : [];

  /**
   * Open `id` as the column after `depth`.
   *
   * Everything to the right is discarded, which is the whole point: clicking a
   * row in an earlier column backs up to it and branches from there.
   */
  function open(id, depth) {
    if (!topic(id)) return;
    const next = trail.slice(0, depth);
    if (next[depth - 1] == id) {
      trail = next;
      return;
    }
    trail = [...next, id];
    try {
      window.history.replaceState(null, "", "#" + "#TECH::" + id);
    } catch (e) {
      // Hash is a convenience, not a requirement.
    }
  }

  const dot = (s) => "dmg-dot dmg-dot-" + s;
</script>

<div class="dmg-root">
  <div class="dmg-toolbar">
    <span class="dmg-note">
      Click through prerequisites and unlocks — every step stays on screen. Click any
      earlier column to back up and branch.
    </span>
  </div>

  <div class="dmg-body tech-body">
    <aside class="dmg-side">
      <section
        class="dmg-block"
        class:dmg-dropping={savDragOver}
        on:dragover|preventDefault={() => (savDragOver = true)}
        on:dragleave={() => (savDragOver = false)}
        on:drop={onSavDrop}
      >
        <header>
          Campaign
          <button
            class="dmg-mini dmg-refresh"
            title="Rescan for saved games and re-read the selected one. Saves are never cached, so this picks up a game you just saved - no page reload needed."
            disabled={savesRefreshing}
            on:click={refreshSaves}>⭯</button
          >
        </header>
        {#if !saveList.length}
          <p class="dmg-cap">
            No saved games found. Drop a <code>.sav</code> on this panel, or pick one below.
          </p>
        {:else}
          <select
            class="dmg-input"
            title="Which campaign decides what is researched, held and underway"
            value={savePath}
            on:change={(e) => pickSave(e.target.value)}
          >
            <option value="">(no save — show everything)</option>
            {#each saveList as sv}
              <option value={sv.path}>{sv.file.replace(/\.a?sav$/, "")}</option>
            {/each}
          </select>
        {/if}
        <label class="dmg-mini dmg-file" title="Read a .sav from anywhere on disk. You can also drop one on this panel.">
          Open a .sav…
          <input
            type="file"
            accept=".sav,.asav"
            on:change={(e) => {
              readSavFile(e.target.files && e.target.files[0]);
              e.target.value = "";
            }}
          />
        </label>
        {#if saveLoading}
          <p class="dmg-cap">Reading save…</p>
        {:else if saveError}
          <p class="dmg-warn">⚠ {saveError}</p>
        {:else if saveState}
          <p class="dmg-cap">
            {@html saveState.name || "save"}{#if saveState.date}&nbsp;· {saveState.date}{/if}<br />
            {saveState.discovered.size} researched · {saveState.projects.size} underway ·
            <b>{saveState.scientists}</b> brainers
          </p>
          {#if !saveState.scientists}
            <p class="dmg-hint">
              No brainers found, so day estimates are shown as “—”.
            </p>
          {/if}
        {:else}
          <p class="dmg-hint">
            Without a save every topic reads as blocked — pick one to see what you can
            actually research.
          </p>
        {/if}
      </section>

      <section class="dmg-block">
        <header>Show</header>
        <div class="dmg-chips">
          {#each FILTERS as f}
            <button
              class="dmg-chip"
              class:dmg-chip-on={filter == f.id}
              title={f.title}
              on:click={() => (filter = f.id)}
            >
              {f.label}
              <span class="dmg-chip-n">{counts[f.id] ?? 0}</span>
            </button>
          {/each}
        </div>
        <input class="dmg-input" placeholder="Search topics…" bind:value={search} />
      </section>

      <section class="dmg-block">
        <header>
          To-do
          <span class="dmg-cap">{todo.length}</span>
        </header>
        {#if !todo.length}
          <p class="dmg-hint">
            Star a topic (★ in its column header) to put it here. The list survives
            reloads.
          </p>
        {:else}
          <div class="dmg-chips">
            {#each TODO_SORTS as srt}
              <button
                class="dmg-chip"
                class:dmg-chip-on={todoSort == srt.id}
                title={srt.title}
                on:click={() => (todoSort = srt.id)}>{srt.label}</button
              >
            {/each}
          </div>
          <ul class="tech-todo">
            {#each todo as t}
              <li>
                <span class={dot(t.status)} title={STATUS_LABEL[t.status]} />
                <button class="dmg-linkish tech-todoname" on:click={() => open(t.id, 0)}
                  >{t.title}</button
                >
                <span
                  class="dmg-cap"
                  title={"Unblocks " + t.impact.unblocks + " topic(s), opens " + t.impact.gear +
                    " thing(s) to build or buy, " + (t.days == null ? "days unknown" : t.days + " day(s)")}
                >
                  {#if todoSort == "impact"}
                    {t.impact.unblocks + t.impact.gear}▸{t.days == null ? "—" : t.days + "d"}
                  {:else}
                    {t.days == null ? "—" : t.days + "d"}
                  {/if}
                </span>
                <button class="dmg-mini" title="Remove from the to-do list" on:click={() => toggleMark(t.id)}>✕</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="dmg-block">
        <header title="Pick a target and get everything still missing, in an order you could actually research them in.">
          Path to a goal
        </header>
        <input
          class="dmg-input"
          list="tech-goals"
          placeholder="Type a topic…"
          bind:value={goal}
        />
        <datalist id="tech-goals">
          {#each allIds.slice(0, 4000) as id}<option value={id}>{rul.tr(id)}</option>{/each}
        </datalist>
        {#if goal && !topic(goal)}
          <p class="dmg-hint">No topic with that id.</p>
        {:else if goal && !goalPath.length}
          <p class="dmg-hint">Already researched.</p>
        {:else if goalPath.length}
          <p class="dmg-cap">{goalPath.length} still needed, in order:</p>
          <ol class="dmg-goalpath">
            {#each goalPath as id}
              <li>
                <span class={dot(statusOf(id, saveState))} />
                <button class="dmg-linkish" on:click={() => open(id, 0)}>{rul.tr(id)}</button>
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </aside>

    <div class="tech-cols">
      <!-- Column 0: the list everything starts from. -->
      <div class="tech-col">
        <header class="tech-colhead">
          {FILTERS.find((f) => f.id == filter).label}
          <span class="dmg-cap">{rows.length}</span>
        </header>
        <div class="tech-collist">
          {#each rows.slice(0, 600) as r}
            <button
              class="tech-row"
              class:tech-row-on={trail[0] == r.id}
              on:click={() => open(r.id, 0)}
            >
              <span class={dot(r.status)} title={STATUS_LABEL[r.status]} />
              <span class="tech-rowname" class:tech-locked={r.status == "lockedOut"}
                >{r.title}</span
              >
              <span
                class="tech-star"
                class:tech-starred={marks.includes(r.id)}
                title={marks.includes(r.id) ? "Remove from to-do" : "Add to to-do"}
                on:click|stopPropagation={() => toggleMark(r.id)}>★</span
              >
            </button>
          {/each}
          {#if rows.length > 600}
            <p class="dmg-hint">…and {rows.length - 600} more. Narrow it with the search.</p>
          {/if}
          {#if !rows.length}
            <p class="dmg-hint">Nothing here.</p>
          {/if}
        </div>
      </div>

      <!-- One column per step of the trail. -->
      {#each cards as card, i}
        {#if card.info}
          <div class="tech-col tech-detail">
            <header class="tech-colhead">
              <span class={dot(card.info.status)} />
              {card.info.title}
              <button
                class="dmg-mini tech-starbtn"
                class:tech-starred={marks.includes(card.id)}
                title="Add to the to-do list"
                on:click={() => toggleMark(card.id)}>★</button
              >
              <button
                class="dmg-mini"
                title="Open the XPedia article over the top - your columns stay exactly as they are"
                on:click={() => peek(card.id)}>▤</button
              >
            </header>
            <div class="tech-collist">
              <p class="dmg-cap">
                {STATUS_LABEL[card.info.status]}
                {#if card.info.remaining > 0}
                  · {card.info.remaining} left of {card.info.cost}
                  · {card.info.days == null ? "—" : card.info.days + " day" + (card.info.days == 1 ? "" : "s")}
                {/if}
              </p>

              {#if card.info.missing.length}
                <div class="tech-group">
                  <!-- The in-game tech tree calls this "Depends On"; match it
                       so the two read the same way. Only the UNMET ones are
                       listed - see missingFor. -->
                  <h5>Depends on</h5>
                  {#each card.info.missing as m}
                    <button class="tech-row" on:click={() => open(m, i + 1)}>
                      <span class={dot(statusOf(m, saveState))} />
                      <span class="tech-rowname">{rul.tr(m)}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              {#if card.info.lockedBy.length}
                <div class="tech-group">
                  <h5>Ruled out by</h5>
                  <p class="dmg-warn">
                    ⚠ A choice already made closed this off for the rest of the campaign.
                  </p>
                  {#each card.info.lockedBy as d}
                    <button class="tech-row" on:click={() => open(d, i + 1)}>
                      <span class={dot(statusOf(d, saveState))} />
                      <span class="tech-rowname">{rul.tr(d)}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              {#if card.info.status == "needsItem"}
                <p class="dmg-warn">
                  ⚠ Research is clear — you just need one <b>{card.info.title}</b> in stores.
                </p>
              {/if}

              {#if card.opens.research.length}
                <div class="tech-group">
                  <h5>Leads to</h5>
                  {#each card.opens.research as u}
                    <button class="tech-row" on:click={() => open(u, i + 1)}>
                      <span class={dot(statusOf(u, saveState))} />
                      <span class="tech-rowname">{rul.tr(u)}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              {#if card.info.getOneFree.length}
                <div class="tech-group">
                  <h5 title="Researching this grants ONE of these at random.">Gives one of</h5>
                  {#each card.info.getOneFree as u}
                    <button class="tech-row" on:click={() => open(u, i + 1)}>
                      <span class={dot(statusOf(u, saveState))} />
                      <span class="tech-rowname">{rul.tr(u)}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              {#if card.opens.manufacture.length || card.opens.buy.length || card.opens.item}
                <div class="tech-group">
                  <h5>Opens up</h5>
                  {#if card.opens.item}
                    <p class="dmg-cap">Gives you a {rul.tr(card.opens.item)}</p>
                  {/if}
                  {#each card.opens.manufacture as m}
                    <p class="dmg-cap">Manufacture: {rul.tr(m)}</p>
                  {/each}
                  {#each card.opens.buy.slice(0, 12) as b}
                    <p class="dmg-cap">Buy: {rul.tr(b)}</p>
                  {/each}
                </div>
              {/if}

              {#if card.info.caveats.length}
                <div class="tech-group tech-caveats">
                  <h5>Also</h5>
                  {#each card.info.caveats as c}<p class="dmg-hint">{c}</p>{/each}
                </div>
              {/if}

              <button class="dmg-mini" on:click={() => (goal = card.id)}>Path to this</button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<ArticlePeek bind:id={peekId} />
