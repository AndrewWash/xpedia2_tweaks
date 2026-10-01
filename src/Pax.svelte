<script>
  /**
   * PAX - the personnel manager.
   *
   * Dwarf Therapist for pirates: every soldier on one grid, every stat a cell
   * shaded by how it ranks in the crew, and roles - weighted blends of stats -
   * scored per soldier so the question "who carries the rifle" is a sort, not
   * twenty trips through the soldier screen.
   *
   * The arithmetic lives in pax.ts, which knows nothing about the UI.
   */
  import { rul } from "./Ruleset";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import ArticlePeek from "./ArticlePeek.svelte";
  import { currentSave, currentSavePath, droppedSaves, setCurrentSave, centcomSoldier } from "./store";
  import { findSaves, stampSaves, sortSaves, loadSave, parseSave } from "./damageSave";
  import { download } from "./exportPedia";
  import {
    PAX_STATS,
    PAX_KEYS,
    STAT_NAME,
    DEFAULT_ROLES,
    EMPTY_FILTER,
    paxRows,
    percentiles,
    roleScores,
    bestRole,
    passes,
    staffSquad,
    loadRoles,
    saveRoles,
    cloneRoles,
    toCsv,
    rankName,
  } from "./pax";

  const SAVE_PREF = "xpediaSave";
  const PREF = "xpediaPax";

  let saveList = [];
  let savePath = "";
  let saveState = null;
  let saveLoading = false;
  let saveError = "";
  let savesRefreshing = false;

  /** Stats | Roles | Career | Squad. */
  let view = "stats";
  /** What a stat cell shows - see STAT_MODES. */
  let statMode = "value";
  /** Grade against the crew by order, or by share of the best. */
  let basis = "rank";
  /** Show stats in the armour they wear, rather than bare. */
  let armored = false;
  let showFallen = false;
  /**
   * Type, rank and where-are-they columns. Worth hiding on a narrow window -
   * they eat a third of the width the stat grid is there for, and the soldier
   * file shows all three anyway.
   */
  let showInfo = true;
  let groupBy = "";
  let sortKey = "rank";
  let sortDir = -1;
  let filter = { ...EMPTY_FILTER, rules: [] };
  let roles = loadRoles();
  let editingRoles = false;
  let slots = [
    { role: "gunner", count: 2 },
    { role: "overwatch", count: 1 },
    { role: "brawler", count: 1 },
    { role: "scout", count: 1 },
    { role: "bomber", count: 1 },
  ];
  /** Fit soldiers only, when staffing a squad. */
  let squadFitOnly = true;
  let selectedId = "";
  let peekId = "";

  const VIEWS = [
    { id: "stats", label: "Stats", title: "Every stat, every soldier. Shading is how the stat ranks in your crew." },
    { id: "roles", label: "Roles", title: "Weighted blends of stats, scored 0-100 against your crew. Edit the weights to match how you play." },
    { id: "career", label: "Career", title: "Service record from each soldier's diary: missions, kills, stuns, shots, wounds, growth." },
    { id: "squad", label: "Squad", title: "Name the slots you want filled; get the best squad from who is fit, with no one used twice." },
  ];

  const STAT_MODES = [
    { id: "value", label: "Value", title: "The stat as they fight: the save's number plus traits and medals." },
    { id: "cap", label: "% of cap", title: "How close the stat is to this soldier type's hard ceiling. 100 means done growing." },
    { id: "gym", label: "Gym room", title: "Points the gym can still add before its training cap. Blank: the gym does not train this stat. ✓: trained out." },
    { id: "growth", label: "Growth", title: "Gained since recruitment: current minus the rookie roll." },
    { id: "left", label: "To cap", title: "Points still to gain before the hard cap, from any source." },
  ];

  const BASES = [
    { id: "rank", label: "vs crew", title: "Shading and role scores by order: 80 means better than 80% of your living crew." },
    { id: "scaled", label: "vs best", title: "Shading and role scores as a share of the best in your crew, so a big lead looks big." },
  ];

  const GROUPS = [
    { id: "", label: "No grouping" },
    { id: "base", label: "Base" },
    { id: "craft", label: "Craft" },
    { id: "type", label: "Soldier type" },
    { id: "rank", label: "Rank" },
    { id: "best", label: "Best role" },
    { id: "status", label: "Status" },
  ];

  /**
   * Career columns. `heat` shades the cell against the best in the column, for
   * the ones where more is plainly better.
   */
  const CAREER = [
    { id: "missions", ab: "Msn", title: "Missions", get: (r) => r.missions, heat: true },
    { id: "kills", ab: "Kill", title: "Kills", get: (r) => r.kills, heat: true },
    { id: "stuns", ab: "Stun", title: "Stuns - captures are money", get: (r) => r.stuns, heat: true },
    { id: "shots", ab: "Shots", title: "Ranged shots fired, career", get: (r) => r.shots },
    {
      id: "hits",
      ab: "Hits",
      title: "Hits landed, career - melee hits and every pellet included, which is why it can beat Shots. Not an accuracy figure.",
      get: (r) => r.hits,
      heat: true,
    },
    { id: "medals", ab: "Med", title: "Commendations", get: (r) => r.medals.length, heat: true },
    { id: "gained", ab: "Gain", title: "Stat points gained in the field", get: (r) => r.gained, heat: true },
    { id: "gainRate", ab: "Gain/msn", title: "Stat points gained per mission. High and young is your future ace.", get: (r) => (r.gainRate == null ? null : Math.round(r.gainRate * 10) / 10), heat: true },
    { id: "timesWounded", ab: "Hurt", title: "Times wounded", get: (r) => r.timesWounded },
    { id: "daysWounded", ab: "Days", title: "Days spent in the infirmary", get: (r) => r.daysWounded },
    { id: "months", ab: "Mths", title: "Months of service", get: (r) => r.months },
  ];

  /* ------------------------------------------------------------ persistence */

  onMount(() => {
    try {
      const p = JSON.parse(localStorage[PREF] || "{}");
      if (VIEWS.some((v) => v.id == p.view)) view = p.view;
      if (STAT_MODES.some((m) => m.id == p.statMode)) statMode = p.statMode;
      if (BASES.some((b) => b.id == p.basis)) basis = p.basis;
      if (GROUPS.some((g) => g.id == p.groupBy)) groupBy = p.groupBy;
      if (typeof p.sortKey == "string") sortKey = p.sortKey;
      if (p.sortDir == 1 || p.sortDir == -1) sortDir = p.sortDir;
      armored = !!p.armored;
      showFallen = !!p.showFallen;
      showInfo = p.showInfo !== false;
      squadFitOnly = p.squadFitOnly !== false;
      if (Array.isArray(p.slots))
        slots = p.slots
          .filter((s) => s && typeof s.role == "string")
          .map((s) => ({ role: s.role, count: Math.max(1, Math.min(12, +s.count || 1)) }));
      if (Array.isArray(p.rules))
        filter.rules = p.rules
          .filter((r) => r && PAX_KEYS.includes(r.k))
          .map((r) => ({ k: r.k, op: r.op == "<=" ? "<=" : ">=", v: +r.v || 0 }));
      if (["all", "fit", "wounded"].includes(p.status)) filter.status = p.status;
    } catch (e) {
      // Defaults are fine.
    }
    prefsLoaded = true;
    adoptSharedSave();
    discoverSaves();
  });

  let prefsLoaded = false;
  $: if (prefsLoaded)
    persist({ view, statMode, basis, groupBy, sortKey, sortDir, armored, showFallen, showInfo, squadFitOnly, slots, rules: filter.rules, status: filter.status });

  function persist(p) {
    try {
      localStorage[PREF] = JSON.stringify(p);
    } catch (e) {
      // Losing view settings is not worth failing over.
    }
  }

  /* ------------------------------------------------------------------ saves */

  /** Take the save CENTCOM or TECH already has - see TechTree.adoptSharedSave. */
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
    if (saveState) return;
    let remembered = "";
    try {
      remembered = localStorage[SAVE_PREF] || "";
    } catch (e) {
      remembered = "";
    }
    if (remembered && saveList.some((x) => x.path == remembered)) pickSave(remembered);
  }

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

  /* ------------------------------------------------------------------ model */

  /**
   * A save parsed before PAX existed - adopted from another tab in a session
   * that predates this build - has no `fallen`. paxRows copes; this just keeps
   * the memorial count honest.
   */
  $: allRows = saveState ? paxRows(saveState, true) : [];
  $: living = allRows.filter((r) => r.status != "fallen");
  $: fallenCount = allRows.length - living.length;
  $: rows = showFallen ? allRows : living;

  $: statOf = (r, k) => (armored ? r.armored[k] : r.stats[k]);
  /** Grades for shading and roles. Always against the living crew. */
  $: grades = percentiles(living, (r, k) => (armored ? r.armored[k] : r.stats[k]), basis, allRows);
  $: scores = roleScores(allRows, roles, grades);
  $: best = new Map(allRows.map((r) => [r.id, bestRole(scores.get(r.id), roles)]));

  $: baseNames = [...new Set(living.map((r) => r.base))].sort();
  $: craftNames = [...new Set(living.map((r) => r.craft).filter(Boolean))].sort();
  $: typeList = [...new Map(allRows.map((r) => [r.type, r.typeName])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));
  $: rankList = [...new Set(allRows.map((r) => r.rank))].sort((a, b) => a - b);
  $: manyBases = baseNames.length > 1;

  // One switch for the whole screen: stat rules test what the grid shows.
  $: filter.armored = armored;
  $: shown = rows.filter((r) => passes(r, filter));
  $: counts = {
    all: rows.length,
    fit: living.filter((r) => r.status == "fit").length,
    wounded: living.filter((r) => r.status == "wounded").length,
  };

  /** Largest value in each Career column and each mode column, for shading. */
  $: careerMax = Object.fromEntries(CAREER.map((c) => [c.id, Math.max(0, ...living.map((r) => +c.get(r) || 0))]));
  $: growthMax = Object.fromEntries(PAX_KEYS.map((k) => [k, Math.max(0, ...living.map((r) => r.raw[k] - r.initial[k]))]));

  /* ----------------------------------------------------------- sort & group */

  function sortValue(r, key) {
    if (key == "name") return r.name.toLowerCase();
    if (key == "type") return r.typeName.toLowerCase();
    if (key == "rank") return r.rank;
    if (key == "where") return (r.craft || "~") + r.base;
    if (key == "status") return r.status == "fallen" ? 9999 : r.recovery;
    if (key == "gym") return r.gymLeft;
    if (key == "best") {
      const b = best.get(r.id);
      return b ? scores.get(r.id)[b.id] : -1;
    }
    if (key.startsWith("stat:")) return cellValue(r, key.slice(5));
    if (key.startsWith("role:")) return scores.get(r.id)[key.slice(5)] ?? -1;
    if (key.startsWith("c:")) {
      const col = CAREER.find((c) => c.id == key.slice(2));
      const v = col ? col.get(r) : null;
      return v == null ? -1 : v;
    }
    return 0;
  }

  /** Click a header: sort by it, high first for numbers; click again to flip. */
  function sortBy(key) {
    if (sortKey == key) sortDir = -sortDir;
    else {
      sortKey = key;
      sortDir = key == "name" || key == "type" || key == "where" ? 1 : -1;
    }
  }

  function arrow(key, sk, sd) {
    return sk == key ? (sd > 0 ? " ▲" : " ▼") : "";
  }

  // Everything sortValue reads is passed in, so Svelte re-sorts when it moves -
  // it tracks what an expression names, not what the functions it calls touch.
  $: sorted = ((list, key, dir, _s, _m, _b, _a, _g) =>
    [...list].sort((a, b) => {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.name < b.name ? -1 : 1;
    }))(shown, sortKey, sortDir, scores, statMode, best, armored, grades);

  function groupOf(r) {
    if (groupBy == "base") return r.base;
    if (groupBy == "craft") return r.craft || "Not on a craft";
    if (groupBy == "type") return r.typeName;
    if (groupBy == "rank") return r.rankName;
    if (groupBy == "status") return r.status == "fallen" ? "Fallen" : r.status == "wounded" ? "Wounded" : "Fit";
    if (groupBy == "best") {
      const b = best.get(r.id);
      return b ? b.name : "—";
    }
    return "";
  }

  /** Groups in first-seen order of the sorted list, so the sort still leads. */
  $: groups = ((list, _g, _b) => {
    if (!groupBy) return [{ name: "", rows: list }];
    const map = new Map();
    for (const r of list) {
      const g = groupOf(r);
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(r);
    }
    return [...map.entries()].map(([name, rows]) => ({ name, rows }));
  })(sorted, groupBy, best);

  /* ------------------------------------------------------------------ cells */

  /** The number a stat cell shows in the current mode, or null for blank. */
  function cellValue(r, k) {
    const raw = r.raw[k];
    if (statMode == "cap") return r.cap[k] > 0 ? Math.min(100, Math.round((100 * raw) / r.cap[k])) : null;
    if (statMode == "gym") return r.train[k] > 0 ? Math.max(0, r.train[k] - raw) : null;
    if (statMode == "growth") return raw - r.initial[k];
    if (statMode == "left") return r.cap[k] > 0 ? Math.max(0, r.cap[k] - raw) : null;
    return statOf(r, k);
  }

  /** 0..1 shading for a stat cell, in five steps so the legend means something. */
  function cellHeat(r, k) {
    let t = 0;
    if (statMode == "value") t = (grades.get(r.id) || {})[k] / 100;
    else if (statMode == "cap") t = r.cap[k] > 0 ? r.raw[k] / r.cap[k] : 0;
    else if (statMode == "gym") t = r.train[k] > 0 ? Math.max(0, r.train[k] - r.raw[k]) / 30 : 0;
    else if (statMode == "growth") t = growthMax[k] > 0 ? (r.raw[k] - r.initial[k]) / growthMax[k] : 0;
    else if (statMode == "left") t = r.cap[k] > 0 ? Math.max(0, r.cap[k] - r.raw[k]) / r.cap[k] : 0;
    return step(t);
  }

  function step(t) {
    if (!(t > 0)) return 0;
    return Math.min(5, Math.ceil(Math.min(1, t) * 5));
  }

  function cellText(r, k) {
    const v = cellValue(r, k);
    if (v == null) return "";
    if (statMode == "gym" && v == 0) return "✓";
    if (statMode == "growth" && v > 0) return "+" + v;
    return String(v);
  }

  /** The full story of one stat, for its tooltip. */
  function statTip(r, k) {
    const parts = [STAT_NAME[k] + " " + r.stats[k]];
    if (r.armored[k] != r.stats[k]) parts.push("in armour " + r.armored[k]);
    if (r.stats[k] != r.raw[k]) parts.push("save " + r.raw[k] + " + traits/medals " + (r.stats[k] - r.raw[k]));
    parts.push("rookie roll " + r.initial[k] + " (" + signed(r.raw[k] - r.initial[k]) + ")");
    if (r.train[k] > 0)
      parts.push(
        r.raw[k] >= r.train[k]
          ? "gym cap " + r.train[k] + " - trained out"
          : "gym cap " + r.train[k] + " - " + (r.train[k] - r.raw[k]) + " left"
      );
    else parts.push("gym does not train it");
    if (r.cap[k] > 0) parts.push("hard cap " + r.cap[k] + (r.raw[k] >= r.cap[k] ? " - MAXED" : ""));
    const g = (grades.get(r.id) || {})[k];
    if (g != null)
      parts.push(basis == "rank" ? "better than " + Math.round(g) + "% of the crew" : Math.round(g) + "% of the crew's best");
    return parts.join("\n");
  }

  function signed(n) {
    return n > 0 ? "+" + n : String(n);
  }

  function roleTip(role) {
    const w = Object.entries(role.weights)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => STAT_NAME[k] + " ×" + n)
      .join(", ");
    return role.name + (role.note ? " - " + role.note : "") + "\n" + (w || "No weights yet");
  }

  function statusText(r) {
    if (r.status == "fallen") return "KIA";
    if (r.status == "wounded") return "✚ " + r.recovery + "d";
    return "fit";
  }

  function statusTip(r) {
    const bits = [];
    if (r.status == "wounded") bits.push("Wounded: " + r.recovery + " days to fit");
    if (r.status == "fallen") bits.push("Killed in action");
    if (r.status != "fallen") bits.push("Freshness " + Math.round(r.fresh * 100) + "%");
    return bits.join("\n");
  }

  /* ---------------------------------------------------------------- filters */

  function addRule() {
    filter.rules = [...filter.rules, { k: "firing", op: ">=", v: 60 }];
  }

  function dropRule(i) {
    filter.rules = filter.rules.filter((_, j) => j != i);
  }

  function clearFilter() {
    filter = { ...EMPTY_FILTER, rules: [] };
  }

  $: filtering = !!(
    filter.text ||
    filter.status != "all" ||
    filter.base ||
    filter.craft ||
    filter.type ||
    filter.rank >= 0 ||
    filter.rules.length
  );

  /* ------------------------------------------------------------------ roles */

  function commitRoles() {
    roles = roles;
    saveRoles(roles);
  }

  function setWeight(role, k, v) {
    const n = Math.max(0, Math.min(5, Math.round(+v || 0)));
    if (n) role.weights[k] = n;
    else delete role.weights[k];
    commitRoles();
  }

  function addRole() {
    roles = [...roles, { id: "r" + Date.now().toString(36), name: "New role", weights: { firing: 1 }, note: "" }];
    commitRoles();
  }

  function dropRole(id) {
    roles = roles.filter((r) => r.id != id);
    slots = slots.filter((s) => s.role != id);
    commitRoles();
  }

  function resetRoles() {
    roles = cloneRoles(DEFAULT_ROLES);
    commitRoles();
  }

  /* ------------------------------------------------------------------ squad */

  $: roleById = new Map(roles.map((r) => [r.id, r]));
  $: liveSlots = slots.filter((s) => roleById.has(s.role) && s.count > 0);
  /** Candidates: whoever the sidebar filters let through, never the fallen. */
  $: candidates = shown.filter((r) => r.status != "fallen" && (!squadFitOnly || r.status == "fit"));
  $: squad = staffSquad(candidates, liveSlots, scores);
  $: seatCount = liveSlots.reduce((a, s) => a + s.count, 0);
  $: squadTotal = squad.length ? squad.reduce((a, p) => a + p.score, 0) / squad.length : 0;
  $: benched = candidates.filter((c) => !squad.some((p) => p.row.id == c.id));

  /** Best benched soldier for a role, for "who is next in line". */
  function nextFor(roleId, bench) {
    let top = null;
    for (const r of bench) {
      const s = scores.get(r.id)[roleId];
      if (s != null && (!top || s > top.s)) top = { r, s };
    }
    return top;
  }

  function addSlot() {
    const used = new Set(slots.map((s) => s.role));
    const role = roles.find((r) => !used.has(r.id)) || roles[0];
    if (role) slots = [...slots, { role: role.id, count: 1 }];
  }

  function dropSlot(i) {
    slots = slots.filter((_, j) => j != i);
  }

  /* ----------------------------------------------------------------- detail */

  $: selected = allRows.find((r) => r.id == selectedId) || null;
  $: selectedRoles = selected
    ? roles
        .map((role) => ({ role, s: scores.get(selected.id)[role.id] }))
        .filter((x) => x.s != null)
        .sort((a, b) => b.s - a.s)
    : [];

  function select(r) {
    selectedId = selectedId == r.id ? "" : r.id;
  }

  function openInCentcom(r) {
    centcomSoldier.set(r.id);
    window.location.hash = "##DAMAGE";
  }

  /** A stat bar's geometry, as percentages of the widest of cap and value. */
  function bar(r, k) {
    const top = Math.max(r.cap[k] || 0, r.stats[k], r.armored[k], 1);
    const pc = (v) => Math.max(0, Math.min(100, (100 * v) / top));
    return {
      now: pc(r.stats[k]),
      start: pc(r.initial[k]),
      gym: r.train[k] > 0 ? pc(r.train[k]) : null,
      maxed: r.cap[k] > 0 && r.raw[k] >= r.cap[k],
    };
  }

  /* -------------------------------------------------------------------- csv */

  function exportCsv() {
    const header = ["Name", "Type", "Rank", "Base", "Craft", "Status", "Armour"];
    for (const s of PAX_STATS) header.push(s.name);
    for (const role of roles) header.push(role.name);
    header.push("Best role");
    for (const c of CAREER) header.push(c.title.split(" - ")[0]);
    const body = sorted.map((r) => {
      const b = best.get(r.id);
      return [
        r.name,
        r.typeName,
        r.rankName,
        r.base,
        r.craft,
        r.status == "wounded" ? "wounded " + r.recovery + "d" : r.status,
        r.armorName,
        ...PAX_KEYS.map((k) => statOf(r, k)),
        ...roles.map((role) => {
          const s = scores.get(r.id)[role.id];
          return s == null ? "" : Math.round(s);
        }),
        b ? b.name : "",
        ...CAREER.map((c) => {
          const v = c.get(r);
          return v == null ? "" : v;
        }),
      ];
    });
    const name = ((saveState && saveState.name) || "crew").replace(/[^\w\- ]+/g, "").trim() || "crew";
    download(name + " - pax.csv", toCsv(header, body));
  }

  const strip = (s) => String(s || "").replace(/<[^>]*>/g, "");
