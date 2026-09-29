/**
 * Which enemies can turn up in a given mission.
 *
 * Nothing in the app resolved this before - the pedia dumps a deployment's raw
 * YAML, so `alienRank: 13` renders as the number 13 and you are left to cross
 * reference the race table by hand. This walks it properly.
 *
 * THE CHAIN. A deployment's `data[]` rows each name an `alienRank`, and that is
 * a 0-BASED INDEX into the race's `members` list - not a rank id, despite the
 * name. Resolving STR_LOC_THULEBASE (race STR_NAZIS): alienRank 13 is
 * members[13] = STR_CYBERDOG_TERRORIST, alienRank 9 is STR_NAZI_SUPERSOLDIER,
 * alienRank 3 is STR_NAZI_SS. A unit's own `rank:` field is a different axis
 * entirely and cannot be used for this - two units sharing rank
 * STR_LIVE_NAVIGATOR sit at members[3] and members[4].
 *
 * WHERE THE RACE COMES FROM. Only 23 of 489 deployments state a `race:`. The
 * rest inherit it from the mission of the same name, whose `raceWeights` is a
 * weighted table per in-game-time bucket - so the honest answer for those is
 * the UNION over every race in every bucket. A freighter raid really can be
 * crewed by Trans-Stellar or by smart zombies, and both belong in the list.
 *
 * THE OTHER HALF: THINGS THE TROOP TABLE NEVER MENTIONS. A deployment's data
 * rows are not the only things that shoot at you. Bandit Airfield fields four
 * 14mm turrets and not one of them appears in `data:` - they arrive down a
 * completely separate chain:
 *
 *   alienDeployments.STR_LOC_BANDIT_AIRFIELD .script = BANDIT_AIRFIELD
 *   mapScripts.BANDIT_AIRFIELD   -> addUFO: STR_UFO_TURRET_14MM   (x4)
 *   ufos.STR_UFO_TURRET_14MM     -> mapBlocks[].items
 *                                     STR_SPAWN_14MM_LIGHT_TURRET
 *   items.STR_SPAWN_14MM_LIGHT_TURRET .spawnUnit = STR_14MM_LIGHT_TURRET
 *
 * So the unit is placed by the MAP, through an item with a fuse on it, and the
 * deployment never names it. That is not an edge case - it is how every turret
 * emplacement, gun nest and pre-placed tank in the mod works. See mapSpawns.
 *
 * WHAT IT STILL CANNOT SEE, and says so in the UI rather than pretending:
 *   - units spawned by Yankes script (`spawnUnit` from a y-script hook)
 *   - `huntMissionWeights` / `genMission`, which fire off separate missions
 *   - which map blocks a random roll will actually pick, so a spawn that lives
 *     in a terrain's block pool is reported as "may appear" with no count
 * Reinforcement waves and `nextStage` follow-ons ARE included - they are the
 * same battle, and leaving them out would under-report what shoots at you.
 */
import { rul } from "./Ruleset";

export type MissionOption = {
  id: string;
  title: string;
  /** How many distinct units resolve, for the picker. */
  count: number;
  /**
   * The deployment has troop rows but no race can be pinned to it.
   *
   * These are the generic battlescapes - a terror site, a base defence, a sunken
   * wreck - that any faction can run, so the ruleset genuinely does not say who
   * turns up; the attacker decides at spawn time. They are still listed, because
   * "look up any mission" means any, but they filter nothing and say so.
   */
  unresolved: boolean;
  /**
   * How many deployment ids this one row stands for.
   *
   * XPiratez splits one fight across several ids to vary the SCENERY - terrain,
   * map script, briefing - while the garrison stays identical. Bandit Airfield
   * is two ids with the same seven enemies and a different map; "Guns of the
   * Patriots" is fifteen, one per country. Those are merged into a single row,
   * and this says how many were behind it.
   */
  variants: number;
};

