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
  import {
    searchGoals,
    goalPlan,
    KIND_LABEL,
    KIND_ORDER,
    GROUP_LABEL,
    GROUP_HINT,
  } from "./techGoal";
  import { loadSalvageIndex } from "./salvage";

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
  /** What was typed into "What do you want to unlock?". */
  let goalQuery = "";
  /** The id actually picked from the matches, or "" while still choosing. */
  let goal = "";
  /**
   * Whether the browse list column is stood down for a goal.
   *
   * Picking a goal hides it: the goal column and the trail it opens are the
   * thing you are reading, and leaving the filter list wedged between them puts
   * every topic you click on the far side of a column you were not looking at.
   * Clearing the goal or touching the Show block brings it straight back.
   */
  let listHidden = false;
  let todoSort = "impact";
  /**
   * Bumped when the MCD scan lands, so the goal panel recomputes.
   *
   * The scan is the only thing on this screen that finishes AFTER the render
   * that asked for it - it reads a directory of tileset files - so it needs an
   * explicit nudge rather than falling out of the save or the goal changing.
   */
  let salvageVersion = 0;
  let listSort = "name";
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
    { id: "inProgress", label: "In progress", title: "What the save already has underway, first. Everything else keeps the Status order behind it, so this is the quick \"what am I waiting on\" view." },
    { id: "name", label: "Name", title: "Alphabetical." },
    { id: "added", label: "Added", title: "The order you starred them." },
  ];

  /** 0 for a topic the save already has underway, 1 for everything else. */
  const started = (status) => (status == "inProgress" ? 0 : 1);

  /**
   * Sorts for the first column. Deliberately only two: the column is a place
   * finder, and anything more than "alphabetical" or "what is already running"
   * makes a list you cannot scan for a name.
   */
  const LIST_SORTS = [
    { id: "name", label: "A–Z", title: "Alphabetical." },
    {
      id: "inProgress",
      label: "In progress",
      title: "Topics the save already has underway first, the rest alphabetically behind them - so you can see what is running without leaving the filter you are on.",
    },
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

  /**
   * The colour key: one swatch and one word each.
   *
   * A quick reference, not a tutorial. The long explanation lives in the title
   * attribute, where it costs no space and is there if anyone wants it - the
   * legend itself has to earn its place in a sidebar that already holds the
   * save, the filters, the to-do list and the goal search.
   */
  const LEGEND = [
    ["available", "Available", "Research satisfied and, if it wants one, the item is in stores. Start it today."],
    ["needsItem", "Needs item", "Research is clear. You just do not hold the thing it wants to examine."],
    ["inProgress", "In progress", "Already underway in this save's project list."],
    ["blocked", "Blocked", "Something it depends on is not researched yet."],
    ["done", "Done", "Already researched in this save."],
    ["lockedOut", "Ruled out", "A branching choice you already made closed this off for the rest of the campaign."],
  ];

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
    // Kicked off here rather than when a salvage route first appears: it is a
    // directory listing plus a batch of small reads, it is cached after the
    // first run, and starting it now means the answer is already there by the
    // time anyone types a goal.
    // Bumping the version on failure too: the panel then renders the "no
    // tileset" branch, which is the honest thing to show, instead of sitting on
    // "Reading the tile data…" for the rest of the session.
    loadSalvageIndex().then(
      () => salvageVersion++,
      () => salvageVersion++
    );
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
      // Asked for, so it outranks the per-filter orders below.
      if (listSort == "inProgress") {
        const d = started(a.status) - started(b.status);
        if (d) return d;
      }
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
    if (todoSort == "inProgress")
      // Started topics first; the rest fall back to the Status order rather
      // than to one undifferentiated blob.
      return items.sort(
        (a, b) =>
          started(a.status) - started(b.status) ||
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          byName(a, b)
      );
    return items.sort((a, b) => b.impact.score - a.impact.score || byName(a, b));
  })();

  /** Detail for every topic in the trail, recomputed when the save changes. */
  $: cards = trail.map((id) => ({
    id,
    info: topicInfo(id, saveState),
    opens: opensUp(id),
  }));

  /**
   * Matches for the goal box, grouped by what kind of thing they are.
   *
   * Grouped rather than one flat list because a query like "laser" hits the
   * research topic, nine guns and four manufacture projects, and which of those
   * you meant is exactly the thing the flat list hides. Asked for explicitly:
   * items are not to be jumbled in with the research.
   */
  $: goalMatches = goal ? [] : searchGoals(goalQuery);
  $: goalGroups = KIND_ORDER.map((k) => ({
    kind: k,
    label: KIND_LABEL[k],
    rows: goalMatches.filter((m) => m.kind == k),
  })).filter((g) => g.rows.length);

  /**
   * The picked target, everything worked out. Null until something is picked.
   *
   * salvageVersion is a real dependency, not decoration: a salvage route reads
   * the tileset table, which arrives asynchronously.
   */
  const makePlan = (id, save, _salvageVersion) => (id ? goalPlan(id, save) : null);
  $: plan = makePlan(goal, saveState, salvageVersion);

  /**
   * Pick `id` as the goal and stop showing matches.
   *
   * The query is set to the title rather than cleared so the box still reads as
   * what you asked for.
   */
  function pickGoal(id) {
    goal = id;
    goalQuery = rul.tr(id, { icon: "none", notip: true });
    listHidden = true;
  }

  function clearGoal() {
    goal = "";
    goalQuery = "";
    listHidden = false;
    expandedVia = new Set();
  }

  /**
   * How many entries a route lists before it offers to show the rest.
   *
   * Long enough to answer "roughly where" at a glance, short enough that a gun
   * dropping on 77 deployments does not push the shop and the loot table off
   * the bottom of the column.
   */
  const VIA_LIMIT = 15;

  /** Routes whose full list the reader has asked for, by goal and position. */
  let expandedVia = new Set();

  const viaKey = (id, i, part = "") => id + ":" + i + ":" + part;

  function toggleVia(key) {
    if (expandedVia.has(key)) expandedVia.delete(key);
    else expandedVia.add(key);
    expandedVia = expandedVia; // Svelte tracks assignment, not mutation.
  }

  /**
   * `list` cut to the limit unless `key` has been expanded.
   *
   * The expanded set is passed in rather than closed over: Svelte invalidates a
   * template expression from the variables it can SEE in it, so a helper that
   * read `expandedVia` internally left the list frozen at 15 while the button
   * next to it happily toggled its own label.
   */
  const capped = (list, key, expanded) =>
    expanded.has(key) ? list : list.slice(0, VIA_LIMIT);

  /** The three things a salvage route names, in the order they are useful. */
  const SALVAGE_PARTS = [
    ["crafts", "Shoot down:"],
    ["missions", "Missions:"],
    ["terrains", "Terrains:"],
  ];

  /**
   * Bring the browse list back.
   *
   * Touching anything in the Show block says you want the list again, so the
   * filter chips and the topic search both call this rather than leaving you
   * pressing buttons that change a column you cannot see.
   */
  function useList() {
    listHidden = false;
  }

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

      <!-- Two wrapped lines, no header, no toggle, no prose. Hover any entry
           for the full description. -->
      <section class="dmg-block tech-legendblock">
        <ul class="tech-legend">
          {#each LEGEND as [status, name, what]}
            <li title={what}>
              <span class={dot(status)} />{name}
            </li>
          {/each}
        </ul>
      </section>

      <section class="dmg-block" class:tech-standby={listHidden}>
        <header>Show</header>
        <div class="dmg-chips">
          {#each FILTERS as f}
            <button
              class="dmg-chip"
              class:dmg-chip-on={filter == f.id && !listHidden}
              title={f.title}
              on:click={() => {
                filter = f.id;
                useList();
              }}
            >
              {f.label}
              <span class="dmg-chip-n">{counts[f.id] ?? 0}</span>
            </button>
          {/each}
        </div>
        <input
          class="dmg-input"
          placeholder="Search topics…"
          bind:value={search}
          on:input={useList}
        />
        {#if listHidden}
          <p class="dmg-hint">
            Standing by while you follow a goal. Press a filter to bring the list back.
          </p>
        {/if}
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
        <header
          title="Name anything in the pedia - a gun, a part, a facility, a research topic - and get the route to it. Not just research: if the only way to a thing is a shop, a mission or a random event, that is what it says."
        >
          Path to a goal
        </header>
        <input
          class="dmg-input"
          placeholder="What do you want to unlock?"
          bind:value={goalQuery}
          on:input={() => (goal = "")}
        />
        {#if goal}
          <button class="dmg-mini" on:click={clearGoal}>✕ clear</button>
        {:else if goalQuery.trim().length < 2}
          <p class="dmg-hint">
            Try a name rather than an id — “laspistol”, “laser weapons”, “necroplane
            parts”.
          </p>
        {:else if !goalMatches.length}
          <p class="dmg-hint">Nothing in the pedia matches that.</p>
        {:else}
          <!-- Grouped, because "which of these nine lasers did you mean" is the
               whole question and a flat list is exactly what hides it. -->
          {#each goalGroups as g}
            <h5 class="tech-goalgroup">{g.label}</h5>
            {#each g.rows as m}
              <button class="tech-row" on:click={() => pickGoal(m.id)}>
                {#if m.kind == "research"}
                  <span class={dot(statusOf(m.id, saveState))} title={STATUS_LABEL[statusOf(m.id, saveState)]} />
                {/if}
                <span class="tech-rowname">{m.title}</span>
              </button>
            {/each}
          {/each}
        {/if}
      </section>
    </aside>

    <div class="tech-cols">
      <!-- The goal, when one is picked. Its own column rather than a cramped
           block in the side panel: it carries a route list, a research order
           and a pile of mission names, and it is the answer you came for. -->
      {#if plan}
        <div class="tech-col tech-goalcol">
          <header class="tech-colhead">
            {#if plan.status}
              <span class={dot(plan.status)} title={STATUS_LABEL[plan.status]} />
            {/if}
            <span class="tech-rowname">{plan.title}</span>
            <button
              class="dmg-mini"
              title="Open the XPedia article over the top"
              on:click={() => peek(plan.id)}>▤</button
            >
            <button class="dmg-mini" title="Clear the goal" on:click={clearGoal}>✕</button>
          </header>
          <div class="tech-collist">
            <p class="dmg-cap">{KIND_LABEL[plan.kind]}</p>

            {#if plan.note}
              <p class="dmg-hint tech-goalnote">{plan.note}</p>
            {/if}

            {#if plan.prereq.length}
              <div class="tech-group">
                <h5 title="Research the thing itself declares, whichever way you come by it.">
                  Research required
                </h5>
                {#each plan.prereq as r}
                  <button class="tech-row" on:click={() => open(r, 0)}>
                    <span class={dot(statusOf(r, saveState))} title={STATUS_LABEL[statusOf(r, saveState)]} />
                    <span class="tech-rowname">{rul.tr(r)}</span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if plan.best}
              <div class="tech-group">
                <h5
                  title="The shortest route that has research in it, and everything still missing along it, in an order you could actually take them in."
                >
                  Research path — {plan.best.path.length} to go
                </h5>
                <p class="dmg-cap">via {GROUP_LABEL[plan.best.group].toLowerCase()}: {plan.best.label}</p>
                {#if !plan.best.path.length}
                  <p class="dmg-hint">Nothing left — this route is open.</p>
                {:else}
                  <ol class="dmg-goalpath">
                    {#each plan.best.path as id}
                      <li>
                        <span class={dot(statusOf(id, saveState))} title={STATUS_LABEL[statusOf(id, saveState)]} />
                        <button class="dmg-linkish" on:click={() => open(id, 0)}>{rul.tr(id)}</button>
                      </li>
                    {/each}
                  </ol>
                {/if}
              </div>
            {/if}

            <!-- Every route, kept apart from the research path above on
                 purpose: they are alternatives, not steps, and merging them
                 would invent a path nobody has to walk. -->
            {#if plan.routes.length}
              <div class="tech-group">
                <h5>How to get it</h5>
                {#each plan.routes as r, ri}
                  <div class="tech-route" class:tech-route-open={r.open}>
                    <div class="tech-routehead" title={GROUP_HINT[r.group]}>
                      {GROUP_LABEL[r.group]}
                      {#if r.gates.length}
                        <span class="dmg-cap">{r.open ? "open" : r.path.length + " to research"}</span>
                      {/if}
                    </div>
                    <p class="dmg-cap">{r.label}</p>
                    {#each r.gates as g}
                      <button class="tech-row" on:click={() => open(g, 0)}>
                        <span class={dot(statusOf(g, saveState))} title={STATUS_LABEL[statusOf(g, saveState)]} />
                        <span class="tech-rowname">{rul.tr(g)}</span>
                      </button>
                    {/each}
                    {#if r.services.length}
                      <p class="dmg-hint">
                        Needs base services: {r.services.join(", ")} — not checked here.
                      </p>
                    {/if}
                    <!-- Salvage gets the full breakdown: the tileset the game
                         actually recovers it from, and everything built out of
                         that tileset. A bare "recovery type 104" is not an
                         answer to anything. -->
                    {#if r.salvage}
                      {#if !r.salvage.ready}
                        <p class="dmg-hint">Reading the tileset files…</p>
                      {:else if !r.salvage.sets.length}
                        <!-- The label already says there is no tileset; only a
                             real failure (no MCD files at all) needs a line. -->
                        {#if r.salvage.problem}
                          <p class="dmg-hint">{r.salvage.problem}</p>
                        {/if}
                      {:else}
                        <p class="dmg-cap tech-via tech-salvage">
                          Tileset{r.salvage.sets.length == 1 ? "" : "s"}:
                          {r.salvage.sets.map((s) => s.name + " (" + s.tiles + " tile" + (s.tiles == 1 ? "" : "s") + ")").join(", ")}
                        </p>
                        <!-- Same expander as the route lists below: the "+N"
                             used to be dead text, so the rest of a long list
                             was simply unreadable. -->
                        {#each SALVAGE_PARTS as [part, label]}
                          {#if r.salvage[part].length}
                            <p class="dmg-cap tech-via tech-salvage">
                              <b>{label}</b>
                              {capped(r.salvage[part], viaKey(plan.id, ri, part), expandedVia).join(" · ")}
                              {#if r.salvage[part].length > VIA_LIMIT}
                                <button
                                  class="dmg-linkish tech-viamore"
                                  on:click={() => toggleVia(viaKey(plan.id, ri, part))}
                                >
                                  {expandedVia.has(viaKey(plan.id, ri, part))
                                    ? "show fewer"
                                    : "…and " + (r.salvage[part].length - VIA_LIMIT) + " more"}
                                </button>
                              {/if}
                            </p>
                          {/if}
                        {/each}
                        {#if !r.salvage.crafts.length && !r.salvage.terrains.length}
                          <p class="dmg-hint">
                            Nothing in the ruleset builds a map out of that tileset, so it is
                            reachable only through map blocks the pedia does not read.
                          </p>
                        {/if}
                      {/if}
                    {:else}
                      {#each capped(r.via, viaKey(plan.id, ri), expandedVia) as v}
                        <p class="dmg-cap tech-via">{v}</p>
                      {/each}
                      {#if r.via.length > VIA_LIMIT}
                        <button
                          class="dmg-linkish tech-viamore"
                          on:click={() => toggleVia(viaKey(plan.id, ri))}
                        >
                          {expandedVia.has(viaKey(plan.id, ri))
                            ? "show fewer"
                            : "…and " + (r.via.length - VIA_LIMIT) + " more"}
                        </button>
                      {/if}
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Column 0: the list everything starts from.

           Stood down while a goal is open. It is a place finder, and once you
           have a goal you are reading the goal column and the trail it opens;
           leaving the filter list wedged between the two puts every topic you
           click on the far side of a column you were not looking at. -->
      {#if !listHidden}
      <div class="tech-col">
        <header class="tech-colhead">
          {FILTERS.find((f) => f.id == filter).label}
          <span class="dmg-cap">{rows.length}</span>
        </header>
        <!-- Hidden on the In progress filter, where every row qualifies and the
             chips would only be a way to press a button that does nothing. -->
        {#if filter != "progress"}
          <div class="dmg-chips tech-colsort">
            {#each LIST_SORTS as srt}
              <button
                class="dmg-chip"
                class:dmg-chip-on={listSort == srt.id}
                title={srt.title}
                on:click={() => (listSort = srt.id)}>{srt.label}</button
              >
            {/each}
          </div>
        {/if}
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
      {/if}

      <!-- One column per step of the trail. -->
      {#each cards as card, i}
        {#if card.info}
          <div class="tech-col tech-detail">
            <header class="tech-colhead">
              <span class={dot(card.info.status)} title={STATUS_LABEL[card.info.status]} />
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
                      <span class={dot(statusOf(m, saveState))} title={STATUS_LABEL[statusOf(m, saveState)]} />
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
                      <span class={dot(statusOf(d, saveState))} title={STATUS_LABEL[statusOf(d, saveState)]} />
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
                      <span class={dot(statusOf(u, saveState))} title={STATUS_LABEL[statusOf(u, saveState)]} />
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
                      <span class={dot(statusOf(u, saveState))} title={STATUS_LABEL[statusOf(u, saveState)]} />
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

              <button class="dmg-mini" on:click={() => pickGoal(card.id)}>Path to this</button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<ArticlePeek bind:id={peekId} />
