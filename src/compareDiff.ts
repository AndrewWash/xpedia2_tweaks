/**
 * Compare-mode diff engine.
 *
 * Everything here works on the *ruleset objects* (rul.items[id], rul.armors[id], ...)
 * rather than on rendered markup. Comparing two entries is a flat diff over a few
 * dozen scalar fields, which is cheap enough to redo from scratch on every
 * selection change - no caching, no DOM scraping.
 *
 * Used by DiffPane (the summary strip) and by ComparePane, which uses `diffKeys`
 * to tint the matching rows in place.
 */
import { rul, battleTypes, damageTypes } from "./Ruleset";

/** Collections we know how to diff, in the order we probe them for an id. */
export const KINDS = [
  "items",
  "armors",
  "units",
  "crafts",
  "craftWeapons",
  "facilities",
  "manufacture",
  "research",
  "commendations",
  "soldiers",
  "soldierBonuses",
  "soldierTransformation",
  "ufos",
  "alienDeployments",
  "alienRaces",
  "countries",
  "events",
  "enviroEffects",
  "startingConditions",
];

/**
 * Fields that are presentation or bookkeeping, never worth a diff row. Anything
 * matching SKIP_SUBSTR (case-insensitive) goes too, which sweeps up the whole
 * sprite/sound/animation family without listing every variant.
 */
const SKIP = new Set([
  "id",
  "type",
  "name",
  "title",
  "list",
  "listOrder",
  "index",
  "text",
  "section",
  "sections",
  "article",
  "layersDefinition",
  "layersDefaultPrefix",
  "dollSprites",
  "customArmorPreviewIndex",
  "battlescapeTerrainData",
  "craftInventoryTile",
  "deployment",
  "mapBlocks",
]);

const SKIP_SUBSTR = ["sprite", "sound", "animation", "palette"];

/**
 * Which way is "better" for a given field. Deliberately small and hand-curated:
 * anything not listed renders a neutral delta rather than a guess, which is the
 * right failure mode when a mod invents its own stats.
 */
const HIGHER_BETTER = [
  "power", "damage", "damageMax", "accuracy", "accuracyAimed", "accuracySnap",
  "accuracyAuto", "accuracyMelee", "accuracyThrow", "accuracyUse", "range",
  "maxRange", "aimRange", "snapRange", "autoRange", "ammoMax", "clipSize",
  "armor", "frontArmor", "sideArmor", "rearArmor", "underArmor",
  "health", "stamina", "strength", "firing", "throwing", "melee", "reactions",
  "bravery", "psiStrength", "psiSkill", "mana", "tu",
  "speedMax", "accel", "repairRate", "radarRange", "radarChance", "sightRange",
  "soldiers", "vehicles", "weapons", "storage", "personnel", "workshops",
  "laboratories", "defense", "hitRatio", "aliens",
  "profit", "profitPerHour", "costSell", "fundingBase", "fundingCap",
  "autoShots", "shotgunPellets", "blastRadius", "meleePower",
  "energyRecovery", "healthRecovery", "stunRecovery", "moraleRecovery",
  "manaRecoveryPerDay", "sickBayAbsoluteBonus", "sickBayRelativeBonus",
  "psiVision", "heatVision", "camouflageAtDark", "camouflageAtDay",
  "visibilityAtDark", "visibilityAtDay", "throwRange",
];

const LOWER_BETTER = [
  "costBuy", "costRent", "weight", "size", "tuUse", "tuAimed", "tuSnap",
  "tuAuto", "tuMelee", "tuThrow", "buildCost", "buildTime", "monthlyCost",
  "monthlyMaintenance", "monthlySalary", "time", "cost", "space",
  "transferTime", "recoveryTime", "powerRangeReduction", "powerRangeThreshold",
  "dropoff", "invWidth", "invHeight", "oneHandedPenalty", "explosionSpeed",
  "refuelRate",
];

const DIRECTION: { [key: string]: number } = {};
for (const k of HIGHER_BETTER) DIRECTION[k] = 1;
for (const k of LOWER_BETTER) DIRECTION[k] = -1;

/** Direction lookup that also understands dotted keys ("damageAlter.ToHealth"). */
export function directionOf(key: string): number {
  if (key in DIRECTION) return DIRECTION[key];
  const tail = key.substring(key.lastIndexOf(".") + 1);
  return DIRECTION[tail] || 0;
}