/** One troop row of a deployment, for the breakdown panel. */
export type MissionRow = {
  /** Units this row can spawn, already resolved. */
  units: string[];
  low: number;
  high: number;
  /** Share of them placed outside the craft/building, 0-100. */
  outside: number;
  /** True when the row came from a reinforcement wave rather than the start. */
  reinforcement: boolean;
  /** Which stage of a multi-part battle this row belongs to. */
  stage: string;
  /**
   * Set when the row is a map-placed spawn rather than a troop row: the ids of
   * the pieces that carry it. Raw ids, translated by the caller - see
   * MapSpawn.from. Such rows have no `% outside`, and their quantity is a
   * placement count rather than a random range.
   */
  placedBy?: string[];
  /** For a placed row, whether the count is guaranteed or a maybe. */
  certain?: boolean;
};

/** The races named in one mission's weighted table, across every time bucket. */
function missionRaces(missionId: string): string[] {
  const mission = missionId && rul.alienMissions ? rul.alienMissions[missionId] : null;
  const weights = mission && mission.raceWeights;
  if (!weights || typeof weights != "object") return [];

  const out = new Set<string>();
  for (const bucket of Object.values<any>(weights)) {
    if (!bucket || typeof bucket != "object") continue;
    for (const race of Object.keys(bucket)) out.add(race);
  }
  return [...out];
}

/**
 * Reverse indexes, built once.
 *
 * `byWaveUfo` is the link that is easy to miss: a mission's waves name a `ufo`,
 * and for a ground site that id IS the deployment. STR_LOC_KEEP has no race and
 * no mission of its own name - it is reached from STR_MISSION_LOC_KEEP, whose
 * wave says `ufo: STR_LOC_KEEP` and whose raceWeights say STR_DOOM.
 *
 * `byNextStage` maps a deployment to the ones that lead INTO it, so a later
 * stage inherits the race of the battle that started it.
 */
let byWaveUfo: { [ufo: string]: string[] } = null;
let byNextStage: { [dep: string]: string[] } = null;
let bySiteType: { [dep: string]: string[] } = null;

function buildIndexes() {
  if (byWaveUfo && byNextStage && bySiteType) return;
  byWaveUfo = {};
  byNextStage = {};
  bySiteType = {};

  for (const id of Object.keys(rul.alienMissions || {})) {
    const mission = rul.alienMissions[id];
    // A site mission names its battlescape outright.
    const site = mission.siteType;
    if (typeof site == "string" && site)
      (bySiteType[site] = bySiteType[site] || []).push(id);

    const waves = mission.waves;
    if (!Array.isArray(waves)) continue;
    for (const w of waves) {
      const ufo = w && w.ufo;
      if (typeof ufo != "string" || !ufo) continue;
      (byWaveUfo[ufo] = byWaveUfo[ufo] || []).push(id);
    }
  }

  for (const id of Object.keys(rul.alienDeployments || {})) {
    const next = rul.alienDeployments[id].nextStage;
    if (typeof next != "string" || !next) continue;
    (byNextStage[next] = byNextStage[next] || []).push(id);
  }
}

/* No reset hook - see the note in techTree.ts. */

/**
 * The longest mission id that this deployment's id extends.
 *
 * XPiratez splits one mission into per-terrain deployments named
 * `<mission>_TEMPERATE` / `_JUNGLE` / `_COLD` / `_DESERT`, picked by the globe
 * texture the site lands on. Warehouse Wars is exactly this: the mission is
 * STR_LOC_GUILD_OUTPOST and holds the races, while the four deployments that
 * hold the ranks are all suffixed. The engine joins them through the globe's
 * texture table; matching on the name is the practical equivalent and it is
 * why the split variants resolve at all.
 */
function prefixMission(id: string): string {
  let best = "";
  for (const m of Object.keys(rul.alienMissions || {})) {
    if (m.length >= id.length || !id.startsWith(m) || id[m.length] != "_") continue;
    if (m.length > best.length) best = m;
  }
  return best;
}

