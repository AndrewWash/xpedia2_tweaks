/**
 * PAX - the personnel manager.
 *
 * Modelled on Dwarf Therapist: the whole crew on one grid, every stat a cell,
 * and ROLES - weighted blends of stats scored against the rest of the crew -
 * so "who should carry the sniper rifle" is a sorted column rather than twenty
 * soldier screens held in your head.
 *
 * This module knows nothing about the UI. It turns the save's raw records into
 * rows, ranks them, scores roles, filters, and staffs squads.
 *
 * Three numbers per stat matter, and the game shows you one:
 *
 *   current            what the save says (plus traits and medals)
 *   trainingStatCaps   how far the gym can still take it - 0 means "not at all"
 *   statCaps           the hard ceiling for this soldier type
 */
import { rul } from "./Ruleset";
import { soldiersFromSave, effectiveStats } from "./damageSoldiers";
import type { Stats } from "./damageCalc";
import type { RawSoldier, SaveState } from "./damageSave";

/** Grid order: body, then guns, then hands, then voodoo. Short labels fit a cell. */
export const PAX_STATS: { k: string; ab: string; name: string }[] = [
  { k: "tu", ab: "TU", name: "Time Units" },
  { k: "stamina", ab: "STA", name: "Stamina" },
  { k: "health", ab: "HP", name: "Health" },
  { k: "bravery", ab: "BRV", name: "Bravery" },
  { k: "reactions", ab: "REA", name: "Reactions" },
  { k: "firing", ab: "FIR", name: "Firing" },
  { k: "throwing", ab: "THR", name: "Throwing" },
  { k: "melee", ab: "MEL", name: "Melee" },
  { k: "strength", ab: "STR", name: "Strength" },
  { k: "mana", ab: "FRS", name: "Freshness" },
  { k: "psiStrength", ab: "VPW", name: "Voodoo Power" },
  { k: "psiSkill", ab: "VSK", name: "Voodoo Skill" },
];
export const PAX_KEYS = PAX_STATS.map((s) => s.k);
export const STAT_NAME: { [k: string]: string } = {};
for (const s of PAX_STATS) STAT_NAME[s.k] = s.name;

/** OpenXcom's six ranks, used when a soldier type does not name its own. */
const DEFAULT_RANKS = [
  "STR_ROOKIE",
  "STR_SQUADDIE",
  "STR_SERGEANT",
  "STR_CAPTAIN",
  "STR_COLONEL",
  "STR_COMMANDER",
];

export type PaxRow = {
  /** Same id CENTCOM uses for the same soldier, so the two can hand off. */
  id: string;
  name: string;
  type: string;
  typeName: string;
  rank: number;
  rankName: string;
  base: string;
  craft: string;
  /** The armour being shown: what they wear, unless a sandbox pick replaced it. */
  armor: string;
  armorName: string;
  /** What the save says they have on. */
  wornArmor: string;
  status: "fit" | "wounded" | "fallen";
  /** Days to fit, rounded up. 0 when fit. */
  recovery: number;
  /** Freshness left as a fraction of max, 0..1. */
  fresh: number;
  /** As they fight, bare: currentStats + traits + medals. No armour. */
  stats: Stats;
  /** As they fight in the armour they have on. */
  armored: Stats;
  /** currentStats verbatim - what caps and the gym are measured against. */
  raw: Stats;
  /** initialStats: the rookie roll. */
  initial: Stats;
  cap: Stats;
  /** Gym ceiling per stat. 0 means the gym does not train it. */
  train: Stats;
  missions: number;
  kills: number;
  stuns: number;
  medals: { name: string; level: number }[];
  /** shotsFiredCounterTotal: ranged shots taken. */
  shots: number;
  /**
   * shotsLandedCounterTotal. NOT a numerator for accuracy: it routinely beats
   * shots fired - a melee gal in the dev save "fired" 21 and "landed" 72 - so it
   * evidently counts melee hits and every pellet too. Shown raw, never divided.
   */
  hits: number;
  timesWounded: number;
  daysWounded: number;
  months: number;
  /** Total stat points gained in the field. */
  gained: number;
  /** gained / missions, or null for a soldier who has never deployed. */
  gainRate: number;
  /** Stat points the gym can still add, summed over every trainable stat. */
  gymLeft: number;
  /** Stat points still below the hard caps, summed. */
  capLeft: number;
  /** Weapon ids by kills+stuns, most first. */
  weapons: [string, number][];
};

/** Percentile per stat (and per role), keyed by row id. */
export type Ranks = Map<string, { [k: string]: number }>;

/** One soldier type's rule, or an empty object. */
function typeRule(type: string): any {
  return (rul.soldiers && rul.soldiers[type]) || {};
}

function numbers(src: any): Stats {
  const out: Stats = {};
  for (const k of PAX_KEYS) out[k] = src && typeof src == "object" ? +src[k] || 0 : 0;
  return out;
}