function skipKey(key: string): boolean {
  if (key.charAt(0) == "_") return true;
  if (SKIP.has(key)) return true;
  const low = key.toLowerCase();
  return SKIP_SUBSTR.some((s) => low.indexOf(s) != -1);
}

/**
 * Flatten an entry into { "key" | "key.sub": scalar | scalar[] }. One level of
 * nesting is enough to reach the things people actually compare (damageAlter,
 * damageBonus, stats, cost) without dragging in whole map definitions.
 */
function flatten(obj: any, prefix: string, out: any, depth: number) {
  for (const k of Object.keys(obj)) {
    if (skipKey(k)) continue;
    const v = obj[k];
    if (v == null || typeof v == "function") continue;
    const key = prefix ? prefix + "." + k : k;

    if (Array.isArray(v)) {
      // Long arrays are backlink dumps ("used by these 60 units") - noise here.
      if (v.length == 0 || v.length > 12) continue;
      if (v.every((x) => x == null || typeof x != "object")) out[key] = v.slice();
      continue;
    }
    if (typeof v == "object") {
      if (depth > 0) flatten(v, key, out, depth - 1);
      continue;
    }
    out[key] = v;
  }
}

export type Col = {
  id: string;
  kind: string;
  title: string;
  entry: any;
  fields: any;
};

/** Find which collection an article id lives in, if any. */
export function resolve(id: string): Col {
  if (!id) return null;
  for (const kind of KINDS) {
    const coll = rul[kind];
    if (coll && coll[id]) {
      const entry = coll[id];
      const fields = {};
      flatten(entry, "", fields, 1);
      return { id, kind, title: rul.tr(id), entry, fields };
    }
  }
  return null;
}

function sameValue(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length != b.length) return false;
    const bs = new Set(b);
    return a.every((x) => bs.has(x));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  return a === b;
}

export type Row = {
  key: string;
  values: any[];
  kind: "number" | "bool" | "list" | "string";
  differs: boolean;
  rel: number;
  dir: number;
  best: number;
  worst: number;
  uniques: Set<any>[];
  delta: number;
  pct: number;
};

function makeRow(key: string, values: any[], dir?: number): Row {
  const present = values.filter((v) => v != null);
  const numeric =
    present.length > 0 &&
    present.every(
      (v) => typeof v == "number" || (typeof v == "string" && v !== "" && !isNaN(+v))
    );
  const list = present.some((v) => Array.isArray(v));

  let differs = false;
  for (let i = 1; i < values.length; i++)
    if (!sameValue(values[0], values[i])) differs = true;

  const row: Row = {
    key,
    values,
    kind: list
      ? "list"
      : numeric
      ? "number"
      : typeof present[0] == "boolean"
      ? "bool"
      : "string",
    differs,
    rel: 0,
    dir: dir == null ? directionOf(key) : dir,
    best: -1,
    worst: -1,
    uniques: [],
    delta: null,
    pct: null,
  };

  if (row.kind == "number") {
    const nums = values.map((v) => (v == null ? null : +v));
    const defined = nums.filter((n) => n != null);
    const max = Math.max.apply(null, defined);
    const min = Math.min.apply(null, defined);
    const scale = Math.max(Math.abs(max), Math.abs(min), 1e-9);
    row.rel = Math.abs(max - min) / scale;
    if (row.dir != 0 && max != min) {
      row.best = nums.indexOf(row.dir > 0 ? max : min);
      row.worst = nums.indexOf(row.dir > 0 ? min : max);
    }
    if (values.length == 2 && nums[0] != null && nums[1] != null) {
      row.delta = nums[1] - nums[0];
      row.pct = nums[0] == 0 ? null : (row.delta / Math.abs(nums[0])) * 100;
    }
  } else if (row.kind == "list") {
    // Mark the entries unique to each column so a cell can highlight them.
    const sets = values.map(
      (v) => new Set(Array.isArray(v) ? v : v == null ? [] : [v])
    );
    row.uniques = sets.map(
      (s, i) => new Set([...s].filter((x) => sets.some((o, j) => j != i && !o.has(x))))
    );
    row.rel = differs ? 0.5 : 0;
  } else {
    row.rel = differs ? 0.5 : 0;
  }

  return row;
}

const ATTACK_FIELDS = [
  "damage",
  "damageType",
  "accuracy",
  "shots",
  "pellets",
  "range",
  "cost.time",
  "cost.energy",
];

const ATTACK_DIR: { [k: string]: number } = {
  damage: 1,
  accuracy: 1,
  shots: 1,
  pellets: 1,
  range: 1,
  "cost.time": -1,
  "cost.energy": -1,
};