/**
 * Every race a deployment can field, trying each link the mod actually uses.
 *
 * Ordered most to least direct. Anything earlier wins outright; the fallbacks
 * only run when a deployment would otherwise resolve to nothing.
 */
function racesFor(id: string, dep: any, depth = 0, seen: Set<string> = null): string[] {
  seen = seen || new Set();
  if (seen.has(id) || depth > 6) return [];
  seen.add(id);
  buildIndexes();

  // 1. Stated outright by the deployment.
  if (dep && typeof dep.race == "string" && dep.race) return [dep.race];

  // 2. The mission of the same name.
  const own = missionRaces(id);
  if (own.length) return own;

  // 3. A mission whose wave spawns this deployment by name.
  const viaWave = new Set<string>();
  for (const m of byWaveUfo[id] || []) for (const r of missionRaces(m)) viaWave.add(r);
  if (viaWave.size) return [...viaWave];

  // 4. A mission that names this deployment as its site.
  const viaSite = new Set<string>();
  for (const m of bySiteType[id] || []) for (const r of missionRaces(m)) viaSite.add(r);
  if (viaSite.size) return [...viaSite];

  // 5. The parent mission of a per-terrain variant.
  const viaPrefix = missionRaces(prefixMission(id));
  if (viaPrefix.length) return viaPrefix;

  // 6. Inherited from whatever battle leads into this stage.
  const viaParent = new Set<string>();
  for (const p of byNextStage[id] || [])
    for (const r of racesFor(p, rul.alienDeployments[p], depth + 1, seen)) viaParent.add(r);
  return [...viaParent];
}

/** The unit(s) a rank index maps to within one race. */
function unitsAtRank(race: string, rank: number, into: Set<string>) {
  const r = rul.alienRaces ? rul.alienRaces[race] : null;
  if (!r || !(rank >= 0)) return;

  // membersRandom[i] is a list of alternatives rolled per spawn; members[i] is
  // the single fallback. A race can define both, so take everything either can
  // produce - they are all units you might actually face.
  const random = r.membersRandom;
  if (Array.isArray(random) && Array.isArray(random[rank]))
    for (const u of random[rank]) if (typeof u == "string") into.add(u);

  const members = r.members;
  if (Array.isArray(members) && typeof members[rank] == "string")
    into.add(members[rank]);
}

/** Walk one deployment's data rows (and reinforcement rows, same shape). */
function readRows(rows: any[], races: string[], into: Set<string>) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row != "object") continue;
    // customUnitType names the unit outright and overrides the race lookup -
    // this is how the catgirl tourists arrive as reinforcements.
    if (typeof row.customUnitType == "string" && row.customUnitType) {
      into.add(row.customUnitType);
      continue;
    }
    const rank = +row.alienRank;
    if (isNaN(rank)) continue;
    for (const race of races) unitsAtRank(race, rank, into);
  }
}

/* ---- Units the map places, rather than the troop table ------------------ */

/**
 * Items that turn into a hostile unit, mapped to the unit they become.
 *
 * `spawnUnitFaction` is 0 player, 1 hostile, 2 neutral. Only hostile ones, and
 * ones that do not say, belong in an ENEMY list - a spawn item that produces a
 * civilian or one of your own would be a lie in this table. The ones that do
 * not say inherit the faction of whatever triggered them, which for a
 * map-placed item with a fuse is the hostile side.
 */
let spawnItems: { [item: string]: string } = null;

function buildSpawnItems() {
  if (spawnItems) return;
  spawnItems = {};
  for (const item of Object.values<any>(rul.items || {})) {
    const unit = item && item.spawnUnit;
    if (typeof unit != "string" || !unit) continue;
    const faction = item.spawnUnitFaction;
    if (faction === 0 || faction === 2) continue;
    spawnItems[item.id] = unit;
  }
}