export function rankName(type: string, rank: number): string {
  const own = typeRule(type).rankStrings;
  const id = Array.isArray(own) && own.length ? own[Math.min(rank, own.length - 1)] : DEFAULT_RANKS[rank];
  return id ? rul.tr(id) : "Rank " + rank;
}

/** The rows for a save: the living crew, and the fallen when asked for. */
export function paxRows(save: SaveState, withFallen = false): PaxRow[] {
  if (!save) return [];
  const raws: RawSoldier[] = [...(save.crew || []), ...(withFallen ? save.fallen || [] : [])];
  // soldiersFromSave is what CENTCOM uses, so both screens agree on a stat.
  const profiles = soldiersFromSave(raws);
  return raws.map((raw, i) => buildRow(raw, profiles[i]));
}

function buildRow(raw: RawSoldier, profile: any): PaxRow {
  const rule = typeRule(raw.type);
  const stats = numbers(profile.stats);
  const armored = numbers(effectiveStats(profile));
  const cur = numbers(raw.stats);
  const initial = numbers(raw.initial);
  const cap = numbers(rule.statCaps);
  const train = numbers(rule.trainingStatCaps);
  const d = raw.diary || {};

  let gymLeft = 0;
  let capLeft = 0;
  for (const k of PAX_KEYS) {
    if (train[k] > 0) gymLeft += Math.max(0, train[k] - cur[k]);
    if (cap[k] > 0) capLeft += Math.max(0, cap[k] - cur[k]);
  }

  // The diary's own total, else what the stats themselves say moved.
  let gained = +d.statGainTotal || 0;
  if (!gained) for (const k of PAX_KEYS) gained += Math.max(0, cur[k] - initial[k]);

  const fired = +d.shotsFiredCounterTotal || 0;
  const landed = +d.shotsLandedCounterTotal || 0;
  const mana = cur.mana || 0;

  return {
    id: profile.id,
    name: raw.name,
    type: raw.type,
    typeName: rul.tr(raw.type),
    rank: raw.rank,
    rankName: rankName(raw.type, raw.rank),
    base: raw.fallen ? "Memorial" : raw.base,
    craft: raw.craft ? rul.tr(raw.craft) : "",
    armor: raw.armor,
    armorName: raw.armor ? rul.tr(raw.armor) : "",
    wornArmor: raw.armor,
    status: raw.fallen ? "fallen" : raw.recovery > 0 ? "wounded" : "fit",
    recovery: raw.recovery > 0 ? Math.ceil(raw.recovery) : 0,
    fresh: mana > 0 ? Math.max(0, Math.min(1, (mana - (raw.manaMissing || 0)) / mana)) : 1,
    stats,
    armored,
    raw: cur,
    initial,
    cap,
    train,
    missions: raw.missions,
    kills: raw.kills,
    stuns: raw.stuns,
    medals: raw.commendations || [],
    shots: fired,
    hits: landed,
    timesWounded: +d.timesWoundedTotal || 0,
    daysWounded: +d.daysWoundedTotal || 0,
    months: +d.monthsService || 0,
    gained,
    gainRate: raw.missions > 0 ? gained / raw.missions : null,
    gymLeft,
    capLeft,
    weapons: Object.entries(raw.killsByWeapon || {}).sort((a, b) => b[1] - a[1]),
  };
}

/**
 * The rows with sandbox armour picks applied: `armor` and `armored` move to the
 * pick, `wornArmor` keeps what the save says. A pick equal to the worn armour
 * is no pick at all. Rows without a pick come back untouched.
 *
 * `picks` is CENTCOM's own override map (xpediaCrewArmor), keyed by the same
 * soldier id - so a suit tried on here is still on when you jump to CENTCOM.
 */
export function withArmor(rows: PaxRow[], picks: { [id: string]: string }): PaxRow[] {
  return rows.map((r) => {
    const pick = picks && picks[r.id];
    if (pick == null || pick == r.wornArmor || r.status == "fallen") return r;
    return {
      ...r,
      armor: pick,
      armorName: pick ? rul.tr(pick) : "",
      armored: numbers(effectiveStats({ id: r.id, name: r.name, stats: r.stats, armor: pick })),
    };
  });
}

/**
 * How a stat is graded against the crew, 0..100, for the colours and for roles.
 *
 *   rank    mid-rank percentile: the share of the crew below, ties counted as
 *           half. Pure order - "better than 80% of the crew".
 *   scaled  share of the best in the crew. Keeps the gaps: 92 Firing against
 *           a runner-up's 79 reads as a real lead, not one place.
 *
 * Either way a ZERO grades zero. Voodoo Skill is 0 for everyone who has never
 * been trained, and ranking those ties at the middle made a crew of untrained
 * peasants look half-decent at psionics.
 *
 * Graded against the WHOLE living crew, never the filtered view - otherwise
 * narrowing the list to one base would quietly re-grade everyone in it.
 */