</script>

<div class="dmg-root">
  <div class="dmg-toolbar">
    <span class="dmg-note">
      The whole crew on one screen. Hover any cell for the full story; click a soldier for
      their file.
    </span>
  </div>

  <div class="dmg-body pax-body">
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
            title="Rescan for saved games and re-read the selected one - picks up a game you just saved, no page reload needed."
            disabled={savesRefreshing}
            on:click={refreshSaves}>⭯</button
          >
        </header>
        {#if !saveList.length}
          <p class="dmg-cap">No saved games found. Drop a <code>.sav</code> on this panel, or open one below.</p>
        {:else}
          <select
            class="dmg-input"
            title="Whose crew to show"
            value={savePath}
            on:change={(e) => pickSave(e.target.value)}
          >
            <option value="">(pick a save)</option>
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
            {strip(saveState.name) || "save"}{#if saveState.date}&nbsp;· {saveState.date}{/if}<br />
            <b>{living.length}</b> crew · {counts.fit} fit · {counts.wounded} wounded{#if fallenCount}
              · {fallenCount} fallen{/if}
          </p>
        {/if}
      </section>

      {#if saveState}
        <section class="dmg-block">
          <header>
            Filter
            {#if filtering}
              <button class="dmg-mini" title="Show everyone again" on:click={clearFilter}>clear</button>
            {/if}
          </header>
          <input class="dmg-input" placeholder="Name…" bind:value={filter.text} />
          <div class="dmg-chips">
            {#each [["all", "All"], ["fit", "Fit"], ["wounded", "Wounded"]] as [id, label]}
              <button
                class="dmg-chip"
                class:dmg-chip-on={filter.status == id}
                on:click={() => (filter.status = id)}
              >
                {label} <span class="dmg-chip-n">{counts[id]}</span>
              </button>
            {/each}
          </div>
          {#if manyBases}
            <select class="dmg-input" bind:value={filter.base}>
              <option value="">Any base</option>
              {#each baseNames as b}<option value={b}>{b}</option>{/each}
            </select>
          {/if}
          <select class="dmg-input" bind:value={filter.craft}>
            <option value="">Aboard anything or nothing</option>
            <option value="-">Not on a craft</option>
            {#each craftNames as c}<option value={c}>On {c}</option>{/each}
          </select>
          <select class="dmg-input" bind:value={filter.type}>
            <option value="">Any type</option>
            {#each typeList as [id, name]}<option value={id}>{name}</option>{/each}
          </select>
          <select class="dmg-input" bind:value={filter.rank}>
            <option value={-1}>Any rank</option>
            <!-- Named by the plain soldier's ladder; other types call the same
                 step something else, which the grid's Rank column shows. -->
            {#each rankList as n}<option value={n}>{rankName("STR_SOLDIER", n)} (rank {n})</option>{/each}
          </select>

          <div class="pax-rules">
            {#each filter.rules as rule, i}
              <div class="pax-rule">
                <select class="dmg-input" bind:value={rule.k}>
                  {#each PAX_STATS as s}<option value={s.k}>{s.name}</option>{/each}
                </select>
                <select class="dmg-input pax-op" bind:value={rule.op}>
                  <option value=">=">≥</option>
                  <option value="<=">≤</option>
                </select>
                <input class="dmg-input pax-num" type="number" bind:value={rule.v} />
                <button class="dmg-mini" title="Remove this rule" on:click={() => dropRule(i)}>✕</button>
              </div>
            {/each}
            <button
              class="dmg-mini dmg-wide"
              title="Like the in-game soldier filter, but stackable: Firing ≥ 70 AND Reactions ≥ 60"
              on:click={addRule}>+ stat rule</button
            >
          </div>
          <label class="pax-check" title="Test stat rules, show stats, and grade the crew in the armour each soldier has on, rather than bare.">
            <input type="checkbox" bind:checked={armored} /> In their armour
          </label>
          <label class="pax-check" title="Add the fallen from the memorial, greyed out. They are graded against the living and never staffed into a squad.">
            <input type="checkbox" bind:checked={showFallen} /> Show the fallen
          </label>
        </section>

        <section class="dmg-block">
          <header>Group</header>
          <select class="dmg-input" bind:value={groupBy}>
            {#each GROUPS as g}<option value={g.id}>{g.label}</option>{/each}
          </select>
        </section>
      {/if}
    </aside>

    <div class="pax-main">
      {#if !saveState}
        <div class="pax-empty">
          <h3>PAX — personnel</h3>
          <p>Pick a save on the left, or drop a <code>.sav</code> on the Campaign panel.</p>
          <p class="dmg-hint">
            PAX reads your crew straight out of the save: every stat, every diary, every
            medal. Nothing is written back.
          </p>
        </div>
      {:else}
        <div class="pax-bar">
          <div class="dmg-chips pax-tabs">
            {#each VIEWS as v}
              <button class="dmg-chip" class:dmg-chip-on={view == v.id} title={v.title} on:click={() => (view = v.id)}>
                {v.label}
              </button>
            {/each}
          </div>
          {#if view == "stats"}
            <div class="dmg-chips">
              {#each STAT_MODES as m}
                <button class="dmg-chip" class:dmg-chip-on={statMode == m.id} title={m.title} on:click={() => (statMode = m.id)}>
                  {m.label}
                </button>
              {/each}
            </div>
          {/if}
          {#if view == "stats" || view == "roles" || view == "squad"}
            <div class="dmg-chips">
              {#each BASES as b}
                <button class="dmg-chip" class:dmg-chip-on={basis == b.id} title={b.title} on:click={() => (basis = b.id)}>
                  {b.label}
                </button>
              {/each}
            </div>
          {/if}
          <span class="pax-stretch" />
          {#if view != "squad"}
            <button
              class="dmg-chip"
              class:dmg-chip-on={showInfo}
              title="Show the Type, Rank and Where columns. Hide them to give the grid more room - the soldier file still has all three."
              on:click={() => (showInfo = !showInfo)}>Type · Rank · Where</button
            >
          {/if}
          <span class="dmg-cap">{shown.length} of {rows.length}</span>
          <button class="dmg-mini" title="Download what is on screen - every stat, role and career column - as a spreadsheet" on:click={exportCsv}>CSV</button>
        </div>

        {#if view != "squad"}
          <div class="pax-legend" aria-hidden="true">
            <span>low</span>
            {#each [1, 2, 3, 4, 5] as h}<span class="pax-swatch pax-h{h}" />{/each}
            <span>high</span>
            <span class="dmg-cap">
              {#if view == "stats" && statMode == "value"}
                shading: {basis == "rank" ? "rank in crew" : "share of crew best"}
              {:else if view == "stats" && statMode == "cap"}
                shading: how close to the hard cap
              {:else if view == "stats" && statMode == "gym"}
                shading: gym room left (30+ is full)
              {:else if view == "stats" && statMode == "growth"}
                shading: share of the crew's biggest gain
              {:else if view == "stats"}
                shading: share of the cap still to gain
              {:else if view == "roles"}
                role score 0–100, {basis == "rank" ? "by rank in crew" : "by share of crew best"}
              {:else}
                shading: share of the crew's best
              {/if}
            </span>
          </div>
        {/if}

        {#if view == "roles"}
          <div class="pax-roleedit">
            <button class="dmg-mini" on:click={() => (editingRoles = !editingRoles)}>
              {editingRoles ? "Done editing roles" : "Edit roles…"}
            </button>
            {#if editingRoles}
              <span class="dmg-cap">
                Weights 0–5. A role's score is the weighted average of the soldier's grades.
              </span>
              <table class="pax-weights">
                <thead>
                  <tr>
                    <th>Role</th>
                    {#each PAX_STATS as s}<th title={s.name}>{s.ab}</th>{/each}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {#each roles as role (role.id)}
                    <tr>
                      <td>
                        <input class="dmg-input pax-rolename" bind:value={role.name} on:change={commitRoles} />
                      </td>
                      {#each PAX_KEYS as k}
                        <td>
                          <input
                            class="dmg-input pax-w"
                            class:pax-w-on={role.weights[k]}
                            type="number"
                            min="0"
                            max="5"
                            value={role.weights[k] || 0}
                            on:change={(e) => setWeight(role, k, e.target.value)}
                          />
                        </td>
                      {/each}
                      <td><button class="dmg-mini" title="Delete this role" on:click={() => dropRole(role.id)}>✕</button></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <div class="dmg-chips">
                <button class="dmg-mini" on:click={addRole}>+ role</button>
                <button class="dmg-mini" title="Throw away your edits and go back to the nine starting roles" on:click={resetRoles}>Reset to defaults</button>
              </div>
            {/if}
          </div>
        {/if}

        {#if view == "squad"}
          <div class="pax-squad">
            <section class="pax-slots">
              <h4>Slots to fill</h4>
              {#each slots as slot, i}
                <div class="pax-slot">
                  <input class="dmg-input pax-num" type="number" min="1" max="12" bind:value={slot.count} />
                  ×
                  <select class="dmg-input" bind:value={slot.role}>
                    {#each roles as role}<option value={role.id}>{role.name}</option>{/each}
                  </select>
                  <button class="dmg-mini" on:click={() => dropSlot(i)}>✕</button>
                </div>
              {/each}
              <button class="dmg-mini dmg-wide" on:click={addSlot}>+ slot</button>
              <label class="pax-check">
                <input type="checkbox" bind:checked={squadFitOnly} /> Fit for duty only
              </label>
              <p class="dmg-hint">
                Picks from the {candidates.length} soldiers the filter on the left lets through{squadFitOnly ? " who are fit" : ""}.
                Solved exactly: the highest total score with no one used twice, so your best
                all-rounder is not burned on a slot someone else could fill.
              </p>
            </section>

            <section class="pax-picks">
              {#if !seatCount}
                <p class="dmg-hint">Add a slot to staff a squad.</p>
              {:else if !squad.length}
                <p class="dmg-warn">Nobody to pick from - loosen the filter.</p>
              {:else}
                <table class="pax-grid">
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th class="pax-name">Soldier</th>
                      <th>Score</th>
                      <th>Why</th>
                      <th>Next in line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each squad as pick}
                      {@const role = roleById.get(pick.role)}
                      {@const next = nextFor(pick.role, benched)}
                      <tr class:pax-on={selectedId == pick.row.id} on:click={() => select(pick.row)}>
                        <td title={roleTip(role)}>{role.name}</td>
                        <td class="pax-name">{pick.row.name} <span class="dmg-cap">{pick.row.typeName}</span></td>
                        <td class="pax-cell pax-h{step(pick.score / 100)}">{Math.round(pick.score)}</td>
                        <td class="dmg-cap">
                          {Object.keys(role.weights)
                            .sort((a, b) => role.weights[b] - role.weights[a])
                            .slice(0, 3)
                            .map((k) => PAX_STATS.find((s) => s.k == k).ab + " " + statOf(pick.row, k))
                            .join(" · ")}
                        </td>
                        <td class="dmg-cap">
                          {#if next}{next.r.name} ({Math.round(next.s)}){:else}—{/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                <p class="dmg-cap">
                  {squad.length} of {seatCount} slots filled · average score <b>{Math.round(squadTotal)}</b>
                  {#if squad.length < seatCount}
                    · <span class="dmg-warn">not enough soldiers for every slot</span>
                  {/if}
                </p>
              {/if}
            </section>
          </div>
        {:else}
          <div class="pax-scroll">
            <table class="pax-grid">
              <thead>
                <tr>
                  <th class="pax-name pax-sort" on:click={() => sortBy("name")}>Name{arrow("name", sortKey, sortDir)}</th>
                  {#if showInfo}
                    <th class="pax-sort" on:click={() => sortBy("type")}>Type{arrow("type", sortKey, sortDir)}</th>
                    <th class="pax-sort" on:click={() => sortBy("rank")}>Rank{arrow("rank", sortKey, sortDir)}</th>
                    <th class="pax-sort" title="Craft, else base" on:click={() => sortBy("where")}>Where{arrow("where", sortKey, sortDir)}</th>
                  {/if}
                  <th class="pax-sort" title="Days to fit" on:click={() => sortBy("status")}>Status{arrow("status", sortKey, sortDir)}</th>
                  {#if view == "stats"}
                    {#each PAX_STATS as s}
                      <th class="pax-sort pax-numh" title={s.name} on:click={() => sortBy("stat:" + s.k)}>
                        {s.ab}{arrow("stat:" + s.k, sortKey, sortDir)}
                      </th>
                    {/each}
                    <th class="pax-sort pax-numh" title="Stat points the gym can still add, all stats" on:click={() => sortBy("gym")}>
                      Gym{arrow("gym", sortKey, sortDir)}
                    </th>
                    <th class="pax-sort" title="Highest-scoring role" on:click={() => sortBy("best")}>Best role{arrow("best", sortKey, sortDir)}</th>
                  {:else if view == "roles"}
                    {#each roles as role (role.id)}
                      <th class="pax-sort pax-numh" title={roleTip(role)} on:click={() => sortBy("role:" + role.id)}>
                        {role.name}{arrow("role:" + role.id, sortKey, sortDir)}
                      </th>
                    {/each}
                  {:else}
                    {#each CAREER as c}
                      <th class="pax-sort pax-numh" title={c.title} on:click={() => sortBy("c:" + c.id)}>
                        {c.ab}{arrow("c:" + c.id, sortKey, sortDir)}
                      </th>
                    {/each}
                    <th title="Weapon with the most kills and stuns">Favourite</th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each groups as g}
                  {#if g.name}
                    <tr class="pax-group">
                      <td colspan="99">{g.name} <span class="dmg-cap">{g.rows.length}</span></td>
                    </tr>
                  {/if}
                  {#each g.rows as r (r.id)}
                    <tr
                      class:pax-on={selectedId == r.id}
                      class:pax-fallen={r.status == "fallen"}
                      on:click={() => select(r)}
                    >
                      <td class="pax-name">{r.name}</td>
                      {#if showInfo}
                        <td class="dmg-cap">{r.typeName}</td>
                        <td class="dmg-cap">{r.rankName}</td>
                        <td class="dmg-cap">{r.craft || (manyBases ? r.base : "")}</td>
                      {/if}
                      <td class="pax-status" class:pax-hurt={r.status == "wounded"} title={statusTip(r)}>{statusText(r)}</td>
                      {#if view == "stats"}
                        {#each PAX_KEYS as k}
                          <td
                            class="pax-cell pax-h{cellHeat(r, k)}"
                            class:pax-maxed={r.cap[k] > 0 && r.raw[k] >= r.cap[k]}
                            title={statTip(r, k)}
                          >
                            {cellText(r, k)}
                          </td>
                        {/each}
                        <td class="pax-cell pax-h{step(r.gymLeft / 150)}" title="{r.gymLeft} stat points of gym training left">{r.gymLeft || "✓"}</td>
                        <td>
                          {#if best.get(r.id)}
                            {@const b = best.get(r.id)}
                            {@const s = scores.get(r.id)[b.id]}
                            <span class:pax-weak={s < 40} title={roleTip(b)}>{b.name} {Math.round(s)}</span>
                          {/if}
                        </td>
                      {:else if view == "roles"}
                        {#each roles as role (role.id)}
                          {@const s = scores.get(r.id)[role.id]}
                          <td
                            class="pax-cell pax-h{step(s / 100)}"
                            class:pax-top={best.get(r.id) == role}
                            title={roleTip(role)}
                          >
                            {s == null ? "" : Math.round(s)}
                          </td>
                        {/each}
                      {:else}
                        {#each CAREER as c}
                          {@const v = c.get(r)}
                          <td
                            class="pax-cell {c.heat && v != null && careerMax[c.id] > 0 ? 'pax-h' + step(v / careerMax[c.id]) : ''}"
                            title={c.title}
                          >
                            {v == null ? "" : c.fmt ? c.fmt(v) : v}
                          </td>
                        {/each}
                        <td class="dmg-cap">
                          {#if r.weapons.length}{rul.tr(r.weapons[0][0])} ×{r.weapons[0][1]}{/if}
                        </td>
                      {/if}
                    </tr>
                  {/each}
                {/each}
              </tbody>
            </table>
            {#if !shown.length}
              <p class="dmg-hint">Nobody matches. <button class="dmg-mini" on:click={clearFilter}>Clear the filter</button></p>
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    {#if selected}
      <aside class="pax-detail">
        <header class="pax-dhead">
          <div>
            <h3>{selected.name}</h3>
            <div class="dmg-cap">
              {selected.rankName} · {selected.typeName}<br />
              {selected.base}{#if selected.craft}&nbsp;· on {selected.craft}{/if}
            </div>
          </div>
          <button class="dmg-mini" title="Close" on:click={() => (selectedId = "")}>✕</button>
        </header>

        <p class="pax-dline">
          {#if selected.status == "fallen"}
            <b>Killed in action</b>
          {:else if selected.status == "wounded"}
            <b class="pax-hurt">✚ Wounded, {selected.recovery} days</b> · freshness {Math.round(selected.fresh * 100)}%
          {:else}
            Fit · freshness {Math.round(selected.fresh * 100)}%
          {/if}
          <br />
          {#if selected.armor}
            Wearing <a href={"##" + selected.armor} on:click|preventDefault={() => (peekId = selected.armor)}>{selected.armorName}</a>
          {/if}
        </p>

        {#if selected.status != "fallen"}
          <button class="dmg-mini dmg-wide" title="Open this soldier in CENTCOM, to rank weapons against an enemy for them" on:click={() => openInCentcom(selected)}>
            Open in CENTCOM →
          </button>
        {/if}

        <h4>Stats</h4>
        <div class="pax-bars">
          {#each PAX_STATS as s}
            {@const b = bar(selected, s.k)}
            <div class="pax-barrow" title={statTip(selected, s.k)}>
              <span class="pax-barlabel">{s.ab}</span>
              <span class="pax-track">
                <span class="pax-fill" class:pax-fillmax={b.maxed} style="width:{b.now}%" />
                <span class="pax-tick pax-tick-start" style="left:{b.start}%" />
                {#if b.gym != null}<span class="pax-tick pax-tick-gym" style="left:{b.gym}%" />{/if}
              </span>
              <span class="pax-barval">
                {selected.stats[s.k]}{#if selected.cap[s.k]}<span class="dmg-cap">/{selected.cap[s.k]}</span>{/if}
              </span>
            </div>
          {/each}
        </div>
        <p class="dmg-cap pax-barkey">
          bar = now, out of the hard cap · <span class="pax-key-start">|</span> rookie roll ·
          <span class="pax-key-gym">|</span> gym cap
        </p>

        <h4>Roles</h4>
        <div class="pax-bars">
          {#each selectedRoles as x}
            <div class="pax-barrow" title={roleTip(x.role)}>
              <span class="pax-barlabel pax-rolelabel">{x.role.name}</span>
              <span class="pax-track"><span class="pax-fill" style="width:{x.s}%" /></span>
              <span class="pax-barval">{Math.round(x.s)}</span>
            </div>
          {/each}
        </div>

        <h4>Service</h4>
        <p class="pax-dline">
          {selected.missions} missions · {selected.kills} kills · {selected.stuns} stuns<br />
          {#if selected.shots || selected.hits}
            {selected.shots} shots fired · {selected.hits} hits landed<br />
          {/if}
          {selected.gained} stat points gained{#if selected.gainRate != null}&nbsp;({selected.gainRate.toFixed(1)} a mission){/if}<br />
          wounded {selected.timesWounded}× for {selected.daysWounded} days{#if selected.months}&nbsp;· {selected.months} months served{/if}
        </p>

        {#if selected.weapons.length}
          <h4>Kills and stuns by weapon</h4>
          <ul class="pax-list">
            {#each selected.weapons.slice(0, 6) as [w, n]}
              <li>
                <a href={"##" + w} on:click|preventDefault={() => (peekId = w)}>{rul.tr(w)}</a>
                <span class="dmg-cap">×{n}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if selected.medals.length}
          <h4>Commendations</h4>
          <ul class="pax-list">
            {#each selected.medals as m}
              <li>
                <a href={"##" + m.name} on:click|preventDefault={() => (peekId = m.name)}>{rul.tr(m.name)}</a>
                {#if m.level}<span class="dmg-cap">level {m.level + 1}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
    {/if}
  </div>
</div>

<ArticlePeek bind:id={peekId} />