/** Every spawn item placed in a set of map blocks, with how many of each. */
function blockSpawnItems(blocks: any): { [item: string]: number } {
  buildSpawnItems();
  const out: { [item: string]: number } = {};
  if (!blocks) return out;
  for (const block of Object.values<any>(blocks)) {
    if (!block || typeof block != "object") continue;
    // `items` is itemId -> list of positions, so the count is the list length.
    for (const [item, spots] of Object.entries<any>(block.items || {})) {
      if (!spawnItems[item]) continue;
      out[item] = (out[item] || 0) + (Array.isArray(spots) ? spots.length : 1);
    }
    // A randomised pile rolls ONE of its list, so nothing is guaranteed - it is
    // recorded at zero, which the UI reads as "may appear".
    for (const pick of Array.isArray(block.randomizedItems) ? block.randomizedItems : [])
      for (const item of (pick && pick.itemList) || [])
        if (spawnItems[item] && !out[item]) out[item] = 0;
  }
  return out;
}

/** The map blocks behind a terrain, a craft or a UFO named in a script. */
function blocksOf(name: string): any {
  if (typeof name != "string" || !name) return null;
  const terrain = (rul.terrains || {})[name];
  if (terrain && terrain.mapBlocks) return terrain.mapBlocks;
  for (const coll of ["ufos", "crafts"]) {
    const e = (rul[coll] || {})[name];
    const data = e && e.battlescapeTerrainData;
    if (data && data.mapBlocks) return data.mapBlocks;
  }
  return null;
}

export type MapSpawn = {
  unit: string;
  /** The item on the map that becomes it. */
  item: string;
  /** How many are placed for certain; 0 when it depends on a map roll. */
  qty: number;
  /**
   * The pieces that put it there, as RAW IDS.
   *
   * Not translated here on purpose: this result is memoised for the life of the
   * page, and the language can be switched at any time. Caching display strings
   * would leave the deployment table in whichever language it was first opened
   * in. The caller translates.
   */
  from: string[];
  /**
   * `emplacement` - the script always adds this piece, so the count is real.
   * `map` - it sits in a block pool the generator may or may not roll.
   */
  kind: "emplacement" | "map";
};

const mapSpawnCache = new Map<string, MapSpawn[]>();

/**
 * Units placed by the map for one deployment stage.
 *
 * Two routes, and they differ in how much they can promise. A script command
 * that names a piece outright - `addUFO: STR_UFO_TURRET_14MM` - always adds it,
 * so four such commands are four turrets and the number is worth printing. A
 * command that just draws from a terrain's block pool may or may not land on
 * the block holding the spawn, so those are reported without a count.
 */