export type Basis = "rank" | "scaled";

export function percentiles(
  pool: PaxRow[],
  value: (r: PaxRow, k: string) => number,
  basis: Basis = "rank",
  /** Rows to grade, when not just the pool - the fallen, measured against the living. */
  graded: PaxRow[] = pool
): Ranks {
  const out: Ranks = new Map();
  for (const r of graded) out.set(r.id, {});
  if (!pool.length) return out;
  for (const k of PAX_KEYS) {
    const vals = pool.map((r) => value(r, k)).sort((a, b) => a - b);
    const top = vals[vals.length - 1];
    for (const r of graded) {
      const v = value(r, k);
      if (v <= 0) {
        out.get(r.id)[k] = 0;
        continue;
      }
      if (basis == "scaled") {
        out.get(r.id)[k] = top > 0 ? (100 * v) / top : 0;
        continue;
      }
      let below = 0;
      let equal = 0;
      for (const x of vals) {
        if (x < v) below++;
        else if (x == v) equal++;
      }
      out.get(r.id)[k] = (100 * (below + equal / 2)) / vals.length;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ roles */

export type Role = {
  id: string;
  name: string;
  /** Stat -> weight, 0..5. Only non-zero weights are stored. */
  weights: { [k: string]: number };
  /** What it is for, for the tooltip. */
  note?: string;
};

/**
 * Starting roles. Opinionated on purpose - they are a place to start, and every
 * one of them can be reweighted, renamed or deleted on the Roles view.
 */
export const DEFAULT_ROLES: Role[] = [
  {
    id: "gunner",
    name: "Gunner",
    weights: { firing: 4, tu: 2, reactions: 1, bravery: 1 },
    note: "Aimed and auto fire on your turn. Firing first, TU to get more shots off.",
  },
  {
    id: "overwatch",
    name: "Overwatch",
    weights: { reactions: 4, firing: 3, tu: 1 },
    note: "Reaction fire. Reactions decide who shoots first, Firing decides whether it lands.",
  },
  {
    id: "brawler",
    name: "Brawler",
    weights: { melee: 4, strength: 2, tu: 2, health: 1, bravery: 1 },
    note: "Melee. Most melee weapons add Strength to damage, and you have to walk there.",
  },
  {
    id: "tank",
    name: "Tank",
    weights: { health: 4, bravery: 2, strength: 1, stamina: 1 },
    note: "Point gal. Soaks hits and does not panic when she does.",
  },
  {
    id: "bomber",
    name: "Bomber",
    weights: { throwing: 4, strength: 2, tu: 1 },
    note: "Grenades and thrown weapons. Strength sets how far they fly.",
  },
  {
    id: "scout",
    name: "Scout",
    weights: { tu: 4, stamina: 2, reactions: 2, bravery: 1 },
    note: "Moves far, spots first, survives the first reaction shot.",
  },
  {
    id: "heavy",
    name: "Heavy",
    weights: { strength: 4, firing: 2, health: 1, tu: 1 },
    note: "Carries the big gun. Strength is the weight limit before TU and Stamina suffer.",
  },
  {
    id: "voodoo",
    name: "Voodoo",
    weights: { psiSkill: 4, psiStrength: 2, mana: 2 },
    note: "Psionics. Skill to attack, Power to resist, Freshness to keep going.",
  },
  {
    id: "pilot",
    name: "Pilot",
    weights: { firing: 2, reactions: 2, bravery: 1 },
    note: "Craft crew. The three stats dogfights train.",
  },
];

const ROLE_PREF = "xpediaPaxRoles";

export function loadRoles(): Role[] {
  try {
    const raw = JSON.parse(localStorage[ROLE_PREF] || "null");
    if (!Array.isArray(raw)) return cloneRoles(DEFAULT_ROLES);
    const out = raw.map(sanitizeRole).filter(Boolean);
    return out.length ? out : cloneRoles(DEFAULT_ROLES);
  } catch (e) {
    return cloneRoles(DEFAULT_ROLES);
  }
}

export function saveRoles(roles: Role[]) {
  try {
    localStorage[ROLE_PREF] = JSON.stringify(roles);
  } catch (e) {
    // Storage off or full: the roles still work for this visit.
  }
}

export function cloneRoles(roles: Role[]): Role[] {
  return roles.map((r) => ({ ...r, weights: { ...r.weights } }));
}

function sanitizeRole(raw: any): Role {
  if (!raw || typeof raw != "object") return null;
  const weights: { [k: string]: number } = {};
  if (raw.weights && typeof raw.weights == "object")
    for (const k of PAX_KEYS) {
      const w = Math.max(0, Math.min(5, Math.round(+raw.weights[k] || 0)));
      if (w) weights[k] = w;
    }
  return {
    id: typeof raw.id == "string" && raw.id ? raw.id : "r" + Math.random().toString(36).slice(2, 8),
    name: typeof raw.name == "string" && raw.name ? raw.name.slice(0, 24) : "Role",
    weights,
    note: typeof raw.note == "string" ? raw.note : "",
  };
}

/**
 * A role's score: the weighted mean of the soldier's stat percentiles. 0..100,
 * read as "better at this than N% of the crew". Null for a role with no weights.
 */
export function roleScore(role: Role, pct: { [k: string]: number }): number {
  let sum = 0;
  let total = 0;
  for (const k of Object.keys(role.weights)) {
    const w = role.weights[k];
    if (!w || pct[k] == null) continue;
    sum += w * pct[k];
    total += w;
  }
  return total ? sum / total : null;
}

/** Every role's score for every row. */
export function roleScores(rows: PaxRow[], roles: Role[], ranks: Ranks): Map<string, { [role: string]: number }> {
  const out = new Map();
  for (const r of rows) {
    const pct = ranks.get(r.id) || {};
    const s = {};
    for (const role of roles) s[role.id] = roleScore(role, pct);
    out.set(r.id, s);
  }
  return out;
}

/** The highest-scoring role, or null. */
export function bestRole(scores: { [role: string]: number }, roles: Role[]): Role {
  let best: Role = null;
  let top = -1;
  for (const role of roles) {
    const s = scores && scores[role.id];
    if (s != null && s > top) {
      top = s;
      best = role;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- filters */

export type StatRule = { k: string; op: ">=" | "<="; v: number };

export type PaxFilter = {
  text: string;
  status: "all" | "fit" | "wounded";
  base: string;
  craft: string;
  type: string;
  /** -1 for any. */
  rank: number;
  rules: StatRule[];
  /** Which stat set the rules test: bare, or in the armour they wear. */
  armored: boolean;
};

export const EMPTY_FILTER: PaxFilter = {
  text: "",
  status: "all",
  base: "",
  craft: "",
  type: "",
  rank: -1,
  rules: [],
  armored: false,
};

export function passes(r: PaxRow, f: PaxFilter): boolean {
  if (f.text && !r.name.toLowerCase().includes(f.text.toLowerCase())) return false;
  // The fallen are neither fit nor wounded; a status filter hides them.
  if (f.status != "all" && r.status != f.status) return false;
  if (f.base && r.base != f.base) return false;
  if (f.craft && (f.craft == "-" ? r.craft : r.craft != f.craft)) return false;
  if (f.type && r.type != f.type) return false;
  if (f.rank >= 0 && r.rank != f.rank) return false;
  const st = f.armored ? r.armored : r.stats;
  for (const rule of f.rules) {
    const v = +st[rule.k] || 0;
    if (rule.op == ">=" ? v < rule.v : v > rule.v) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ squad */

export type Slot = { role: string; count: number };
export type Pick = { role: string; row: PaxRow; score: number };

/**
 * Staff a squad: fill each slot with a different soldier so the summed role
 * score is as high as it can be.
 *
 * This is the assignment problem, and greedy gets it wrong in the obvious way -
 * hand your best all-rounder the first slot and the slot only she could fill
 * goes to someone bad. So it is solved exactly (Hungarian, O(n^3)), which at a
 * crew of a hundred is still instant.
 */
export function staffSquad(
  candidates: PaxRow[],
  slots: Slot[],
  scores: Map<string, { [role: string]: number }>
): Pick[] {
  const seats: string[] = [];
  for (const s of slots) for (let i = 0; i < s.count; i++) seats.push(s.role);
  const n = Math.min(seats.length, candidates.length);
  if (!n) return [];
  // More seats than soldiers: fill the seats in the order they were asked for.
  const rows = seats.slice(0, n);
  const m = candidates.length;
  const cost = rows.map((role) =>
    candidates.map((c) => -((scores.get(c.id) || {})[role] ?? 0))
  );
  const match = hungarian(cost, n, m);
  const out: Pick[] = [];
  for (let i = 0; i < n; i++) {
    const row = candidates[match[i]];
    out.push({ role: rows[i], row, score: -cost[i][match[i]] });
  }
  return out;
}

/**
 * Minimum-cost assignment of n rows to m >= n columns. Returns, for each row,
 * its column. The classic potentials formulation (e-maxx), 1-indexed inside.
 */
function hungarian(a: number[][], n: number, m: number): number[] {
  const INF = 1e18;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] != 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const ans = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
  return ans;
}

/* -------------------------------------------------------------------- csv */

export function toCsv(header: string[], rows: (string | number)[][]): string {
  const cell = (x: any) => {
    const s = x == null ? "" : String(x);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
