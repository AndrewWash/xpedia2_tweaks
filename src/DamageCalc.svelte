<script>
  /**
   * Damage calculator.
   *
   * Two views over the same model:
   *   "weapons" - rank every weapon against one target ("what do I bring")
   *   "targets" - one weapon against a list of enemies ("is this still worth it")
   *
   * The numbers are honest about what they are. Damage is exact arithmetic from
   * OXCE's own pipeline. Acc is the figure the game's firing panel shows, which
   * is NOT a hit probability: for a shot the engine deviates the aim point
   * instead of rolling, so the Hit column beside it - damageHit.ts - is what
   * actually lands, and it depends on range. What neither can know is cover and
   * the target's real voxel model, so anything folding hit chance in is
   * labelled as a ranking aid.
   */
  import { rul } from "./Ruleset";
  import { Tr } from "./Components";
  import { onMount } from "svelte";
  import { resolveTarget, SIDES, armorValue, computeDamage,
    DEFAULT_TU_PER_TILE, DEFAULT_FREE_TILES } from "./damageCalc";
  import { sightDistance, sightNote, maxViewDistance } from "./damageSight";
  import { damageTypes } from "./Ruleset";
  import {
    weaponList,
    targetList,
    rankWeapons,
    scoreWeapon,
    attacksOf,
    modeKind,
    isUtilityMode,
  } from "./damageWeapons";
  import {
    loadSoldiers,
    saveSoldiers,
    blankSoldier,
    effectiveStats,
    statCaps,
    wearableArmors,
    exportSoldiers,
    importSoldiers,
    soldiersFromSave,
  } from "./damageSoldiers";
  import { STAT_KEYS } from "./damageCalc";
  import { scoreBand, scoreTurns } from "./damageScore";
  import { missionList, missionUnits, missionRows } from "./damageMissions";
  import { findSaves, stampSaves, sortSaves, loadSave, parseSave } from "./damageSave";
  import {
    buildAvailability,
    passesAvailability,
    availabilityNote,
    armorAvailable,
  } from "./damageAvailable";
  import { download } from "./exportPedia";

  export let targetId = "";

  let view = "weapons";
  let soldiers = [];
  let currentId = "";
  let editing = false;
  let side = "Front";
  /**
   * The distance a fight opens at, and the cutoff every mode's approach is
   * measured against. A mode reaching this far or further pays nothing; a
   * shorter one is charged for the tiles it has to close.
   *
   * 16 because that is where the mod actually sits: across 1096 ranged attack
   * modes the median reach is 18 and the mean (200-tile defaults capped at 30)
   * is 18.6, so a cutoff of 16 leaves most guns free and charges the genuinely
   * short-ranged ones.
   */
  let distance = 16;
  /**
   * Walking cost for the melee approach. Two knobs because they are two
   * different kinds of claim: tuPerTile is an engine fact (4 on a flat floor;
   * the "Lower move cost player only" mod scales player units to 75%, so 3),
   * freeTiles is an assumption about play. Either at 0 turns the whole thing
   * off and restores the assume-adjacency reading.
   */
  let tuPerTile = DEFAULT_TU_PER_TILE;
  let freeTiles = DEFAULT_FREE_TILES;
  /** Light conditions. Swings a soldier's sight from 40 tiles to 9. */
  let isDay = true;
  let showSight = false;
  /**
   * Wall-breaking modes (Demolish) are ranged with a one-tile range, so they
   * pay no approach and are scored where the Hit% geometry is kindest - which
   * ranks them far above what they do to a person. On by default; the modes
   * are still there if you want to look.
   */
  let excludeDemo = true;
  let kneeling = false;
  let oneHanded = false;
  let noLOS = false;
  /**
   * Whether UFO Extender accuracy is in force. Not a display setting: it decides
   * which range limit each firing mode is judged against (see rangeLimits).
   * Defaults on, which is both the OXCE default and the only possibility here -
   * XPiratez pins it through fixedUserOptions, and forcedExtender below reads
   * that so the checkbox cannot claim a state the mod does not allow.
   */
  let ufoExtender = true;
  /** How many shotgun pellets to assume land - see PelletModel in damageCalc. */
  let pelletModel = "derived";
  /**
   * Kill or capture. Stun weapons do no health damage at all - their whole
   * output goes into stun - so ranking them on health marks every one of them
   * unable. A unit drops when stun reaches its health, which is the threshold
   * the stun track uses.
   */
  let goal = "drop";
  let weaponFilter = "";
  /** "all" or one of the WeaponKind values. */
  let kindFilter = "all";
  /** "all" or a WeaponHands value. This is what the weapon REQUIRES, unrelated
   *  to the one-handed checkbox on the left (which is how you're holding it). */
  let handsFilter = "all";
  /**
   * Damage types to keep, as damageTypes indices. Empty means no restriction.
   *
   * A list rather than a single value because the useful question is usually
   * "what do I bring against this thing", and the answer is often two or three
   * types at once - the enemy's resistance chips are the control, so picking
   * the two it resists least is a single pair of clicks.
   */
  let dtFilters = [];
  /** The dropdown is an adder for the same list, so it resets after each pick. */
  let dtPick = "all";
  /**
   * Weapon-type tags to keep, from the mod's own categories - pistols,
   * shotguns, rifles and so on. Same multi-select shape as dtFilters, driven by
   * its own dropdown, so "all pistols and shotguns" is two picks.
   */
  let catFilters = [];
  let catPick = "all";
  /** Vehicle turrets and armour built-ins are off by default - they are not
   *  things a gal chooses, and their power values swamp the ranking. */
  let includeFixed = false;
  let targetFilter = "";
  /**
   * Mission filter for the enemy list. "" means no restriction.
   *
   * Saves cross-referencing the pedia: pick the raid you are about to fly and
   * the enemy list collapses to what can actually show up in it.
   */
  let missionId = "";
  let missionFilter = "";
  let allMissions = [];
  /** Show the deployment's troop table in the enemy header. */
  let showDeployment = false;
  let expandedId = "";
  let weaponId = "";
  let importError = "";
  /** ~500 wearable armours is too many for a bare dropdown. */
  let armorFilter = "";

  /**
   * Campaign filter: show only what a saved game can actually field.
   *
   *   "off"        every weapon in the mod, for browsing and planning ahead
   *   "stores"     only what is in a base store or loaded on a craft right now
   *   "obtainable" that, plus anything the save's research lets you buy or build
   *
   * Three states rather than two because the ruleset cannot answer this alone:
   * most XPiratez weapons carry no research gate at all, so "researched" would
   * happily list every piece of loot you have never found. See damageAvailable.
   *
   * Starts "off" - with no campaign loaded there is nothing to filter against
   * and the whole list is the honest answer. The moment a save actually parses
   * it flips itself to "obtainable", because by then the useful question is "of
   * the weapons I can get, which is best". Flips once only: choosing a mode
   * yourself sticks, the same way the soldier source does.
   */
  let availMode = "off";
  let availTouched = false;

  /**
   * Where the soldier list comes from.
   *
   *   "save"    the real crew out of the chosen saved game, read-only stats
   *   "manual"  the hand-entered profiles, which keep working exactly as before
   *
   * Flips to "save" on its own the first time a save with a crew is loaded -
   * that is the mode you want by default once you have pointed it at a campaign -
   * but never flips back, so choosing manual sticks.
   */
  let soldierSource = "manual";
  let sourceTouched = false;
  /** The crew as parsed. Never persisted: it belongs to the save, not to us. */
  let saveCrew = [];
  let crewFilter = "";
  /**
   * Armour tried out on a save soldier, keyed by soldier id. Kept apart from the
   * crew itself so the parsed data stays a faithful copy of the save and the
   * override can always be undone.
   */
  let crewArmor = {};
  const CREW_ARMOR_PREF = "xpediaCrewArmor";
  let saveList = [];
  let savePath = "";
  let saveState = null;
  let saveLoading = false;
  let saveError = "";
  const SAVE_PREF = "xpediaSave";

  // Built once - weaponList() walks every item in the mod and calls attacks().
  let allWeapons = [];
  let allTargets = [];
  let armorChoices = [];

  onMount(() => {
    allWeapons = weaponList();
    allTargets = targetList();
    // Built once, like the weapon list: it walks every deployment in the mod.
    const targetable = new Set(allTargets.map((t) => t.id));
    allMissions = missionList((id) => targetable.has(id));
    // armorChoices is now derived per soldier - see below.
    soldiers = loadSoldiers();
    if (!soldiers.length) soldiers = [blankSoldier("Gal")];
    currentId = soldiers[0].id;
    discoverSaves();
  });

  /**
   * Find the saves without loading any of them.
   *
   * Timestamps are best-effort - esbuild's directory index carries no dates, so
   * the only route is a Last-Modified header that may not be sent. When it is
   * missing the list is alphabetical and nothing is preselected, which is why
   * none of this is allowed to throw or block the rest of the panel.
   */
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
      // Ordering will just be alphabetical.
    }
    // A rescan must not drop files the user handed us - they are not on disk
    // and there is no way to find them again.
    saveList = [
      ...saveList.filter((x) => localSaves.has(x.path)),
      ...sortSaves(found).filter((x) => !localSaves.has(x.path)),
    ];

    let remembered = "";
    try {
      remembered = localStorage[SAVE_PREF] || "";
    } catch (e) {
      remembered = "";
    }
    if (remembered && saveList.some((x) => x.path == remembered)) savePath = remembered;

    try {
      const raw = JSON.parse(localStorage[CREW_ARMOR_PREF] || "{}");
      if (raw && typeof raw == "object") crewArmor = raw;
    } catch (e) {
      crewArmor = {};
    }
  }

  /**
   * Rescan for saves, and re-read the one already chosen.
   *
   * Cheap, because nothing about saves is cached: only the selected PATH is
   * remembered, in localStorage. So this is not the navbar's "purge cache and
   * reload" - that one wipes IndexedDB to re-read the mod rulesets and does
   * nothing at all for saves. This picks up a game saved thirty seconds ago
   * without touching the page.
   */
  let savesRefreshing = false;
  async function refreshSaves() {
    savesRefreshing = true;
    const keep = savePath;
    await discoverSaves();
    // The file itself has almost certainly changed, not just the list.
    if (keep && saveList.some((x) => x.path == keep)) await pickSave(keep);
    savesRefreshing = false;
  }

  /**
   * An exported HTML opened by double-click cannot reach the game folder AT
   * ALL, and no amount of retrying will change that: `/user/` resolves to the
   * drive root rather than the OpenXcom install, and browsers treat file:// as
   * an opaque origin and refuse to fetch any file:// URL. A picked file is the
   * only route, so say that instead of advising a rescan that cannot work.
   */
  const offlineFile = typeof location != "undefined" && location.protocol == "file:";

  /**
   * Read a .sav the user handed us, by picker or by drop.
   *
   * parseSave is already pure - loadSave is nothing but fetch + parseSave - so
   * this needs no new parsing, only a different way of getting the text.
   */
  /** Saves handed to us as files, by path, since they cannot be re-fetched. */
  const localSaves = new Map();

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
      // Keep the parsed result: there is no path to re-fetch a dropped file
      // from, so pickSave has to be able to hand it back without touching the
      // network.
      localSaves.set(file.name, parsed);
      // It is not on disk as far as the picker is concerned, so give it a row
      // there too - otherwise the <select> would show nothing selected.
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

  async function pickSave(path) {
    savePath = path;
    saveState = null;
    saveError = "";
    try {
      localStorage[SAVE_PREF] = path;
    } catch (e) {
      // Losing the preference is not worth failing over.
    }
    if (!path) return;
    // A file the user picked or dropped has no URL to fetch back.
    if (localSaves.has(path)) {
      saveState = localSaves.get(path);
      return;
    }
    saveLoading = true;
    const loaded = await loadSave(path);
    saveLoading = false;
    if (!loaded) {
      saveError = "Could not read that save";
      if (availMode != "off") availMode = "off";
      return;
    }
    saveState = loaded;
  }

  /**
   * The crew, rebuilt when the save changes.
   *
   * Switches the pane to the save's soldiers the first time a crew appears -
   * that is the point of loading a campaign - but only if the user has not
   * already made a choice, so picking Manual sticks.
   */
  $: if (saveState && !availTouched && availMode == "off") availMode = "obtainable";

  $: saveCrew = saveState ? soldiersFromSave(saveState.crew) : [];
  $: if (saveCrew.length && !sourceTouched && soldierSource != "save") {
    soldierSource = "save";
  }
  // Whatever list is showing, keep a valid selection in it.
  $: if (roster.length && !roster.some((x) => x.id == currentId)) currentId = roster[0].id;

  /** Rebuilt only when the save or the weapon list changes, never per keystroke. */
  $: availability =
    saveState && allWeapons.length ? buildAvailability(allWeapons, saveState) : new Map();

  /**
   * Load the chosen save eagerly. It used to wait until the availability filter
   * was switched on, but the crew is worth having on its own - and at ~17ms a
   * parse there is nothing to defer.
   */
  $: if (savePath && !saveState && !saveLoading && !saveError) pickSave(savePath);

  const AVAIL_MODES = [
    { id: "off", label: "Off", title: "Every weapon in the mod" },
    {
      id: "stores",
      label: "In stores",
      title:
        "Only weapons held at a base or already loaded on a craft in the chosen save",
    },
    {
      id: "obtainable",
      label: "Owned or can get",
      title:
        "Held, plus anything this campaign's research lets you buy or manufacture. " +
        "Base facilities are not checked, so a build you have no workshop for still counts.",
    },
  ];

  /**
   * Only the armours THIS soldier can wear.
   *
   * Recomputed when the selection changes, because the allowed set is per
   * soldier type - a plain gal has no business being offered "camo paint /cat".
   */
  $: armorChoices = wearableArmors(
    current && current.fromSave ? current.fromSave.type : ""
  ).filter(
    (a) =>
      // The campaign filter applies to what she can put ON as well as what she
      // can pick up - offering a suit you do not own is the same lie either way.
      // The armour actually worn always survives, so a soldier is never shown
      // wearing something the list then denies exists.
      armorAvailable(a.id, availMode, saveState) ||
      (current && current.fromSave && a.id == current.fromSave.wornArmor)
  );
  $: shownArmors = !armorFilter
    ? armorChoices
    : armorChoices.filter((a) =>
        a.title.toLowerCase().includes(armorFilter.trim().toLowerCase())
      );

  /**
   * The armours actually offered, always including the one being worn.
   *
   * The list is capped at 300 of ~540, and the cap silently ate the selection:
   * a hybrid in STR_HYBRID_ARMOR_THINMAN_UC sorts past the cut, so the picker
   * had no matching option and displayed "(none)" for a fully armoured gal.
   * Worse, a select with no matching option can fire a change carrying "",
   * which wrote an override that really did strip her armour.
   */
  $: armorOptions = (() => {
    const list = shownArmors.slice(0, 300);
    const worn = current && current.armor;
    if (worn && !list.some((a) => a.id == worn))
      return [{ id: worn, title: rul.tr(worn) + " (worn)" }, ...list];
    return list;
  })();

  /** Whichever list is on show, filtered by the search box. */
  $: roster = soldierSource == "save" ? saveCrew : soldiers;
  $: shownRoster = crewFilter
    ? roster.filter((s) => matchesSearch(s.name, crewFilter))
    : roster;

  /**
   * The selected soldier, with any armour the user is trying out folded in.
   *
   * A save soldier is copied rather than mutated so saveCrew stays exactly what
   * the file said - the override lives in crewArmor and can be dropped again.
   */
  $: current = (() => {
    const list = shownRoster.length ? shownRoster : roster;
    const base = list.find((s) => s.id == currentId) || list[0] || null;
    if (!base || !base.fromSave) return base;
    const chosen = crewArmor[base.id];
    return { ...base, armor: chosen == null ? base.fromSave.wornArmor : chosen };
  })();
  $: stats = current ? effectiveStats(current) : null;
  $: caps = current ? statCaps(current.fromSave ? current.fromSave.type : "STR_SOLDIER") : {};
  /** Save soldiers show their real numbers; only manual profiles are editable. */
  $: readOnlySoldier = !!(current && current.fromSave);

  /**
   * What the worn armour is doing to one stat, so the displayed total can be
   * taken apart. The form shows the number the calculator actually uses -
   * armour included - because you are almost never fighting in your underwear,
   * and a Firing of 57 that is really 47 in a heavy suit is a lie.
   *
   * Reactive, and closed over its inputs, for the same reason `passing` is:
   * Svelte tracks what an expression references, not what the functions it
   * calls close over. As a plain function the deltas went stale - swapping a
   * gal into Annihilator moved every stat while the little +5 beside them still
   * described the Scout outfit she had taken off.
   */
  $: statDelta = ((cur, eff) => (k) => {
    if (!cur || !eff) return 0;
    return (+eff[k] || 0) - (+cur.stats[k] || 0);
  })(current, stats);

  /** What the armour <select> is bound to. Mirrors the current soldier. */
  let armorPick = "";
  $: armorPick = current ? current.armor : "";

  function setArmor(id) {
    if (!current) return;
    // Picking something is the end of searching for it.
    armorFilter = "";
    if (current.fromSave) {
      crewArmor = { ...crewArmor, [current.id]: id };
      try {
        localStorage[CREW_ARMOR_PREF] = JSON.stringify(crewArmor);
      } catch (e) {
        // Losing the override is not worth failing over.
      }
      return;
    }
    current.armor = id;
    persist();
  }

  /** Put a save soldier's numbers into an editable profile you own. */
  function copyToManual() {
    if (!current || !current.fromSave) return;
    const copy = blankSoldier(current.name);
    for (const k of STAT_KEYS) copy.stats[k] = +current.stats[k] || 0;
    copy.armor = current.armor;
    soldiers = [...soldiers, copy];
    soldierSource = "manual";
    sourceTouched = true;
    currentId = copy.id;
    persist();
  }
  /** Campaign difficulty from the save; null (no adjustment) until one loads. */
  $: difficulty = saveState ? saveState.difficulty : null;
  $: target = targetId ? resolveTarget(targetId, difficulty) : null;
  /**
   * A mod may take this choice away from the player. `fixedUserOptions` is
   * honoured by OXCE over the player's own options.cfg, so when the active mod
   * pins the option there is only one honest answer and the toggle says so.
   */
  $: forcedExtender =
    rul.raw && rul.raw.fixedUserOptions &&
    rul.raw.fixedUserOptions.battleUFOExtenderAccuracy != null
      ? !!rul.raw.fixedUserOptions.battleUFOExtenderAccuracy
      : null;
  $: if (forcedExtender != null) ufoExtender = forcedExtender;

  $: soldierArmor = current && current.armor ? rul.armors[current.armor] : null;
  $: opts = { distance: +distance || 0, kneeling, oneHanded, noLOS, ufoExtender,
    tuPerTile: +tuPerTile || 0, freeTiles: +freeTiles || 0, isDay, soldierArmor };
  /** The spotting distance the whole table is measured against. */
  $: sight = target ? sightDistance(soldierArmor, target.armor, isDay) : null;

  function persist() {
    soldiers = soldiers;
    saveSoldiers(soldiers);
  }

  function addSoldier() {
    const s = blankSoldier("Soldier " + (soldiers.length + 1));
    soldiers = [...soldiers, s];
    currentId = s.id;
    editing = true;
    persist();
  }

  function removeSoldier() {
    if (!current || soldiers.length <= 1) return;
    soldiers = soldiers.filter((s) => s.id != currentId);
    currentId = soldiers[0].id;
    persist();
  }

  function onImport(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        soldiers = importSoldiers(String(reader.result));
        currentId = soldiers[0].id;
        importError = "";
        persist();
      } catch (err) {
        importError = String(err.message || err);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const KINDS = [
    { id: "all", label: "All" },
    { id: "ranged", label: "Ranged" },
    { id: "melee", label: "Melee" },
    { id: "thrown", label: "Thrown" },
    { id: "other", label: "Other" },
  ];

  /**
   * Mutually exclusive, unlike the kind chips, so these do sum to the total.
   *
   * The last two are NOT the same thing, which the old labels ("2-handed" and
   * "Both hands") did nothing to convey. The difference is what your off hand
   * can do, and it is the mod's own distinction - Item.svelte:36-40 renders one
   * as a one-handed penalty and the other as "2 hand only":
   *
   *   two  - twoHanded. Fire it one-handed if you want, at oneHandedPenalty,
   *          and the off hand is free to carry something.
   *   both - blockBothHands. Cannot be fired one-handed at all, and the off
   *          hand must be empty.
   */
  const HANDS = [
    { id: "all", label: "Any hands", title: "No restriction" },
    {
      id: "one",
      label: "1-handed",
      title: "One-handed: off hand free, no accuracy penalty either way",
    },
    {
      id: "two",
      label: "2-handed, 1h ok",
      title:
        "Two-handed, but you can still fire it one-handed at the weapon's penalty - so the off hand can carry something",
    },
    {
      id: "both",
      label: "2-handed only",
      title:
        "blockBothHands: cannot be fired one-handed at all, and the off hand must stay empty",
    },
  ];

  $: shownWeapons = allWeapons.filter((w) => {
    if (!includeFixed && w.fixed) return false;
    if (kindFilter != "all" && !w.kinds.includes(kindFilter)) return false;
    if (handsFilter != "all" && w.hands != handsFilter) return false;
    if (dtFilters.length && !w.damageTypes.some((t) => dtFilters.includes(t))) return false;
    if (catFilters.length && !w.categories.some((c) => catFilters.includes(c))) return false;
    if (!passesAvailability(w.id, availMode, availability)) return false;
    if (!matchesSearch(w.title, weaponFilter)) return false;
    return true;
  });

  /**
   * Comma-separated search: "saber, cutlass" shows both, so you can stand two
   * or three specific weapons next to each other and compare them for this
   * soldier rather than hunting them one at a time down a 635-row list.
   *
   * Terms are OR-ed, blanks ignored, so a trailing comma while you type does
   * not empty the table.
   */
  function matchesSearch(title, query) {
    if (!query) return true;
    const terms = query
      .toLowerCase()
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!terms.length) return true;
    const t = title.toLowerCase();
    return terms.some((q) => t.includes(q));
  }

  /** Counts for the filter chips, so it is obvious what each one holds. */
  // A hybrid counts under every class it belongs to, so these deliberately do
  // not sum to the "All" total.
  /**
   * Weapons passing every filter EXCEPT the one being counted.
   *
   * A reactive value rather than a plain function on purpose: the count blocks
   * below call it, and Svelte tracks what an expression *references*, not what
   * the functions it calls close over. Declared with `function` it went stale -
   * the chips kept reading "All 635" after the campaign filter cut the list to
   * 52. Reassigning it on every dependency change is what makes the counts follow.
   */
  $: passing = (w, skip) => {
    if (!includeFixed && w.fixed) return false;
    if (skip != "kind" && kindFilter != "all" && !w.kinds.includes(kindFilter)) return false;
    if (skip != "hands" && handsFilter != "all" && w.hands != handsFilter) return false;
    if (
      skip != "dt" &&
      dtFilters.length &&
      !w.damageTypes.some((t) => dtFilters.includes(t))
    )
      return false;
    if (
      skip != "cat" &&
      catFilters.length &&
      !w.categories.some((c) => catFilters.includes(c))
    )
      return false;
    if (skip != "avail" && !passesAvailability(w.id, availMode, availability)) return false;
    return true;
  };

  /** How many weapons each availability mode would leave, for the chips. */
  $: availCounts = (() => {
    const out = { off: 0, stores: 0, obtainable: 0 };
    for (const w of allWeapons) {
      if (!passing(w, "avail")) continue;
      out.off++;
      const a = availability.get(w.id);
      if (!a) continue;
      if (a.owned) out.stores++;
      if (a.obtainable) out.obtainable++;
    }
    return out;
  })();

  /** Add or remove one weapon type. Several selected means "any of these". */
  function toggleCat(id) {
    catFilters = catFilters.includes(id)
      ? catFilters.filter((x) => x != id)
      : [...catFilters, id];
  }

  /**
   * Add or remove one damage type. Several selected means "any of these", not
   * "all of these" - a weapon only ever deals one type per firing mode, so
   * intersecting them would always come back empty.
   */
  function toggleDt(i) {
    const t = +i;
    dtFilters = dtFilters.includes(t) ? dtFilters.filter((x) => x != t) : [...dtFilters, t];
  }

  // A hybrid counts under every kind it belongs to, so these deliberately do
  // not sum to the "All" total.
  $: kindCounts = allWeapons.reduce((acc, w) => {
    if (!passing(w, "kind")) return acc;
    acc.all = (acc.all || 0) + 1;
    for (const k of w.kinds) acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  $: handsCounts = allWeapons.reduce((acc, w) => {
    if (!passing(w, "hands")) return acc;
    acc.all = (acc.all || 0) + 1;
    acc[w.hands] = (acc[w.hands] || 0) + 1;
    return acc;
  }, {});

  /** Damage types actually present, with counts, for the dropdown. */
  $: dtOptions = (() => {
    const counts = {};
    for (const w of allWeapons) {
      if (!passing(w, "dt")) continue;
      for (const t of w.damageTypes) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.keys(counts)
      .map((t) => ({ id: t, n: counts[t], label: rul.tr(damageTypes[t] || "type " + t) }))
      .sort((a, b) => (a.label < b.label ? -1 : 1));
  })();

  /**
   * Weapon types present in the list, with counts.
   *
   * Built from the categories the weapons themselves carry rather than a list
   * of our own, so the junk categories (corpses, documents, armours) never
   * appear - nothing carriable and shootable is tagged with them - and another
   * mod's categories show up without a code change.
   */
  $: catOptions = (() => {
    const counts = {};
    for (const w of allWeapons) {
      if (!passing(w, "cat")) continue;
      for (const c of w.categories) counts[c] = (counts[c] || 0) + 1;
    }
    return Object.keys(counts)
      .map((c) => ({ id: c, n: counts[c], label: rul.tr(c) }))
      .sort((a, b) => (a.label < b.label ? -1 : 1));
  })();

  /** How many weapons each damage type would leave, for the chip tooltips. */
  $: dtCount = dtOptions.reduce((acc, d) => ((acc[+d.id] = d.n), acc), {});

  $: mission = missionId ? allMissions.find((m) => m.id == missionId) : null;

  /**
   * The units this mission can field, or null when nothing should be filtered.
   *
   * Null for a mission whose faction the ruleset does not pin down: filtering
   * on an empty set would show no enemies at all, which is worse than showing
   * every enemy and saying why.
   */
  $: missionRoster =
    missionId && mission && !mission.unresolved ? missionUnits(missionId) : null;

  $: deploymentRows = missionId && showDeployment ? missionRows(missionId) : [];

  $: shownMissions = missionFilter
    ? allMissions.filter((m) => matchesSearch(m.title, missionFilter))
    : allMissions;

  // Same comma-separated behaviour as the weapon search, so "ninja, muton"
  // stands two enemies side by side in the one-weapon-vs-enemies view.
  $: shownTargets = allTargets.filter(
    (t) =>
      (!missionRoster || missionRoster.has(t.id)) &&
      (!targetFilter || matchesSearch(t.title, targetFilter))
  );

  // A mission narrowed the list out from under the current pick: move to one
  // that is actually in it rather than leaving a stale enemy on screen.
  $: if (missionRoster && targetId && !missionRoster.has(targetId))
    targetId = shownTargets.length ? shownTargets[0].id : "";

  /**
   * Which modes the current filters actually want scored.
   *
   * Kind and damage type are properties of a FIRING MODE. Testing them only
   * when deciding which weapons to list left hybrids ranked on the wrong
   * attack - with Ranged selected the Good Lookin' Rock led the table on its
   * melee swing. Null when nothing is filtering, so the common case does no
   * work per mode.
   */
  $: modeFilter =
    kindFilter == "all" && !dtFilters.length && !excludeDemo
      ? null
      : (attack) => {
          if (excludeDemo && isUtilityMode(attack)) return false;
          if (kindFilter != "all" && modeKind(attack.mode) != kindFilter) return false;
          if (dtFilters.length && !dtFilters.includes(+attack.damageType)) return false;
          return true;
        };

  // Ranking every weapon is the expensive call; keep it to one reactive block.
  $: ranked =
    view == "weapons" && stats && target
      ? rankWeapons(shownWeapons, stats, target, side, opts, {}, pelletModel, goal, modeFilter)
      : [];

  $: weapon = weaponId ? allWeapons.find((w) => w.id == weaponId) : null;

  /**
   * Acc is what the game shows you; Hit is how often the shot lands. They are
   * different facts, and conflating them is what made guns look worse here
   * than they play. Shown side by side so it cannot happen again.
   */
  const SHOT_TITLE =
    "Where the fight starts. Range is the cutoff every approach is measured against - reach it and you pay " +
    "nothing, fall short and you pay to close. Sight is how far away you spot THIS enemy with THIS armour " +
    "in this light, computed from the ruleset; it is shown for reference but does not feed APPR yet.";

  const LIGHT_TITLE =
    "Daylight or darkness. A soldier sees maxViewDistance tiles by day (40 in XPiratez) but only 9 in the " +
    "dark unless her armour states otherwise - CASTAWAY states 12. It changes the whole table, because " +
    "a weapon you cannot shoot from spotting distance has to be walked into range.";

  const RANGE_TITLE =
    "The distance a fight opens at, and the cutoff every approach is measured against. A mode that reaches " +
    "THIS FAR OR FURTHER pays no APPR - you can already act from where the fight starts, which is also the " +
    "safer place to be. A shorter mode is charged for the tiles it has to close: a Sawed-Off reaching 4 at " +
    "a cutoff of 16 pays (16 - 4) x 4 = 48 TU. Melee reaches nothing, so it walks the whole cutoff. " +
    "16 because the mod's median ranged reach is 18 tiles, so most guns sit free of it and only the genuinely " +
    "short-ranged pay.";

  const DEMO_TITLE =
    "Hides wall-breaking modes - Demolish on the Hammer, Anchor, Crowbar, Pickaxe and friends. " +
    "The mod builds them as a RANGED mode with a one-tile range so they can smash terrain, which means " +
    "they pay no approach and are scored at point blank where the Hit% geometry is at its kindest. " +
    "Against a person close-quarters combat is what actually decides them and that is not modelled, so " +
    "they rank far above their worth. On by default; turn it off to see them anyway.";

  const RESIST_TITLE =
    "The target's resistance to this damage type, already applied to the range beside it. " +
    "Over 100% means it takes MORE than face value; 0% means immune.";

  const APPR_TITLE =
    "TU to walk one tile, and the tiles are (Range cutoff - this mode's reach). Reach the cutoff or better " +
    "and it is nothing; fall short and you pay for closing the gap, which is TU and exposure both. Melee " +
    "reaches nothing, so it walks the whole cutoff. Charged ONCE before the first attack, not per attack. " +
    "4 TU a tile is the engine default on a flat floor; this install's Lower move cost player only mod " +
    "scales player units to 75%, so 3. Set it to 0 to turn the whole thing off.";

  const FREE_TITLE =
    "Tiles of closing that cost nothing, because you would have moved anyway. Nobody plays a perfect " +
    "spacing game - a gunner does not stand rooted at her ideal range any more than a melee gal starts " +
    "adjacent, and both spend part of every turn repositioning. That shared cost cancels out of the " +
    "comparison, so only the gap beyond it is charged to melee.";

  const HIT_TITLE =
    "How often this attack actually connects, which for guns is NOT the Acc figure. " +
    "The engine never rolls against accuracy for a shot - it uses accuracy to decide " +
    "how far the aim point drifts, and that drift grows with range. Every roll under " +
    "your accuracy drifts by a single voxel, a dead-on hit, so Acc is a FLOOR on how " +
    "often you connect rather than an estimate. Close in the drift is smaller than the " +
    "enemy and nearly everything lands; far out it is many times their width. " +
    "Melee and thrown attacks show the same number as Acc, because melee really is a " +
    "straight percentage roll. No cover or terrain is modelled.";

  /**
   * Columns for the enemy list. Same idea as COLUMNS, but keyed on an
   * {target, mode} pair rather than a weapon mode, so the enemy's own numbers
   * can be sorted on too.
   */
  const TCOLUMNS = [
    {
      id: "score",
      label: "Score",
      title:
        "0-100 against this enemy. 50 means one full turn of this soldier's TU to drop it.",
      get: (m) => m.score,
      round: 0,
    },
    { id: "enemy", label: "Enemy", get: (m, t) => t.title.toLowerCase(), asc: true },
    { id: "armour", label: "Armour", get: (m, t) => armorValue(t, side), asc: true, round: 0 },
    { id: "hp", label: "HP", get: (m, t) => t.health, asc: true, round: 0 },
    { id: "mode", label: "Mode", get: (m) => (m.label || "").toLowerCase(), asc: true },
    { id: "damage", label: "Damage", get: (m) => m.damage.avg, round: 0 },
    {
      id: "acc",
      label: "Acc",
      title: "The most effective mode is not always the accurate one - this is why",
      get: (m) => m.accuracy,
      round: 0,
    },
    { id: "hit", label: "Hit%", title: HIT_TITLE, get: (m) => m.hitRate * 100, round: 0 },
    { id: "perAttack", label: "Per attack", get: (m) => m.perAttack, round: 1 },
    { id: "appr", label: "APPR", title: APPR_TITLE, get: (m) => m.approachTu || null, round: 0 },
    { id: "tu", label: "TU to kill", get: (m) => m.tuToKill, asc: true, round: 0 },
    { id: "turns", label: "Turns", get: (m) => m.turnsToKill, asc: true, round: 1 },
  ];

  const tcolById = (id) => TCOLUMNS.find((c) => c.id == id);
  let tSortKeys = [{ id: "score", desc: true }];
  let tSortTouched = false;

  $: tIsDefaultSort = !tSortTouched;

  function tSortBy(id) {
    const col = tcolById(id);
    const fresh = { id, desc: !(col && col.asc) };
    if (!tSortTouched) {
      tSortTouched = true;
      tSortKeys = [fresh];
      return;
    }
    const at = tSortKeys.findIndex((k) => k.id == id);
    if (at != -1) {
      tSortKeys[at].desc = !tSortKeys[at].desc;
      tSortKeys = tSortKeys;
      return;
    }
    tSortKeys = [...tSortKeys, fresh].slice(-MAX_SORT_KEYS);
  }

  function tDropSortKey(id) {
    const next = tSortKeys.filter((k) => k.id != id);
    if (next.length) tSortKeys = next;
    else tResetSort();
  }

  function tResetSort() {
    tSortKeys = [{ id: "score", desc: true }];
    tSortTouched = false;
  }

  function tSortValue(col, m, t) {
    const v = col.get(m, t);
    if (typeof v != "number" || col.round == null) return v;
    const f = 10 ** col.round;
    return Math.round(v * f) / f;
  }

  function tCmpChain(mA, tA, mB, tB, keys) {
    for (const k of keys) {
      const col = tcolById(k.id);
      if (!col) continue;
      const r = cmpOne(tSortValue(col, mA, tA), tSortValue(col, mB, tB), k.desc ? -1 : 1);
      if (r) return r;
    }
    return 0;
  }

  /**
   * One row per (enemy, firing mode), enemies kept together. Mirrors the
   * weapons view: an enemy's place is set by the mode that drops it fastest,
   * and every mode is listed underneath rather than hidden.
   */
  $: targetRows = (() => {
    const keys = tSortKeys;
    const groups = byTarget.map((e) => {
      const modes = [...e.result.modes].sort((x, y) =>
        tCmpChain(x, e.target, y, e.target, keys)
      );
      return { entry: e, modes, best: modes[0] };
    });
    groups.sort((a, b) => tCmpChain(a.best, a.entry.target, b.best, b.entry.target, keys));

    const out = [];
    for (const g of groups)
      g.modes.forEach((m, i, arr) =>
        out.push({
          id: g.entry.target.id + "/" + m.mode,
          target: g.entry.target,
          result: g.entry.result,
          mode: m,
          first: i == 0,
          last: i == arr.length - 1,
          modeCount: arr.length,
        })
      );
    return out;
  })();

  /** Which enemy's detail row is open, by id. */
  let expandedTargetId = "";

  /** Resistances worth showing for one enemy, same rule as the header. */
  function resistsOf(t) {
    const mods = t && t.armor && t.armor.damageModifier;
    if (!Array.isArray(mods)) return [];
    return mods
      .map((v, i) => ({ i, pct: Math.round(+v * 100) }))
      .filter((r) => r.pct != 100)
      .map((r) => ({ ...r, name: rul.tr(damageTypes[r.i] || "type " + r.i) }))
      .sort((a, b) => a.pct - b.pct);
  }

  $: byTarget =
    view == "targets" && stats && weapon
      ? shownTargets
          .map((t) => {
            const tgt = resolveTarget(t.id, difficulty);
            if (!tgt) return null;
            const r = scoreWeapon(weapon, null, stats, tgt, side, opts, pelletModel, goal);
            return r.best ? { target: tgt, result: r } : null;
          })
          .filter(Boolean)
          .sort((a, b) => {
            // Highest score first, matching the Score column and the weapons view.
            const av = a.result.best.score;
            const bv = b.result.best.score;
            return (bv == null ? -1 : bv) - (av == null ? -1 : av);
          })
      : [];

  /**
   * Table columns.
   *
   * `get` reads the value off one firing MODE, since the list is one row per
   * mode. `asc` marks columns where smaller is better, so a first click sorts
   * the useful way round. `round` is the precision used for COMPARISON, and it
   * matters: raw accuracy is a float, so two weapons both displaying 77% would
   * almost never tie, and a second sort key would never get a say. Comparing at
   * display precision is what makes "accuracy, then damage per attack" work.
   */
  $: COLUMNS = [
    {
      id: "score",
      label: "Score",
      title:
        "The verdict, 0-100. 50 means one full turn of this soldier's TU to drop this " +
        "enemy, so above 50 is faster than a turn and 0 means it never gets there. " +
        "Counts a miss as a wasted shot rather than as reduced damage, which is why an " +
        "accurate weapon can outscore a cheaper inaccurate one.",
      get: (m) => m.score,
      round: 0,
    },
    { id: "weapon", label: "Weapon", get: (m, w) => w.title.toLowerCase(), asc: true },
    {
      id: "size",
      label: "Size",
      title: "Inventory footprint, width x height - what it costs you in pack space",
      get: (m, w) => (+w.item.invWidth || 1) * (+w.item.invHeight || 1),
      asc: true,
      round: 0,
    },
    { id: "mode", label: "Mode", get: (m) => (m.label || "").toLowerCase(), asc: true },
    { id: "damage", label: "Damage", get: (m) => m.damage.avg, round: 0 },
    {
      id: "range",
      label: "Range",
      title:
        "Effective range of this mode. With range falloff on, accuracy drops by the " +
        "weapon's dropoff per tile past it; with falloff off, the aimed range governs " +
        "every mode instead and this number is greyed.",
      get: (m) => m.attack.range,
      round: 0,
    },
    { id: "acc", label: "Acc", get: (m) => m.accuracy, round: 0 },
    { id: "hit", label: "Hit%", title: HIT_TITLE, get: (m) => m.hitRate * 100, round: 0 },
    {
      id: "perAttack",
      label: goal == "stun" ? "Stun/attack" : "Per attack",
      title:
        "Average " +
        (goal == "stun" ? "stun" : "health") +
        " damage per attack ATTEMPT - after armour, and with misses averaged in, " +
        "so it is not what a hit does. No single attack ever deals exactly this. " +
        "That is why it can sit above the target's HP and still need two attacks: " +
        "see the Damage range beside it and the Attacks tooltip.",
      get: (m) => m.perAttack,
      round: 1,
    },
    { id: "appr", label: "APPR", title: APPR_TITLE, get: (m) => m.approachTu || null, round: 0 },
    {
      id: "attacks",
      label: "Attacks",
      title:
        "Whole attacks expected to " +
        (goal == "stun" ? "knock out" : goal == "drop" ? "take down" : "kill") +
        " the target 4 times out of 5, simulated shot by shot: misses cost a whole " +
        "attack, damage is rolled from its real spread rather than averaged, and the " +
        "armour degrades as it goes. The Score is built from exactly this number.",
      get: (m) => m.attacksToKill,
      asc: true,
      round: 1,
    },
    {
      id: "tu",
      label: goal == "stun" ? "TU to stun" : goal == "drop" ? "TU to drop" : "TU to kill",
      title:
        "The total the Score is built from: every attack, PLUS the APPR walk for a " +
        "melee mode. Charged once, so it is approach + attacks x cost, not the walk " +
        "repeated per swing.",
      get: (m) => m.tuToKill,
      asc: true,
      round: 0,
    },
    {
      id: "turns",
      label: "Turns",
      title:
        "That TU as a fraction of this soldier's bar, so below 1 it is also what she " +
        "has left afterwards - 0.27 means a quarter of the bar spent and she can still " +
        "move. Hover a row for the whole-turn count, which is the tactical one: you " +
        "cannot carry TU between turns or fire part of a shot.",
      get: (m) => m.turnsToKill,
      asc: true,
      round: 2,
    },
  ];

  const colById = (id) => COLUMNS.find((c) => c.id == id);

  /**
   * The sort chain, most significant first. Effectiveness alone by default.
   * Capped at three keys - past that nobody can predict the ordering anyway.
   */
  const MAX_SORT_KEYS = 3;
  let sortKeys = [{ id: "score", desc: true }];
  /**
   * Whether the user has picked a sort themselves. While false the chain is
   * just the effectiveness default, and the first column click REPLACES it
   * rather than appending - otherwise "sort by accuracy" would quietly mean
   * "by effectiveness, then accuracy", where the second key almost never gets
   * a say and clicking appears to do nothing.
   */
  let sortTouched = false;

  $: isDefaultSort =
    !sortTouched && sortKeys.length == 1 && sortKeys[0].id == "score" && sortKeys[0].desc;

  /**
   * Clicking a column it is already sorting by flips that column's direction;
   * clicking a new one appends it as a tiebreak. So Acc then Per attack gives
   * "most accurate, and among equally accurate ones the hardest hitting".
   */
  function sortBy(id) {
    const col = colById(id);
    const fresh = { id, desc: !(col && col.asc) };

    if (!sortTouched) {
      sortTouched = true;
      sortKeys = [fresh];
      return;
    }

    const at = sortKeys.findIndex((k) => k.id == id);
    if (at != -1) {
      sortKeys[at].desc = !sortKeys[at].desc;
      sortKeys = sortKeys;
      return;
    }
    // Oldest key drops out once the chain is full - three is already as deep as
    // anyone can hold in their head.
    sortKeys = [...sortKeys, fresh].slice(-MAX_SORT_KEYS);
  }

  function dropSortKey(id) {
    const next = sortKeys.filter((k) => k.id != id);
    if (next.length) {
      sortKeys = next;
    } else {
      resetSort();
    }
  }

  function resetSort() {
    sortKeys = [{ id: "score", desc: true }];
    sortTouched = false;
  }

  const sortIndex = (keys, id) => keys.findIndex((k) => k.id == id);

  /** Value used for comparison: rounded to what the cell actually shows. */
  function sortValue(col, m, w) {
    const v = col.get(m, w);
    if (typeof v != "number" || col.round == null) return v;
    const f = 10 ** col.round;
    return Math.round(v * f) / f;
  }

  /** Nulls and infinities always sink, whichever way the sort runs. */
  function cmpOne(a, b, dir) {
    const an = a == null || (typeof a == "number" && !isFinite(a));
    const bn = b == null || (typeof b == "number" && !isFinite(b));
    if (an || bn) return an && bn ? 0 : an ? 1 : -1;
    if (a === b) return 0;
    return a < b ? -dir : dir;
  }

  /** Walk the sort chain until something breaks the tie. */
  function cmpChain(mA, wA, mB, wB, keys) {
    for (const k of keys) {
      const col = colById(k.id);
      if (!col) continue;
      const r = cmpOne(sortValue(col, mA, wA), sortValue(col, mB, wB), k.desc ? -1 : 1);
      if (r) return r;
    }
    return 0;
  }

  /**
   * One row per firing mode, with each weapon's modes kept together.
   *
   * A weapon's place is decided by its BEST mode under the current sort chain,
   * and its own modes are then ordered the same way. So the Homefront Rifle
   * sits wherever its strongest mode earns it, with snap/aimed/auto all visible
   * underneath rather than hidden behind a click.
   */
  $: rows = (() => {
    const keys = sortKeys;
    const groups = ranked.map((r) => {
      const modes = [...r.modes].sort((x, y) => cmpChain(x, r, y, r, keys));
      return { weapon: r, best: modes[0] };
    });
    groups.sort((a, b) => cmpChain(a.best, a.weapon, b.best, b.weapon, keys));

    const out = [];
    for (const g of groups)
      g.weapon.modes.length &&
        [...g.weapon.modes]
          .sort((x, y) => cmpChain(x, g.weapon, y, g.weapon, keys))
          .forEach((m, i, arr) =>
            out.push({
              id: g.weapon.id + "/" + m.mode,
              weapon: g.weapon,
              mode: m,
              first: i == 0,
              last: i == arr.length - 1,
              modeCount: arr.length,
            })
          );
    return out;
  })();

  const n = (v, d = 1) => (v == null ? "-" : (Math.round(v * 10 ** d) / 10 ** d).toString());
  const pct = (v) => Math.round(v * 100) + "%";

  /**
   * Resistances worth showing: anything the armour actually modifies. A flat
   * 100% is the default and says nothing, so it is left out.
   */
  $: resistances = !target || !Array.isArray(target.armor.damageModifier)
    ? []
    : target.armor.damageModifier
        .map((v, i) => ({ i, pct: Math.round(+v * 100) }))
        .filter((r) => r.pct != 100)
        .map((r) => ({ ...r, name: rul.tr(damageTypes[r.i] || "type " + r.i) }))
        .sort((a, b) => a.pct - b.pct);

  /** A few defender stats that change how a fight actually goes. */
  $: targetStats = (() => {
    const u = target && target.unit;
    if (!u || !u.stats) return [];
    const out = [];
    const add = (label, key) => {
      const v = +u.stats[key];
      if (v) out.push(label + " " + v);
    };
    add("TU", "tu");
    add("React", "reactions");
    add("Melee", "melee");
    add("Firing", "firing");
    add("Bravery", "bravery");
    return out;
  })();

  /**
   * True when this mode is actually paying a range penalty at the chosen
   * distance. Read off the limits the model resolved rather than recomputed,
   * because which limit applies depends on the UFO Extender toggle - the mode's
   * own range is NOT the answer when it is off.
   */
  function outOfRange(m) {
    return !!(m && m.limits && m.limits.governing);
  }

  /**
   * Whether the number in the Range column is the limit governing this mode's
   * accuracy. With falloff off, every mode is judged against the AIMED range, so
   * a snap weapon's own 15 tiles stops meaning anything for accuracy - still
   * worth showing, since it is what the mod author wrote, but it must not read
   * as a cliff that is not there.
   */
  function rangeGoverns(m) {
    if (!m || !m.limits) return true;
    // Nothing is displayed for a melee swing or a throw, so there is nothing to
    // grey out and nothing to mislead about.
    if (m.attack.range == null || m.attack.mode == "throw") return true;
    return +m.attack.range == m.limits.upper;
  }

  /**
   * The score shown on a row: the weapon's verdict on its first row, that
   * mode's own on the rows below. Under the default sort those coincide on the
   * first row, since modes are ordered by score - they diverge once you sort by
   * something else, and the weapon-level number is the one worth keeping there.
   */
  function bestOf(row) {
    // Weapons view groups by weapon, enemies view by enemy - both carry the
    // best-scoring mode of their group, just under different names.
    const r = row.weapon || row.result;
    return r && r.best;
  }

  function scoreOf(row) {
    const m = row.first ? bestOf(row) || row.mode : row.mode;
    return m ? m.score : null;
  }

  /** The score, spelled out, so it is never just a number you have to trust. */
  function scoreNote(row) {
    const m = row.first ? bestOf(row) || row.mode : row.mode;
    if (!m) return "";
    const s = m.score;
    if (s == null)
      return "No time-unit cost in the ruleset for this attack, so there is nothing to score";
    if (!(s > 0))
      return (
        "Cannot drop this target: " +
        (m.accuracy <= 0
          ? "the shot cannot connect at this range"
          : "even 100 attacks do not reach 4-in-5 odds of putting it down")
      );
    const turns = scoreTurns(s);
    const parts = [
      (row.first && row.modeCount > 1 ? m.label + " is this weapon's best: " : "") + s + "/100",
      m.attacksToKill +
        (m.attacksToKill == 1 ? " attack" : " attacks") +
        " for " +
        Math.round((m.killChance || 0) * 100) +
        "% odds of dropping it",
      n(m.tuToKill, 0) + " TU",
      (turns < 1 ? "about " + Math.round(turns * 100) + "% of" : n(turns, 1) + "x") +
        " this soldier's turn",
    ];
    return parts.join(" · ");
  }

  /** What the Range cell is and is not telling you. */
  function rangeNote(m) {
    if (!m || !m.limits) return "";
    const l = m.limits;
    // A melee swing is adjacent by definition; the engine does run it through
    // the same window, but you can never be far enough away for it to matter.
    if (m.attack.mode == "melee") return "Melee - adjacent only, so range never applies";

    // A throw is judged against throwDropoffRange (99 tiles), never its own
    // range and never the aimed one, and 99 is past the 40-tile view limit.
    if (m.attack.mode == "throw")
      return (
        "Throws fall off past " + n(l.upper, 0) + " tiles at −" + n(l.dropoff, 0) +
        "% per tile. That is beyond how far you can see, so a throw never pays a " +
        "range penalty."
      );

    const own = m.attack.range == null ? "none" : n(m.attack.range, 0) + " tiles";
    const parts = ["This mode's own range: " + own];
    if (!rangeGoverns(m))
      parts.push(
        "not governing accuracy - falloff is off, so this mode is judged against " +
          n(l.upper, 0) + " tiles (the aimed range)"
      );
    if (l.governing == "upper")
      parts.push(
        "past " + n(l.upper, 0) + " tiles: −" + n(l.dropoff, 0) + "% per tile, " +
          "costing " + n(l.dropoff * (Math.floor(+distance || 0) - l.upper), 0) + "% here"
      );
    else if (l.governing == "lower")
      parts.push(
        "inside the " + n(l.lower, 0) + " tile minimum: −" + n(l.dropoff, 0) + "% per tile"
      );
    else parts.push("no range penalty at " + Math.floor(+distance || 0) + " tiles");
    return parts.join(" · ");
  }

  /**
   * Turns as a fraction of this soldier's bar. Real precision below one turn,
   * because "5 TU out of 100" is 0.05 of a turn and rounding that to "<0.1"
   * threw away the only thing that distinguished a cheap shot from a costly
   * one.
   */
  function turnsLabel(m) {
    if (!m || m.turnsToKill == null || !isFinite(m.turnsToKill)) return "–";
    return n(m.turnsToKill, m.turnsToKill < 1 ? 2 : 1);
  }

  /** The two turn readings, spelled out on hover. */
  function turnsNote(m) {
    if (!m || m.turnsToKill == null || !isFinite(m.turnsToKill)) return "";
    const frac = m.turnsToKill;
    const parts = [n(frac, 2) + " of this soldier's TU bar"];
    if (frac < 1) parts.push(Math.round((1 - frac) * 100) + "% of the bar left over");
    if (m.wholeTurns != null)
      parts.push(
        m.wholeTurns +
          (m.wholeTurns == 1 ? " whole turn" : " whole turns") +
          " in practice, at " +
          m.perTurn +
          (m.perTurn == 1 ? " attack" : " attacks") +
          " a turn"
      );
    return parts.join(" · ");
  }

  /**
   * What the armour column is telling you, in words.
   *
   * Three cases worth spelling out, because the number alone reads as trivia
   * until you know which one you are looking at: armour this attack cannot
   * beat but can grind down, armour it strips on the way through, and armour
   * that is still standing when the target drops.
   */
  function armourNote(m) {
    if (!m) return "";
    const start = m.damage.armorAtStart;
    if (!(m.armorPerAttack > 0.05))
      return "This attack does not damage armour" + (start ? " - " + n(start, 0) + " stays up" : "");
    const parts = [
      n(m.armorPerAttack, 1) + " armour off " + n(start, 0) + " per attack",
      "pre-damage " + n(m.damage.avgArmorPre, 2) + " + post " + n(m.damage.avgArmorPost, 2) +
        " per projectile",
    ];
    if (m.attacksToPenetrate > 1)
      parts.push("nothing gets through until attack " + m.attacksToPenetrate);
    if (m.attacksToKill != null)
      parts.push("armour down to " + n(m.armorEnd, 0) + " when the target drops");
    return parts.join(" · ");
  }
</script>

<div class="dmg-wrap">
  <div class="dmg-toolbar">
    <button class="dmg-tab" class:dmg-tab-on={view == "weapons"} on:click={() => (view = "weapons")}>
      Weapons vs one enemy
    </button>
    <button class="dmg-tab" class:dmg-tab-on={view == "targets"} on:click={() => (view = "targets")}>
      One weapon vs enemies
    </button>
    <span class="stretcher" />
    <span class="dmg-note" title={HIT_TITLE}>
      Damage is exact. Guns never roll against Acc - the shot drifts instead, so
      Hit% runs above Acc up close and decays with range.
    </span>
  </div>

  <div class="dmg-body">
    <aside class="dmg-side">
      <!-- Deliberately NOT cleared by "Clear filters": which campaign you are
           planning for is a context you set once, not a filter you shuffle. -->
      <section
        class="dmg-block"
        class:dmg-dropping={savDragOver}
        on:dragover|preventDefault={() => (savDragOver = true)}
        on:dragleave={() => (savDragOver = false)}
        on:drop={onSavDrop}
      >
        <header>
          Campaign
          {#if !offlineFile}
            <button
              class="dmg-mini dmg-refresh"
              title="Rescan for saved games and re-read the selected one. Saves are never cached, so this picks up a game you just saved - no page reload needed."
              disabled={savesRefreshing}
              on:click={refreshSaves}>⭯</button
            >
          {/if}
        </header>
        {#if !saveList.length}
          {#if offlineFile}
            <p class="dmg-cap">
              This page was opened straight from a file, so it cannot read your
              OpenXcom folder - browsers block that. Drop a
              <code>.sav</code> anywhere on this panel, or pick one below.
            </p>
          {:else}
            <p class="dmg-cap">
              No saved games found. This needs XPedia served from your OpenXcom folder
              so it can read <code>user/&lt;mod&gt;/*.sav</code> - or you can drop a
              <code>.sav</code> on this panel.
            </p>
          {/if}
          <label class="dmg-mini dmg-file">
            Open a .sav…
            <input type="file" accept=".sav,.asav" on:change={(e) => {
              readSavFile(e.target.files && e.target.files[0]);
              e.target.value = "";
            }} />
          </label>
          {#if saveLoading}
            <p class="dmg-cap">Reading save…</p>
          {:else if saveError}
            <p class="dmg-warn">⚠ {saveError}</p>
          {/if}
        {:else}
          <select
            class="dmg-input"
            title="Which saved game decides what you have access to"
            value={savePath}
            on:change={(e) => pickSave(e.target.value)}
          >
            <option value="">(no save — show everything)</option>
            {#each saveList as sv}
              <option value={sv.path}>{sv.file.replace(/\.a?sav$/, "")}</option>
            {/each}
          </select>

          <label class="dmg-mini dmg-file" title="Read a .sav from anywhere on disk. You can also drop one on this panel.">
            Open a .sav…
            <input type="file" accept=".sav,.asav" on:change={(e) => {
              readSavFile(e.target.files && e.target.files[0]);
              e.target.value = "";
            }} />
          </label>

          <div class="dmg-chips">
            {#each AVAIL_MODES as m}
              <button
                class="dmg-chip"
                class:dmg-chip-on={availMode == m.id}
                title={m.title}
                disabled={m.id != "off" && !savePath}
                on:click={() => {
                  availMode = m.id;
                  availTouched = true;
                }}
              >
                {m.label}
                {#if m.id != "off" && saveState}
                  <span class="dmg-chip-n">{availCounts[m.id]}</span>
                {/if}
              </button>
            {/each}
          </div>

          {#if saveLoading}
            <p class="dmg-cap">Reading save…</p>
          {:else if saveError}
            <p class="dmg-warn">⚠ {saveError}</p>
          {:else if saveState}
            <p class="dmg-cap">
              {@html saveState.name || "save"}{#if saveState.date}&nbsp;·
                {saveState.date}{/if}<br />
              {saveState.discovered.size} researched · {saveState.owned.size} item types
              held across {saveState.bases}
              {saveState.bases == 1 ? "base" : "bases"}
              {#if saveState.crafts}
                and {saveState.crafts}
                {saveState.crafts == 1 ? "craft" : "crafts"}{/if}
            </p>
          {:else if savePath}
            <p class="dmg-cap">Pick a mode to load this save.</p>
          {/if}
        {/if}
      </section>

      <section class="dmg-block">
        <header>
          Soldier
          <button
            class="dmg-mini"
            title="Add a manual soldier"
            disabled={soldierSource == "save"}
            on:click={addSoldier}>+</button
          >
          <button
            class="dmg-mini"
            title="Delete this manual soldier"
            disabled={soldierSource == "save" || soldiers.length <= 1}
            on:click={removeSoldier}>−</button
          >
        </header>

        {#if saveCrew.length}
          <div class="dmg-chips">
            <button
              class="dmg-chip"
              class:dmg-chip-on={soldierSource == "save"}
              title="The real crew from the chosen saved game"
              on:click={() => {
                soldierSource = "save";
                sourceTouched = true;
                currentId = "";
              }}
            >
              From save <span class="dmg-chip-n">{saveCrew.length}</span>
            </button>
            <button
              class="dmg-chip"
              class:dmg-chip-on={soldierSource == "manual"}
              title="Profiles you typed in yourself"
              on:click={() => {
                soldierSource = "manual";
                sourceTouched = true;
                currentId = "";
              }}
            >
              Manual <span class="dmg-chip-n">{soldiers.length}</span>
            </button>
          </div>
        {/if}

        <!-- Same shape as the Enemy picker: a filter box over a real list box,
             so a crew of forty is one scroll rather than a blind dropdown. -->
        <input
          class="dmg-input"
          placeholder="Search soldiers… (comma-separate)"
          bind:value={crewFilter}
        />
        <select class="dmg-input dmg-list" size={roster.length > 1 ? 8 : 2} bind:value={currentId}>
          {#each shownRoster.slice(0, 200) as s}
            <option value={s.id}>{s.name}{s.fromSave && s.fromSave.note ? " · " + s.fromSave.note : ""}</option>
          {/each}
        </select>
        {#if crewFilter}
          <span class="dmg-cap">{shownRoster.length} of {roster.length}</span>
        {/if}

        {#if current}
          {#if !readOnlySoldier}
            <input class="dmg-input" bind:value={current.name} on:change={persist} />
          {/if}

          <div class="dmg-armorpick">
            <span class="dmg-rowlabel">Armour</span>
            <input
              class="dmg-input"
              placeholder="Search armour…"
              bind:value={armorFilter}
            />
            <!-- bind:value, not value=. A one-way value on a <select> is applied
                 before its options finish re-rendering, so the moment the list
                 changed (a filter, or the campaign mode trimming it) the browser
                 found no matching option and fell back to "(none)" - showing a
                 fully armoured gal as wearing nothing. -->
            <select
              class="dmg-input"
              size={armorFilter ? 8 : 1}
              bind:value={armorPick}
              on:change={(e) => setArmor(e.target.value)}
            >
              <option value="">(none)</option>
              {#each armorOptions as a}
                <option value={a.id}>{@html a.title}</option>
              {/each}
            </select>
            {#if armorFilter}
              <span class="dmg-cap">{shownArmors.length} of {armorChoices.length}</span>
            {/if}
          </div>

          <button class="dmg-mini dmg-wide" on:click={() => (editing = !editing)}>
            {editing ? "Hide stats" : "Edit stats"}
          </button>

          {#if editing}
            {#each STAT_KEYS as k}
              <label class="dmg-row dmg-stat">
                <span><Tr s={k} /></span>
                <!-- Ahead of the box, and always present once a save soldier is
                     selected even when the modifier is zero: an absent span
                     would let rows with no armour effect slide their input left
                     and break the column. -->
                {#if readOnlySoldier}
                  <span class="dmg-statdelta" class:dmg-statdown={statDelta(k) < 0}>
                    {statDelta(k) ? (statDelta(k) > 0 ? "+" : "") + statDelta(k) : ""}
                  </span>
                {/if}
                <input
                  class="dmg-input dmg-num"
                  class:dmg-readonly={readOnlySoldier}
                  type="number"
                  min="0"
                  readonly={readOnlySoldier}
                  tabindex={readOnlySoldier ? -1 : 0}
                  title={readOnlySoldier && statDelta(k)
                    ? current.stats[k] + " base " + (statDelta(k) > 0 ? "+" : "") + statDelta(k) + " from armour"
                    : ""}
                  value={readOnlySoldier ? (stats ? stats[k] : 0) : current.stats[k]}
                  on:change={(e) => {
                    if (readOnlySoldier) return;
                    current.stats[k] = +e.target.value || 0;
                    persist();
                  }}
                />
                <!-- Always rendered, so a stat with no cap does not let the
                     row above it collapse and knock the column out. -->
                <span class="dmg-cap dmg-statcap">{caps[k] ? "/ " + caps[k] : ""}</span>
              </label>
            {/each}
            {#if readOnlySoldier}
              <p class="dmg-hint">
                As they fight: from the save, with transformation and commendation
                bonuses and the armour worn. Copy to manual to change them.
              </p>
              <button class="dmg-mini dmg-wide" on:click={copyToManual}>
                Copy to manual
              </button>
            {:else}
              <p class="dmg-hint">
                Values may exceed the cap — armour and commendation bonuses genuinely do.
              </p>
            {/if}
          {/if}

          {#if current.fromSave && current.armor != current.fromSave.wornArmor}
            <p class="dmg-hint">
              Trying a different armour — worn in the save:
              {@html current.fromSave.wornArmor
                ? rul.tr(current.fromSave.wornArmor)
                : "none"}.
              <button
                class="dmg-mini"
                on:click={() => setArmor(current.fromSave.wornArmor)}>Reset</button
              >
            </p>
          {:else if current.armor && stats}
            <p class="dmg-hint">Shown stats include the armour's bonuses.</p>
          {/if}

          <div class="dmg-io">
            <button
              class="dmg-mini"
              on:click={() => download("xpedia-soldiers.json", exportSoldiers(soldiers))}
              >Export</button
            >
            <label class="dmg-mini dmg-file">
              Import
              <input type="file" accept="application/json,.json" on:change={onImport} />
            </label>
          </div>
          {#if importError}<p class="dmg-error">{importError}</p>{/if}
        {/if}
      </section>

      <section class="dmg-block">
        <header title={SHOT_TITLE}>Engagement</header>

        <div class="dmg-chips" title={LIGHT_TITLE}>
          <button class="dmg-chip" class:dmg-chip-on={isDay} on:click={() => (isDay = true)}>
            Day
          </button>
          <button class="dmg-chip" class:dmg-chip-on={!isDay} on:click={() => (isDay = false)}>
            Night
          </button>
        </div>

        {#if sight}
          <p class="dmg-cap dmg-sight" title={sightNote(sight)}>
            Spots this enemy at <b>{sight.tiles}</b>
            {sight.tiles == 1 ? "tile" : "tiles"}
            <button
              class="dmg-mini dmg-sightmore"
              title="Show every visibility value on both armours"
              on:click={() => (showSight = !showSight)}>{showSight ? "hide" : "why"}</button
            >
          </p>
          {#if showSight}
            <div class="dmg-sightbox">
              <p class="dmg-hint">{sightNote(sight)}</p>
              {#if sight.fields.length}
                <table class="dmg-sighttab">
                  <tbody>
                    {#each sight.fields as f}
                      <tr class:dmg-sightunused={!f.used} title={f.note}>
                        <td>{f.side}</td>
                        <td>{f.label}</td>
                        <td class="num">{f.value}</td>
                        <td>{f.used ? "used" : "not modelled"}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {:else}
                <p class="dmg-hint">Neither armour states any visibility value.</p>
              {/if}
              <p class="dmg-hint">
                Mod ceiling <code>maxViewDistance: {maxViewDistance()}</code>. Unset dark
                visibility falls back to 9 for a player unit.
              </p>
            </div>
          {/if}
        {/if}

        <label class="dmg-row" title={RANGE_TITLE}>
          <span>Range</span>
          <input class="dmg-input dmg-num" type="number" min="0" bind:value={distance} />
          <span class="dmg-cap">tiles</span>
        </label>
        <label class="dmg-row" title={APPR_TITLE}>
          <span>Walk</span>
          <input class="dmg-input dmg-num" type="number" min="0" bind:value={tuPerTile} />
          <span class="dmg-cap">TU/tile</span>
        </label>
        <label class="dmg-row" title={FREE_TITLE}>
          <span>Free</span>
          <input class="dmg-input dmg-num" type="number" min="0" bind:value={freeTiles} />
          <span class="dmg-cap">tiles</span>
        </label>
        <p class="dmg-hint" title={RANGE_TITLE}>
          <b>Range</b> is the cutoff: reach it and APPR is nothing, fall short and you pay
          <b>(Range − reach) × Walk</b> to close. Melee walks the lot. Sight above is shown
          but does not feed APPR yet.
        </p>
        <label class="dmg-row">
          <span>Hitting</span>
          <select class="dmg-input" bind:value={side}>
            {#each SIDES as s}<option value={s}>{s}</option>{/each}
          </select>
        </label>
        <label class="dmg-check"><input type="checkbox" bind:checked={kneeling} /> Kneeling</label>
        <label class="dmg-check"><input type="checkbox" bind:checked={oneHanded} /> One-handed</label>
        <label class="dmg-check"><input type="checkbox" bind:checked={noLOS} /> No line of sight</label>
        <label
          class="dmg-check"
          class:dmg-check-locked={forcedExtender != null}
          title={forcedExtender != null
            ? "This mod pins UFO Extender accuracy " +
              (forcedExtender ? "ON" : "OFF") +
              " through fixedUserOptions, which OXCE honours over your options.cfg - so this is not a choice you have in game."
            : "On: snap and auto fall off past their own short ranges. Off: every mode is judged against the AIMED range instead - which is not the same as no falloff. The minimum-range penalty applies either way."}
        >
          <input
            type="checkbox"
            bind:checked={ufoExtender}
            disabled={forcedExtender != null}
          />
          Range falloff
          {#if forcedExtender != null}
            <span class="dmg-cap">(forced {forcedExtender ? "on" : "off"} by mod)</span>
          {/if}
        </label>
        <label class="dmg-row">
          <span>Goal</span>
          <select
            class="dmg-input"
            title="Take down: health runs out OR stun exceeds the health that is left - the two add, which is why a rifle with ToStun can drop a target that the health damage alone would not. Kill outright: health damage only. Capture: stun only, for taking one alive."
            bind:value={goal}
          >
            <option value="drop">Take down</option>
            <option value="kill">Kill outright</option>
            <option value="stun">Capture (stun only)</option>
          </select>
        </label>
        <label class="dmg-row">
          <span>Pellets</span>
          <select
            class="dmg-input"
            title="Shotguns only. Whether scattered pellets are assumed to land. OXCE traces each pellet through voxels against the target's model, so this is an assumption rather than a calculation."
            bind:value={pelletModel}
          >
            <option value="derived">By spread</option>
            <option value="all">All hit</option>
            <option value="first">First only</option>
          </select>
        </label>
      </section>

      {#if view == "weapons"}
        <section class="dmg-block">
          <header>
            Mission
            {#if missionId}
              <button
                class="dmg-mini"
                title="Show every enemy again"
                on:click={() => {
                  missionId = "";
                  missionFilter = "";
                }}>✕</button
              >
            {/if}
          </header>
          <input
            class="dmg-input"
            placeholder="Search missions…"
            bind:value={missionFilter}
          />
          <select class="dmg-input dmg-list" size="6" bind:value={missionId}>
            <option value="">(any mission — all enemies)</option>
            {#each shownMissions.slice(0, 400) as m}
              <option value={m.id}>{@html m.title} ({m.count})</option>
            {/each}
          </select>
          {#if missionId}
            <p class="dmg-cap">
              Enemies resolved from the deployment's ranks, its reinforcement
              waves and any follow-on stage. Script-spawned units and separate
              hunt missions are not included.
            </p>
          {/if}
        </section>

        <section class="dmg-block">
          <header>Enemy</header>
          <input
            class="dmg-input"
            placeholder="Filter enemies… (comma-separate)"
            title="Separate several with commas to line them up together"
            bind:value={targetFilter}
          />
          <select class="dmg-input dmg-list" size="12" bind:value={targetId}>
            {#each shownTargets.slice(0, 400) as t}
              <option value={t.id}>{@html t.title}</option>
            {/each}
          </select>
        </section>
      {:else}
        <section class="dmg-block">
          <header>Weapon</header>
          <input class="dmg-input" placeholder="Search weapons…" bind:value={weaponFilter} />
          <select class="dmg-input dmg-list" size="12" bind:value={weaponId}>
            {#each shownWeapons.slice(0, 400) as w}
              <option value={w.id}>{@html w.title}</option>
            {/each}
          </select>
        </section>
      {/if}
    </aside>

    <main class="dmg-main">
      {#if !current}
        <p class="dmg-empty">Loading…</p>
      {:else if view == "weapons"}
        {#if !target}
          <p class="dmg-empty">Pick an enemy on the left to rank every weapon against it.</p>
        {:else}
          <div class="dmg-target">
            <h2>{@html target.title}</h2>
            <div class="dmg-target-stats">
              {#if target.health}<span><b>{target.health}</b> HP</span>{/if}
              <span class="dmg-armors">
                {#each SIDES as sd}
                  <span class="dmg-armor" class:dmg-armor-on={sd == side}>
                    {sd}
                    <b>{armorValue(target, sd)}</b>
                  </span>
                {/each}
              </span>
              {#if targetStats.length}
                <span class="dmg-ustats">
                  {#each targetStats as st}<span>{st}</span>{/each}
                </span>
              {/if}
            </div>

            {#if resistances.length}
              <div class="dmg-resists">
                <span class="dmg-resist-label" title="Click a resistance to show only weapons of that type"
                  >Resistances</span
                >
                {#each resistances as r}
                  <button
                    class="dmg-resist dmg-resist-pick"
                    class:dmg-resist-weak={r.pct > 100}
                    class:dmg-resist-strong={r.pct < 100}
                    class:dmg-immune={r.pct == 0}
                    class:dmg-resist-on={dtFilters.includes(r.i)}
                    title={(dtFilters.includes(r.i) ? "Showing" : "Show") +
                      " only weapons that deal this damage type" +
                      (dtCount[r.i] ? " (" + dtCount[r.i] + " of them)" : " - none in the list") +
                      (dtFilters.includes(r.i) ? ". Click to drop it." : ". Click to add it.")}
                    on:click={() => toggleDt(r.i)}
                  >
                    {@html r.name}
                    <b>{r.pct}%</b>
                  </button>
                {/each}
                {#if dtFilters.length}
                  <button
                    class="dmg-chip"
                    title="Show every damage type again"
                    on:click={() => (dtFilters = [])}
                  >
                    Clear types <span class="dmg-chip-n">✕</span>
                  </button>
                {/if}
              </div>
            {/if}
            {#if mission}
              <div class="dmg-missionbar">
                <span class="dmg-missiontag">Mission</span>
                <b>{@html mission.title}</b>
                {#if mission.unresolved}
                  <span class="dmg-cap"
                    >faction varies — the ruleset does not say who runs this one, so the
                    enemy list is not filtered</span
                  >
                {:else}
                  <span class="dmg-cap">{mission.count} possible enemies</span>
                {/if}
                <button
                  class="dmg-mini"
                  title="Troop rows for this deployment: how many, and how many start outside the craft or building"
                  on:click={() => (showDeployment = !showDeployment)}
                >
                  {showDeployment ? "Hide" : "Show"} deployment
                </button>
              </div>

              {#if showDeployment}
                <table class="dmg-deploy">
                  <thead>
                    <tr>
                      <td>Spawns</td>
                      <td class="num">Qty</td>
                      <td
                        class="num"
                        title="Share of this group placed away from the craft or building, rather than inside it"
                        >% outside</td
                      >
                      <td>When</td>
                    </tr>
                  </thead>
                  <tbody>
                    {#each deploymentRows as r}
                      <tr>
                        <td>
                          {#if r.units.length}
                            {@html r.units.map((u) => rul.tr(u)).join(", ")}
                          {:else}
                            <span class="dmg-cap">unknown — faction not fixed</span>
                          {/if}
                        </td>
                        <td class="num">
                          {r.low == r.high ? r.low : r.low + "–" + r.high}
                        </td>
                        <td class="num" class:dmg-outofrange={r.outside >= 50}>
                          {r.outside}%
                        </td>
                        <td class="dmg-cap">
                          {r.reinforcement ? "reinforcement" : "start"}{r.stage
                            ? " · " + r.stage
                            : ""}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            {/if}

            {#if target.shield}
              <p class="dmg-warn">
                ⚠ This enemy has an energy shield ({target.shield.capacity} capacity,
                +{target.shield.perTurn}/turn). Shields sit in front of armour and are
                not modelled — everything below is what you would do once the shield is
                already down.
              </p>
            {/if}
          </div>

          <div class="dmg-filters">
            <input
              class="dmg-input dmg-search"
              placeholder="Search weapons… (comma-separate to compare)"
              title="Type part of a name. Separate several with commas - &quot;saber, cutlass&quot; shows both, side by side for this soldier."
              bind:value={weaponFilter}
            />
            <button
              class="dmg-chip dmg-demo"
              class:dmg-chip-on={excludeDemo}
              title={DEMO_TITLE}
              on:click={() => (excludeDemo = !excludeDemo)}>Exclude demo</button
            >
            <div class="dmg-chips">
              {#each KINDS as k}
                {#if k.id == "all" || kindCounts[k.id] || kindFilter == k.id}
                  <button
                    class="dmg-chip"
                    class:dmg-chip-on={kindFilter == k.id}
                    on:click={() => (kindFilter = k.id)}
                  >
                    {k.label}
                    <span class="dmg-chip-n">{kindCounts[k.id] || 0}</span>
                  </button>
                {/if}
              {/each}
            </div>
            <div class="dmg-chips">
              {#each HANDS as h}
                {#if h.id == "all" || handsCounts[h.id] || handsFilter == h.id}
                  <button
                    class="dmg-chip"
                    class:dmg-chip-on={handsFilter == h.id}
                    title={h.title}
                    on:click={() => (handsFilter = h.id)}
                  >
                    {h.label}
                    <span class="dmg-chip-n">{handsCounts[h.id] || 0}</span>
                  </button>
                {/if}
              {/each}
            </div>

            <select
              class="dmg-input dmg-dtpick"
              title="Filter by the mod's own weapon types - pistols, shotguns, rifles and so on. Pick several to combine them."
              bind:value={catPick}
              on:change={() => {
                if (catPick != "all") toggleCat(catPick);
                catPick = "all";
              }}
            >
              <option value="all">
                {catFilters.length ? "Add a weapon type…" : "Any weapon type"}
              </option>
              {#each catOptions as c}
                <option value={c.id}>
                  {catFilters.includes(c.id) ? "✓ " : ""}{@html c.label} ({c.n})
                </option>
              {/each}
            </select>

            {#each catFilters as c}
              <button
                class="dmg-chip dmg-chip-on"
                title="Click to stop filtering by this weapon type"
                on:click={() => toggleCat(c)}
              >
                {@html rul.tr(c)}
                <span class="dmg-chip-n">✕</span>
              </button>
            {/each}

            <!-- Adds to the same list the resistance chips drive, and resets, so
                 the two controls can never disagree. It is still the only way to
                 reach a type the enemy is neutral to: those have no chip, because
                 a flat 100% is not a resistance worth listing. -->
            <select
              class="dmg-input dmg-dtpick"
              title="Add a damage type to the filter. The enemy's resistance chips above do the same thing."
              bind:value={dtPick}
              on:change={() => {
                if (dtPick != "all") toggleDt(dtPick);
                dtPick = "all";
              }}
            >
              <option value="all">
                {dtFilters.length ? "Add a damage type…" : "Any damage type"}
              </option>
              {#each dtOptions as d}
                <option value={d.id}>
                  {dtFilters.includes(+d.id) ? "✓ " : ""}{@html d.label} ({d.n})
                </option>
              {/each}
            </select>

            {#each dtFilters as t}
              <button
                class="dmg-chip dmg-chip-on"
                title="Click to stop filtering by this damage type"
                on:click={() => toggleDt(t)}
              >
                {@html rul.tr(damageTypes[t] || "type " + t)}
                <span class="dmg-chip-n">✕</span>
              </button>
            {/each}

            <label class="dmg-check dmg-inline">
              <input type="checkbox" bind:checked={includeFixed} />
              Vehicle &amp; built-in
            </label>
            {#if isDefaultSort}
              <span class="dmg-sortnote">sorted by effectiveness</span>
            {:else}
              <span class="dmg-sortnote">sorted by</span>
              {#each sortKeys as k, i}
                <button
                  class="dmg-chip dmg-sortkey"
                  title="Click to remove this sort key"
                  on:click={() => dropSortKey(k.id)}
                >
                  {i + 1}. {colById(k.id).label}
                  {k.desc ? "▼" : "▲"}
                  <span class="dmg-chip-n">✕</span>
                </button>
              {/each}
              <button class="dmg-chip" title="Back to most-effective-first" on:click={resetSort}
                >Most effective</button
              >
            {/if}
            {#if weaponFilter || kindFilter != "all" || handsFilter != "all" || dtFilters.length || catFilters.length || includeFixed}
              <button
                class="dmg-chip"
                on:click={() => {
                  weaponFilter = "";
                  kindFilter = "all";
                  handsFilter = "all";
                  dtFilters = [];
                  dtPick = "all";
                  catFilters = [];
                  catPick = "all";
                  includeFixed = false;
                }}>Clear filters</button
              >
            {/if}
          </div>

          <table class="dmg-table">
            <thead>
              <tr>
                {#each COLUMNS as c}
                  <td
                    class="dmg-sortable"
                    class:dmg-sorted={sortIndex(sortKeys, c.id) != -1}
                    title={(c.title || "Sort by " + c.label) +
                      " — click again to reverse, click another column to add it as a tiebreak"}
                    on:click={() => sortBy(c.id)}
                  >
                    {c.label}{#if sortIndex(sortKeys, c.id) != -1}<span class="dmg-arrow"
                        >{sortKeys[sortIndex(sortKeys, c.id)].desc ? "▼" : "▲"}{#if sortKeys.length > 1}<sup
                            >{sortIndex(sortKeys, c.id) + 1}</sup
                          >{/if}</span
                      >{/if}
                  </td>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rows.slice(0, 400) as row (row.id)}
                <tr
                  class="dmg-click"
                  class:dmg-group-first={row.first}
                  class:dmg-open={expandedId == row.weapon.id}
                  on:click={() =>
                    (expandedId = expandedId == row.weapon.id ? "" : row.weapon.id)}
                >
                  <!-- The weapon's verdict beside its name, each mode's own
                       score dimmed on the rows below it. -->
                  <td
                    class="num dmg-score"
                    class:dmg-score-sub={!row.first}
                    class:dmg-score-good={scoreBand(scoreOf(row)) == "good"}
                    class:dmg-score-fair={scoreBand(scoreOf(row)) == "fair"}
                    class:dmg-score-poor={scoreBand(scoreOf(row)) == "poor"}
                    class:dmg-score-none={scoreBand(scoreOf(row)) == "none"}
                    title={scoreNote(row)}
                  >
                    {scoreOf(row) == null ? "?" : scoreOf(row)}
                  </td>
                  <td class="dmg-name">
                    {#if row.first}
                      {@html row.weapon.title}
                      {#if availMode != "off" && availability.get(row.weapon.id)}
                        {@const av = availability.get(row.weapon.id)}
                        <span
                          class="dmg-avail"
                          class:dmg-avail-dry={!av.ammoOwned}
                          title={availabilityNote(av)}
                        >
                          {#if av.owned}×{av.count}{:else if av.buyable}buy{:else}build{/if}{#if !av.ammoOwned}
                            ⚠{/if}
                        </span>
                      {/if}
                      {#if row.modeCount > 1}
                        <span class="dmg-modecount">{row.modeCount} modes</span>
                      {/if}
                    {/if}
                  </td>
                  <td class="num dmg-cap">
                    {#if row.first}
                      {+row.weapon.item.invWidth || 1}×{+row.weapon.item.invHeight || 1}
                    {/if}
                  </td>
                  <td class:dmg-submode={!row.first}>{row.mode.label}</td>
                  <td class="num">
                    {n(row.mode.damage.min, 0)}–{n(row.mode.damage.max, 0)}<span
                      class="dmg-resist"
                      class:dmg-immune={row.mode.damage.resist == 0}
                      title={RESIST_TITLE}
                      >&nbsp;({Math.round(row.mode.damage.resist * 100)}%)</span
                    >{#if row.mode.damage.hitsPerAttack > 1}<span
                        class="dmg-hits"
                        title="{row.mode.damage.hitsPerAttack} projectiles fired, about {n(
                          row.mode.damage.expectedHitsPerAttack,
                          1
                        )} assumed to land"
                        >×{row.mode.damage.hitsPerAttack}{#if row.mode.damage.expectedHitsPerAttack < row.mode.damage.hitsPerAttack - 0.05}<span
                            class="dmg-landed"
                            >→{n(row.mode.damage.expectedHitsPerAttack, 1)}</span
                          >{/if}</span
                      >{/if}
                  </td>
                  <td
                    class="num"
                    class:dmg-outofrange={outOfRange(row.mode)}
                    class:dmg-offrange={!rangeGoverns(row.mode)}
                    title={rangeNote(row.mode)}
                  >
                    {row.mode.attack.range == null ? "–" : n(row.mode.attack.range, 0)}
                  </td>
                  <td class="num">{Math.round(row.mode.accuracy)}%</td>
                  <td class="num">{Math.round(row.mode.hitRate * 100)}%</td>
                  <td class="num">{n(row.mode.perAttack)}</td>
                  <td class="num" title={APPR_TITLE}>
                    {row.mode.approachTu > 0 ? n(row.mode.approachTu, 0) : "–"}
                  </td>
                  <td class="num">
                    {row.mode.attacksToKill == null ? "–" : n(row.mode.attacksToKill)}
                  </td>
                  <td class="num dmg-key">
                    {row.mode.tuToKill == null ? "–" : n(row.mode.tuToKill, 0)}
                  </td>
                  <td class="num" title={turnsNote(row.mode)}>{turnsLabel(row.mode)}</td>
                </tr>

                {#if expandedId == row.weapon.id && row.last}
                  <tr class="dmg-detail">
                    <td colspan={COLUMNS.length}>
                      <table class="dmg-modes">
                        <thead>
                          <tr>
                            <td title="0-100; 50 is one full turn of this soldier's TU">Score</td>
                            <td>Mode</td><td>Power</td><td>Roll</td><td>After armour</td>
                            <td title="Shots that HIT and still did nothing - the roll came in at or below the armour, so no damage got through. Misses are not counted here; that is the Acc column. Worth watching because a healthy average can hide a weapon most of whose shots bounce off.">Bounces</td><td>Shots</td><td title="Projectiles assumed to land on the target">Land</td><td>Acc</td><td title={HIT_TITLE}>Hit%</td>
                            <td>TU</td><td>Per attack</td>
                            <td title="Armour stripped per attack: ToArmorPre off the roll plus ToArmor off what got through">Armour↓</td>
                            <td>Attacks</td><td>Turns</td>
                          </tr>
                        </thead>
                        <tbody>
                          {#each row.weapon.modes as m}
                            <tr>
                              <td
                                class="num dmg-score"
                                class:dmg-score-good={scoreBand(m.score) == "good"}
                                class:dmg-score-fair={scoreBand(m.score) == "fair"}
                                class:dmg-score-poor={scoreBand(m.score) == "poor"}
                                class:dmg-score-none={scoreBand(m.score) == "none"}
                                title={scoreNote({ mode: m, first: false })}
                                >{m.score == null ? "?" : m.score}</td
                              >
                              <td>{m.label}</td>
                              <td class="num">{n(m.damage.power, 0)}</td>
                              <td class="num"
                                >{n(m.damage.rollMin, 0)}–{n(m.damage.rollMax, 0)}</td
                              >
                              <td class="num">{n(m.damage.min, 0)}–{n(m.damage.max, 0)}</td>
                              <td class="num" class:dmg-immune={m.damage.pZero > 0.5}>
                                {pct(m.damage.pZero)}
                              </td>
                              <td class="num">{m.damage.hitsPerAttack}</td>
<td class="num">{n(m.damage.expectedHitsPerAttack, 1)}</td>
                              <td class="num">{Math.round(m.accuracy)}%</td>
                              <td class="num">{Math.round(m.hitRate * 100)}%</td>
                              <td class="num">{n(m.tuCost, 0)}</td>
                              <td class="num">{n(m.perAttack)}</td>
                              <td class="num" title={armourNote(m)}
                                >{m.armorPerAttack > 0.05 ? n(m.armorPerAttack) : "–"}</td
                              >
                              <td class="num"
                                >{m.attacksToKill == null ? "–" : n(m.attacksToKill)}</td
                              >
                              <td class="num dmg-key" title={turnsNote(m)}>{turnsLabel(m)}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                      <p class="dmg-hint">
                        {@html row.weapon.best.damage.damageTypeName
                          ? rul.tr(row.weapon.best.damage.damageTypeName)
                          : ""}
                        · armour {n(row.weapon.best.damage.effectiveArmor, 0)} effective
                        after ArmorEffectiveness · resistance applied before armour
                      </p>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}
      {:else if !weapon}
        <p class="dmg-empty">Pick a weapon on the left to see how it fares against each enemy.</p>
      {:else}
        <div class="dmg-target">
          <h2>{@html weapon.title}</h2>
          <div class="dmg-target-stats">
            <span>{byTarget.length} enemies</span>
            <span>at {distance} tiles, {side}</span>
            {#if tIsDefaultSort}
              <span class="dmg-sortnote">sorted by effectiveness</span>
            {:else}
              <span class="dmg-sortnote">sorted by</span>
              {#each tSortKeys as k, i}
                <button
                  class="dmg-chip dmg-sortkey"
                  title="Click to remove this sort key"
                  on:click={() => tDropSortKey(k.id)}
                >
                  {i + 1}. {tcolById(k.id).label}
                  {k.desc ? "▼" : "▲"}
                  <span class="dmg-chip-n">✕</span>
                </button>
              {/each}
              <button class="dmg-chip" on:click={tResetSort}>Most effective</button>
            {/if}
          </div>
        </div>

        <table class="dmg-table">
          <thead>
            <tr>
              {#each TCOLUMNS as c}
                <td
                  class="dmg-sortable"
                  class:dmg-sorted={sortIndex(tSortKeys, c.id) != -1}
                  title={(c.title || "Sort by " + c.label) +
                    " — click again to reverse, click another column to add it as a tiebreak"}
                  on:click={() => tSortBy(c.id)}
                >
                  {c.label}{#if sortIndex(tSortKeys, c.id) != -1}<span class="dmg-arrow"
                      >{tSortKeys[sortIndex(tSortKeys, c.id)].desc ? "▼" : "▲"}{#if tSortKeys.length > 1}<sup
                          >{sortIndex(tSortKeys, c.id) + 1}</sup
                        >{/if}</span
                    >{/if}
                </td>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each targetRows.slice(0, 400) as row (row.id)}
              <tr
                class="dmg-click"
                class:dmg-group-first={row.first}
                class:dmg-open={expandedTargetId == row.target.id}
                on:click={() =>
                  (expandedTargetId =
                    expandedTargetId == row.target.id ? "" : row.target.id)}
              >
                <td
                  class="num dmg-score"
                  class:dmg-score-sub={!row.first}
                  class:dmg-score-good={scoreBand(scoreOf(row)) == "good"}
                  class:dmg-score-fair={scoreBand(scoreOf(row)) == "fair"}
                  class:dmg-score-poor={scoreBand(scoreOf(row)) == "poor"}
                  class:dmg-score-none={scoreBand(scoreOf(row)) == "none"}
                  title={scoreNote(row)}
                >
                  {scoreOf(row) == null ? "?" : scoreOf(row)}
                </td>
                <td class="dmg-name">
                  {#if row.first}
                    {@html row.target.title}
                    {#if row.modeCount > 1}
                      <span class="dmg-modecount">{row.modeCount} modes</span>
                    {/if}
                  {/if}
                </td>
                <td class="num">{row.first ? armorValue(row.target, side) : ""}</td>
                <td class="num">{row.first ? row.target.health || "–" : ""}</td>
                <td class:dmg-submode={!row.first}>{row.mode.label}</td>
                <td class="num">
                  {n(row.mode.damage.min, 0)}–{n(row.mode.damage.max, 0)}<span
                    class="dmg-resist"
                    class:dmg-immune={row.mode.damage.resist == 0}
                    title={RESIST_TITLE}
                    >&nbsp;({Math.round(row.mode.damage.resist * 100)}%)</span
                  >{#if row.mode.damage.hitsPerAttack > 1}<span
                      class="dmg-hits"
                      title="{row.mode.damage.hitsPerAttack} projectiles per attack, each rolled and armour-checked separately"
                      >×{row.mode.damage.hitsPerAttack}</span
                    >{/if}
                </td>
                <td class="num" class:dmg-outofrange={outOfRange(row.mode)}>
                  {Math.round(row.mode.accuracy)}%
                </td>
                <td class="num" class:dmg-outofrange={outOfRange(row.mode)}>
                  {Math.round(row.mode.hitRate * 100)}%
                </td>
                <td class="num">{n(row.mode.perAttack)}</td>
                <td class="num" title={APPR_TITLE}>
                  {row.mode.approachTu > 0 ? n(row.mode.approachTu, 0) : "–"}
                </td>
                <td class="num dmg-key">
                  {row.mode.tuToKill == null ? "–" : n(row.mode.tuToKill, 0)}
                </td>
                <td class="num" title={turnsNote(row.mode)}>{turnsLabel(row.mode)}</td>
              </tr>

              {#if expandedTargetId == row.target.id && row.last}
                <tr class="dmg-detail">
                  <td colspan={TCOLUMNS.length}>
                    <div class="dmg-target-stats">
                      <span class="dmg-armors">
                        {#each SIDES as sd}
                          <span class="dmg-armor" class:dmg-armor-on={sd == side}>
                            {sd}
                            <b>{armorValue(row.target, sd)}</b>
                          </span>
                        {/each}
                      </span>
                      {#if row.target.shield}
                        <span class="dmg-immune">
                          shield {row.target.shield.capacity} (not modelled)
                        </span>
                      {/if}
                    </div>

                    {#if resistsOf(row.target).length}
                      <div class="dmg-resists">
                        <span class="dmg-resist-label">Resistances</span>
                        {#each resistsOf(row.target) as r}
                          <span
                            class="dmg-resist"
                            class:dmg-resist-weak={r.pct > 100}
                            class:dmg-resist-strong={r.pct < 100}
                            class:dmg-immune={r.pct == 0}
                          >
                            {@html r.name}
                            <b>{r.pct}%</b>
                          </span>
                        {/each}
                      </div>
                    {/if}

                    <table class="dmg-modes">
                      <thead>
                        <tr>
                          <td>Mode</td><td>Power</td><td>Roll</td><td>After armour</td>
                          <td title="Shots that HIT and still did nothing - the roll came in at or below the armour, so no damage got through. Misses are not counted here; that is the Acc column. Worth watching because a healthy average can hide a weapon most of whose shots bounce off.">Bounces</td><td>Shots</td><td title="Projectiles assumed to land on the target">Land</td><td>Range</td><td>Acc</td><td title={HIT_TITLE}>Hit%</td>
                          <td>TU</td><td>Per attack</td><td>Attacks</td><td>Turns</td>
                        </tr>
                      </thead>
                      <tbody>
                        {#each row.result.modes as m}
                          <tr>
                            <td>{m.label}</td>
                            <td class="num">{n(m.damage.power, 0)}</td>
                            <td class="num"
                              >{n(m.damage.rollMin, 0)}–{n(m.damage.rollMax, 0)}</td
                            >
                            <td class="num">{n(m.damage.min, 0)}–{n(m.damage.max, 0)}</td>
                            <td class="num" class:dmg-immune={m.damage.pZero > 0.5}>
                              {pct(m.damage.pZero)}
                            </td>
                            <td class="num">{m.damage.hitsPerAttack}</td>
<td class="num">{n(m.damage.expectedHitsPerAttack, 1)}</td>
                            <td
                              class="num"
                              class:dmg-outofrange={outOfRange(m)}
                              class:dmg-offrange={!rangeGoverns(m)}
                              title={rangeNote(m)}
                            >
                              {m.attack.range == null ? "–" : n(m.attack.range, 0)}
                            </td>
                            <td class="num">{Math.round(m.accuracy)}%</td>
                              <td class="num">{Math.round(m.hitRate * 100)}%</td>
                            <td class="num">{n(m.tuCost, 0)}</td>
                            <td class="num">{n(m.perAttack)}</td>
                            <td class="num"
                              >{m.attacksToKill == null ? "–" : n(m.attacksToKill)}</td
                            >
                            <td class="num dmg-key" title={turnsNote(m)}>{turnsLabel(m)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                    <p class="dmg-hint">
                      {@html row.result.best.damage.damageTypeName
                        ? rul.tr(row.result.best.damage.damageTypeName)
                        : ""}
                      · armour {n(row.result.best.damage.effectiveArmor, 0)} effective
                      after ArmorEffectiveness · resistance applied before armour
                    </p>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    </main>
  </div>
</div>