export function mapSpawns(depId: string): MapSpawn[] {
  const cached = mapSpawnCache.get(depId);
  if (cached) return cached;

  const dep = (rul.alienDeployments || {})[depId];
  const out: MapSpawn[] = [];
  if (!dep) {
    mapSpawnCache.set(depId, out);
    return out;
  }

  buildSpawnItems();
  // item -> { qty, from, kind }. Merged by item so four addUFO commands read as
  // one row of four rather than four rows of one.
  const found = new Map<string, { qty: number; from: Set<string>; kind: "emplacement" | "map" }>();

  const take = (name: string, kind: "emplacement" | "map", placements: number) => {
    const blocks = blocksOf(name);
    if (!blocks) return;
    for (const [item, per] of Object.entries(blockSpawnItems(blocks))) {
      const qty = kind == "emplacement" ? per * placements : 0;
      const cur = found.get(item);
      if (cur) {
        cur.qty += qty;
        cur.from.add(name);
        // Anything guaranteed outranks a maybe.
        if (kind == "emplacement") cur.kind = "emplacement";
      } else {
        found.set(item, { qty, from: new Set([name]), kind });
      }
    }
  };

  // The deployment's own terrains: a block pool, so no counts.
  for (const t of Array.isArray(dep.terrains) ? dep.terrains : []) take(t, "map", 0);

  const script = (rul.mapScripts || {})[dep.script];
  const commands = script && Array.isArray(script.commands) ? script.commands : [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd != "object") continue;
    const runs = Math.max(1, +cmd.executions || 1);
    // A named piece is always added, so its count is real.
    for (const key of ["UFOName", "craftName"])
      if (typeof cmd[key] == "string" && cmd[key]) take(cmd[key], "emplacement", runs);
    // A terrain override only changes which pool the blocks come from.
    if (typeof cmd.terrain == "string" && cmd.terrain) take(cmd.terrain, "map", 0);
    for (const lvl of Array.isArray(cmd.verticalLevels) ? cmd.verticalLevels : []) {
      if (!lvl || typeof lvl != "object") continue;
      if (typeof lvl.UFOName == "string" && lvl.UFOName) take(lvl.UFOName, "emplacement", runs);
      if (typeof lvl.terrain == "string" && lvl.terrain) take(lvl.terrain, "map", 0);
    }
  }

  for (const [item, info] of found)
    out.push({
      unit: spawnItems[item],
      item,
      qty: info.qty,
      from: [...info.from],
      kind: info.kind,
    });

  out.sort((a, b) => b.qty - a.qty || (a.unit < b.unit ? -1 : 1));
  mapSpawnCache.set(depId, out);
  return out;
}

/* No reset hook. mapSpawnCache holds raw ids only, so a language change does
   not stale it; see MapSpawn.from and the note in techTree.ts. */

/**
 * Every unit that can appear in a deployment, following `nextStage` chains.
 *
 * The visited set is not paranoia: stages chain several deep
 * (STR_LOC_MOON_NAZIS_2 -> STR_LOC_THULEBASE) and a malformed loop would
 * otherwise hang the page.
 */
function walkStages(id: string, visit: (stage: string, dep: any) => void) {
  const seen = new Set<string>();
  let stage = id;
  while (stage && !seen.has(stage)) {
    seen.add(stage);
    const dep = rul.alienDeployments ? rul.alienDeployments[stage] : null;
    if (!dep) break;
    visit(stage, dep);
    stage = typeof dep.nextStage == "string" ? dep.nextStage : "";
  }
}

/**
 * Units from the deployment's own troop rows.
 *
 * Kept separate from the map-placed ones because "did the TROOP TABLE resolve"
 * is a different question from "does anything appear", and missionList needs
 * the first one: a deployment whose race cannot be pinned down is still worth
 * listing as "faction varies", and a turret bolted to its map must not be
 * allowed to answer that question for it.
 */
export function troopUnits(id: string): Set<string> {
  const out = new Set<string>();
  walkStages(id, (stage, dep) => {
    const races = racesFor(stage, dep);
    readRows(dep.data, races, out);
    for (const wave of Array.isArray(dep.reinforcements) ? dep.reinforcements : [])
      readRows(wave && wave.data, races, out);
  });
  return out;
}

/** Units the map places across every stage. Turrets, gun nests, pre-set tanks. */
export function placedUnits(id: string): Set<string> {
  const out = new Set<string>();
  walkStages(id, (stage) => {
    for (const s of mapSpawns(stage)) out.add(s.unit);
  });
  return out;
}

export function missionUnits(id: string): Set<string> {
  const out = troopUnits(id);
  for (const u of placedUnits(id)) out.add(u);
  return out;
}

/**
 * Missions worth offering: the ones that resolve to at least one unit you could
 * actually shoot at.
 *
 * Deployments are the collection to draw from rather than missions - they are
 * the only ones carrying the `data:` block that names ranks, and 296 of them
 * have no same-named mission at all (sub-stages, base assaults, craft
 * deployments), so keying on missions would lose most of the content.
 */
