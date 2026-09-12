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
 * WHAT IT CANNOT SEE, and says so in the UI rather than pretending:
 *   - units spawned by script
 *   - `huntMissionWeights` / `genMission`, which fire off separate missions
 *   - items in the loot pool carrying `spawnUnit` (a parrot, a turret)
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

/** Rebuild the indexes; only needed if the ruleset is reloaded. */
export function resetMissionIndexes() {
  byWaveUfo = null;
  byNextStage = null;
  bySiteType = null;
}

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

/**
 * Every unit that can appear in a deployment, following `nextStage` chains.
 *
 * The visited set is not paranoia: stages chain several deep
 * (STR_LOC_MOON_NAZIS_2 -> STR_LOC_THULEBASE) and a malformed loop would
 * otherwise hang the page.
 */
export function missionUnits(id: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  let stage = id;

  while (stage && !seen.has(stage)) {
    seen.add(stage);
    const dep = rul.alienDeployments ? rul.alienDeployments[stage] : null;
    if (!dep) break;

    const races = racesFor(stage, dep);
    readRows(dep.data, races, out);
    for (const wave of Array.isArray(dep.reinforcements) ? dep.reinforcements : [])
      readRows(wave && wave.data, races, out);

    stage = typeof dep.nextStage == "string" ? dep.nextStage : "";
  }
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
  const out: MissionOption[] = [];
  for (const id of Object.keys(rul.alienDeployments || {})) {
    let units: Set<string>;
    let rows: MissionRow[];
    try {
      units = missionUnits(id);
      rows = missionRows(id);
    } catch (e) {
      continue;
    }
    // Only count units the calculator can actually target, so a mission does
    // not advertise five enemies and then filter the list down to nothing.
    let n = 0;
    for (const u of units) if (isTarget(u)) n++;

    if (n) {
      out.push({ id, title: rul.tr(id), count: n, unresolved: false });
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
     */
    if (!units.size && rows.length)
      out.push({ id, title: rul.tr(id), count: 0, unresolved: true });
  }
  return out.sort((a, b) => (a.title < b.title ? -1 : 1));
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

    stage = typeof dep.nextStage == "string" ? dep.nextStage : "";
  }
  return out;
}