function attackValue(attack: any, field: string) {
  if (!attack) return null;
  if (field == "damageType")
    return attack.damageType == null
      ? null
      : rul.damageTypeName(attack.damageType) || damageTypes[attack.damageType];
  if (field.indexOf(".") != -1) {
    const parts = field.split(".");
    return attack[parts[0]] ? attack[parts[0]][parts[1]] : null;
  }
  return attack[field];
}

/**
 * Attack-by-attack table for weapons. For two guns this is the comparison people
 * actually want - snap vs snap, aimed vs aimed - which the raw item fields bury.
 */
function buildAttacks(cols: Col[]) {
  const live = cols.filter((c) => c);
  if (live.length < 2) return null;
  if (!live.every((c) => c.kind == "items" && typeof c.entry.attacks == "function"))
    return null;

  const byCol = cols.map((c) => {
    const map: any = {};
    if (!c) return map;
    let list = [];
    try {
      list = c.entry.attacks() || [];
    } catch (e) {
      list = [];
    }
    for (const a of list) if (a && a.mode) map[a.mode] = a;
    return map;
  });

  const seen: string[] = [];
  for (const mode of battleTypes) if (byCol.some((m) => m[mode])) seen.push(mode);
  if (!seen.length) return null;

  const groups = seen.map((mode) => {
    const attacks = byCol.map((m) => m[mode] || null);
    const named = attacks.filter((a) => a && a.name)[0];
    const rows = ATTACK_FIELDS.map((f) =>
      makeRow(
        f,
        attacks.map((a) => attackValue(a, f)),
        ATTACK_DIR[f] || 0
      )
    ).filter((r) => r.values.some((v) => v != null));
    return {
      mode,
      label: named ? named.name : mode,
      rows,
      present: attacks.map((a) => !!a),
    };
  });

  return groups.filter((g) => g.rows.length);
}

export type Diff = {
  cols: Col[];
  ids: string[];
  ready: boolean;
  kindsMatch: boolean;
  kinds: string[];
  rows: Row[];
  differing: number;
  attacks: any[];
  /** Top-level field names that differ - drives the in-place row highlighting. */
  diffKeys: Set<string>;
  unknown: string[];
};

export function buildDiff(ids: string[]): Diff {
  const cols = ids.map(resolve);
  const filled = ids.filter((id) => id);
  const unknown = ids.filter((id, i) => id && !cols[i]);
  const kinds = cols.filter((c) => c).map((c) => c.kind);
  const kindsMatch = kinds.length > 1 && kinds.every((k) => k == kinds[0]);

  const empty: Diff = {
    cols,
    ids,
    ready: false,
    kindsMatch,
    kinds,
    rows: [],
    differing: 0,
    attacks: null,
    diffKeys: new Set<string>(),
    unknown,
  };

  if (filled.length < 2 || kinds.length < 2) return empty;

  // Same kind: compare the union of fields. Different kinds: only the fields
  // both sides actually have, since the rest would be meaningless "5 vs -" rows.
  const keySets = cols.map((c) => (c ? Object.keys(c.fields) : null));
  const live = keySets.filter((s) => s).map((s) => new Set(s));
  let keys: string[];
  if (kindsMatch) {
    const union = new Set<string>();
    for (const s of live) for (const k of s) union.add(k);
    keys = [...union];
  } else {
    keys = [...live[0]].filter((k) => live.every((s) => s.has(k)));
  }

  const rows = keys
    .map((k) =>
      makeRow(
        k,
        cols.map((c) => (c && k in c.fields ? c.fields[k] : null))
      )
    )
    .filter((r) => r.values.some((v) => v != null));

  // Biggest relative gaps first - that is the answer to "what actually differs".
  rows.sort((a, b) => {
    if (a.differs != b.differs) return a.differs ? -1 : 1;
    if (b.rel != a.rel) return b.rel - a.rel;
    return a.key < b.key ? -1 : 1;
  });

  const diffKeys = new Set<string>();
  for (const r of rows)
    if (r.differs)
      diffKeys.add(
        r.key.indexOf(".") == -1 ? r.key : r.key.substring(0, r.key.indexOf("."))
      );

  return {
    cols,
    ids,
    ready: true,
    kindsMatch,
    kinds,
    rows,
    differing: rows.filter((r) => r.differs).length,
    attacks: buildAttacks(cols),
    diffKeys,
    unknown,
  };
}