export function missionList(isTarget: (id: string) => boolean): MissionOption[] {
  /** One deployment before same-named ones are merged. `sig` is its content. */
  type Raw = MissionOption & { sig: string };
  const out: Raw[] = [];
  for (const id of Object.keys(rul.alienDeployments || {})) {
    let units: Set<string>;
    let troops: Set<string>;
    let rows: MissionRow[];
    try {
      troops = troopUnits(id);
      units = missionUnits(id);
      rows = missionRows(id);
    } catch (e) {
      // Dropping a deployment silently is how a resolver bug hides for months:
      // the mission simply is not in the list and nobody can tell whether the
      // ruleset or the code is at fault. Say which one it was.
      console.warn("[missions] skipped " + id + ":", e);
      continue;
    }
    // Only count units the calculator can actually target, so a mission does
    // not advertise five enemies and then filter the list down to nothing.
    let n = 0;
    for (const u of units) if (isTarget(u)) n++;

    /**
     * Everything the picker and the breakdown panel will show for this id.
     *
     * Two deployments are only merged when this matches exactly - units,
     * quantities, % outside, reinforcement flag, emplacements, the lot. Merging
     * on the enemy NAMES alone would have collapsed rows that field the same
     * units in different numbers, which is a real difference and not a
     * duplicate.
     */
    const sig = JSON.stringify(rows);

    if (n) {
      out.push({ id, title: rul.tr(id), count: n, unresolved: false, variants: 1, sig });
      continue;
    }
    /**
     * Two different reasons for zero, and only one of them belongs in the list.
     *
     * Nothing resolved at all, but the deployment has real troop rows: a
     * generic battlescape - terror site, base defence, sunken wreck - that any
     * faction can run, so the ruleset genuinely does not say who turns up.
     * Worth listing, and it filters nothing.
     *
     * Units resolved but none of them are targetable (no armour entry, an
     * excluded race): selecting it would show an empty enemy list, so it is
     * dropped. Calling that "faction varies" would be a plain lie - the faction
     * is known, its members just are not things you can shoot at here.
     *
     * The test is on the TROOP units, not on everything: the Zombie Pyramid has
     * four troop rows whose race cannot be pinned down and a map that places 39
     * sterile zombies, and judging it on the union would let those zombies
     * answer "is the faction known" - which they do not - and drop a mission
     * that belongs in the list.
     */
    if (!troops.size && rows.length)
      out.push({ id, title: rul.tr(id), count: 0, unresolved: true, variants: 1, sig });
  }
  return mergeVariants(out);
}

/**
 * The tokens every id in a group shares, as a prefix.
 *
 * Split on "_" rather than comparing characters: STR_X_ALPHA and STR_X_ALPINE
 * share the literal prefix "STR_X_ALP", and cutting there would label them "HA"
 * and "INE". Whole tokens give "ALPHA" and "ALPINE".
 */
function sharedPrefix(ids: string[]): string {
  const parts = ids.map((id) => id.split("_"));
  let n = 0;
  // `n < p.length`, not `p.length - 1`: when one id is a whole-token prefix of
  // the others - STR_VESSEL_FREIGHTER against ..._G and ..._L - reserving a
  // token for it backs the prefix off to STR_VESSEL and tags every row with
  // "Freighter" again. Letting it consume the short id entirely leaves that one
  // with an empty tag, which is exactly right: it is the base variant and keeps
  // the plain name.
  while (parts.every((p) => n < p.length && p[n] == parts[0][n])) n++;
  return parts[0].slice(0, n).join("_");
}

/** The part of `id` past the shared prefix, as readable words. */
function variantTag(id: string, prefix: string): string {
  const rest = id.slice(prefix.length).replace(/^_+/, "");
  if (!rest) return "";
  return rest
    .split("_")
    .filter((w) => w)
    // Initialisms stay shouting - "HQ", "L", "G" - while words get cased.
    .map((w) => (w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
}

/**
 * Collapse deployments that share a name AND resolve to exactly the same fight,
 * and tell the rest apart.
 *
 * 33 names in XPiratez cover 100 of the 488 deployments. 13 of those groups are
 * pure scenery variants - identical garrison, different map - and listing them
 * separately is 25 rows of noise you cannot choose between; "Guns of the
 * Patriots" alone is 15 identical entries. The other 20 are genuinely different
 * missions wearing one name: three "Freighter" rows crewed by Guild, Govt and
 * Guild again, two of them even showing the same enemy count. Those must stay
 * separate, so they get the distinguishing part of their id appended - the one
 * piece of text that actually differs.
 */
function mergeVariants(raw: (MissionOption & { sig: string })[]): MissionOption[] {
  const byTitle = new Map<string, (MissionOption & { sig: string })[]>();
  for (const r of raw) {
    const cur = byTitle.get(r.title);
    if (cur) cur.push(r);
    else byTitle.set(r.title, [r]);
  }

  const out: MissionOption[] = [];
  for (const [title, group] of byTitle) {
    const bySig = new Map<string, (MissionOption & { sig: string })[]>();
    for (const r of group) {
      const cur = bySig.get(r.sig);
      if (cur) cur.push(r);
      else bySig.set(r.sig, [r]);
    }

    // One distinct fight behind the name: one row, however many ids there were.
    if (bySig.size == 1) {
      out.push({ ...group[0], title, variants: group.length });
      continue;
    }

    const prefix = sharedPrefix(group.map((r) => r.id));
    for (const rs of bySig.values()) {
      // The bare id - the one with nothing past the prefix - keeps the plain
      // name; it is the base variant and inventing a label for it would be
      // noise. An em dash rather than brackets, so the picker's own "(12)"
      // enemy count stays the only thing in parentheses.
      const tag = rs.map((r) => variantTag(r.id, prefix)).find((t) => t) || "";
      out.push({ ...rs[0], title: tag ? title + " — " + tag : title, variants: rs.length });
    }
  }

  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * The deployment's troop table: who, how many, and how many start outside.
 *
 * `percentageOutsideUfo` is the share of that row placed away from the craft or
 * building - the difference between walking into a quiet warehouse and being
 * met in the open, which is worth seeing before you pick a loadout.
 */
export function missionRows(id: string): MissionRow[] {
  const out: MissionRow[] = [];
  const seen = new Set<string>();
  let stage = id;

  while (stage && !seen.has(stage)) {
    seen.add(stage);
    const dep = rul.alienDeployments ? rul.alienDeployments[stage] : null;
    if (!dep) break;
    const races = racesFor(stage, dep);
    const label = stage == id ? "" : rul.tr(stage);

    const push = (rows: any[], reinforcement: boolean) => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!row || typeof row != "object") continue;
        const units = new Set<string>();
        if (typeof row.customUnitType == "string" && row.customUnitType)
          units.add(row.customUnitType);
        else {
          const rank = +row.alienRank;
          if (isNaN(rank)) continue;
          for (const race of races) unitsAtRank(race, rank, units);
        }
        out.push({
          units: [...units],
          low: +row.lowQty || 0,
          high: +row.highQty || 0,
          outside: +row.percentageOutsideUfo || 0,
          reinforcement,
          stage: label,
        });
      }
    };

    push(dep.data, false);
    for (const wave of Array.isArray(dep.reinforcements) ? dep.reinforcements : [])
      push(wave && wave.data, true);

    // Emplacements. They belong in the same table as the troops - from the
    // player's side of the screen a turret is simply another thing shooting.
    for (const s of mapSpawns(stage))
      out.push({
        units: [s.unit],
        low: s.qty,
        high: s.qty,
        outside: 0,
        reinforcement: false,
        stage: label,
        placedBy: s.from,
        certain: s.kind == "emplacement" && s.qty > 0,
      });

    stage = typeof dep.nextStage == "string" ? dep.nextStage : "";
  }
  return out;
}
