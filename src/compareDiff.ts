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

import {
  KINDS,
  SKIP_FIELDS,
  SKIP_SUBSTR,
  SKIP_PATHS,
  HIGHER_BETTER,
  LOWER_BETTER,
  ATTACK_FIELDS,
  ATTACK_DIR,
  MAX_LIST_LENGTH,
  FLATTEN_DEPTH,
  FORCE_FIELDS,
  REQUIREMENT_FIELDS,
  REQUIREMENT_LABELS,
  RESISTANCE_FIELD,
  RESISTANCE_HIDE_NEUTRAL,
  RESISTANCE_SCALE,
  AMMO_DAMAGE_FIELDS,
} from "./compareConfig";

export { KINDS };

const SKIP = new Set(SKIP_FIELDS);
const FORCE = new Set(FORCE_FIELDS);
const SKIP_PATH = new Set(SKIP_PATHS);

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
    if (SKIP_PATH.has(key)) continue;

    if (Array.isArray(v)) {
      // Long arrays are backlink dumps ("used by these 60 units") - noise here.
      // FORCE_FIELDS are exempt: a prerequisite list is worth reading at any
      // length, and dropping one silently answers "what do I still need?" wrong.
      const forced = FORCE.has(k);
      if (v.length == 0 || (!forced && v.length > MAX_LIST_LENGTH)) continue;
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
  /** Clips this weapon can load, if it is an ammo-fed weapon. */
  ammoOptions: string[];
  /** Every collection entry sharing this id - see allEntries. */
  entries: any[];
};

/**
 * Every entry that shares an id, across all collections.
 *
 * XPiratez reuses one STR_ id for an item, the research that unlocks it and the
 * manufacture project that builds it. resolve() stops at the first collection
 * that has it - items - so anything living on the research or manufacture entry
 * is invisible to it. Prerequisites are almost always over there: STR_LASER_RIFLE
 * the item has no `requires`, STR_LASER_RIFLE the manufacture project does.
 *
 * Returned in KINDS order, so the primary entry comes first.
 */
export function allEntries(id: string): any[] {
  if (!id) return [];
  const out = [];
  for (const kind of KINDS) {
    const coll = rul[kind];
    if (coll && coll[id]) out.push(coll[id]);
  }
  return out;
}

/**
 * First non-empty value for `key` across every entry sharing this id.
 *
 * Deliberately limited to the id's own entries. Following backlinks such as
 * item.manufacture was tried and reverted: that list contains every project
 * that happens to output the item - lootboxes, casino coupons - so it would
 * cheerfully report a laser rifle as requiring STR_GAMBLING.
 */
function fieldAcross(col: Col, key: string): any[] {
  if (!col) return null;
  for (const e of col.entries) {
    const v = e[key];
    if (v == null) continue;
    const list = Array.isArray(v) ? v : [v];
    if (list.length) return list;
  }
  return null;
}

/** The clips a weapon accepts, as ids that actually resolve to items. */
function ammoOptionsFor(entry: any): string[] {
  const list = entry && entry.compatibleAmmo;
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && rul.items[a]);
}

/** Find which collection an article id lives in, if any. */
export function resolve(id: string): Col {
  if (!id) return null;
  for (const kind of KINDS) {
    const coll = rul[kind];
    if (coll && coll[id]) {
      const entry = coll[id];
      const fields = {};
      flatten(entry, "", fields, FLATTEN_DEPTH);
      return {
        id,
        kind,
        title: rul.tr(id),
        entry,
        fields,
        ammoOptions: ammoOptionsFor(entry),
        entries: allEntries(id),
      };
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
/**
 * The clip a column is firing: the caller's pick when it is still valid for this
 * weapon, otherwise the first one the weapon accepts.
 */
export function chosenAmmo(col: Col, picked: string): string {
  if (!col || !col.ammoOptions.length) return null;
  if (picked && col.ammoOptions.includes(picked)) return picked;
  return col.ammoOptions[0];
}

/**
 * Damage for one firing mode, with the loaded clip taken into account.
 *
 * An ammo-fed weapon carries no damage of its own - Attack only fills in
 * `damage` when the item has no compatibleAmmo, because the number lives on the
 * clip. So for those we read the clip's own attack and copy the damage fields
 * across, leaving everything the gun does own (accuracy, TU, range, pellets)
 * alone. Without this every gun-vs-gun comparison shows an empty damage row.
 */
function withAmmo(attack: any, ammoId: string) {
  if (!attack || !ammoId) return attack;
  if (attack.damage != null) return attack; // weapon has its own damage
  const ammo = rul.items[ammoId];
  if (!ammo || typeof ammo.attacks != "function") return attack;

  let shot = null;
  try {
    shot = (ammo.attacks() || [])[0];
  } catch (e) {
    shot = null;
  }
  if (!shot) return attack;

  const merged = Object.create(Object.getPrototypeOf(attack) || Object.prototype);
  Object.assign(merged, attack);
  for (const f of AMMO_DAMAGE_FIELDS)
    if (shot[f] != null) merged[f] = shot[f];
  // The clip's damageAlter wins too - that is where ToHealth/ToStun live.
  if (shot.alter) merged.alter = Object.assign({}, attack.alter || {}, shot.alter);
  merged.ammoFrom = ammoId;
  return merged;
}

function buildAttacks(cols: Col[], ammoSel: string[]) {
  const live = cols.filter((c) => c);
  if (live.length < 2) return null;
  if (!live.every((c) => c.kind == "items" && typeof c.entry.attacks == "function"))
    return null;

  const byCol = cols.map((c, i) => {
    const map: any = {};
    if (!c) return map;
    let list = [];
    try {
      list = c.entry.attacks() || [];
    } catch (e) {
      list = [];
    }
    const ammoId = chosenAmmo(c, ammoSel && ammoSel[i]);
    for (const a of list) if (a && a.mode) map[a.mode] = withAmmo(a, ammoId);
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

/**
 * Armour resistance block: one row per damage type.
 *
 * `damageModifier` is a plain number[] running parallel to the `damageTypes`
 * list, so index N is the multiplier applied to damage type N. It is 24 entries
 * long, which put it over the backlink cutoff in flatten() and meant armour
 * resistances - the single most useful thing about an armour - never showed up
 * at all. Here it gets proper damage-type labels instead of bare indices.
 *
 * Lower is better: the value is the fraction of incoming damage that lands.
 */
function buildResistances(cols: Col[]) {
  const live = cols.filter((c) => c);
  if (live.length < 2) return null;
  if (!live.some((c) => Array.isArray(c.entry[RESISTANCE_FIELD]))) return null;

  const mods = cols.map((c) => {
    const v = c && c.entry[RESISTANCE_FIELD];
    return Array.isArray(v) ? v : null;
  });

  const width = Math.max(...mods.map((m) => (m ? m.length : 0)));
  if (!width) return null;

  const rows = [];
  for (let i = 0; i < width; i++) {
    const values = mods.map((m) => (m && m[i] != null ? m[i] : null));
    if (!values.some((v) => v != null)) continue;
    // A flat 1.0 everywhere means "no modifier" - not worth a row.
    if (RESISTANCE_HIDE_NEUTRAL && values.every((v) => v == null || +v == 1)) continue;
    // Scaled to percentages so the delta column reads in percentage points.
    const scaled = values.map((v) => (v == null ? null : +v * RESISTANCE_SCALE));
    rows.push(makeRow(damageTypes[i] || "type " + i, scaled, -1));
  }
  if (!rows.length) return null;

  return {
    rows,
    present: mods.map((m) => !!m),
  };
}

/** Label for a prerequisite row - the game's own string when the mod has one. */
export function requirementLabel(key: string): string {
  const str = REQUIREMENT_LABELS[key];
  if (str && rul.lang && str in rul.lang) return str;
  return key;
}

/**
 * Prerequisite block: research and base services needed, for every kind of
 * article that has them. Pulled out of the main stat list so the biggest-gap
 * sort cannot bury it, and shown whenever *any* column has the field - a
 * requirement one side has and the other does not is the whole point.
 */
function buildRequirements(cols: Col[]) {
  const live = cols.filter((c) => c);
  if (live.length < 2) return null;

  const rows = [];
  for (const key of REQUIREMENT_FIELDS) {
    const values = cols.map((c) => fieldAcross(c, key));
    if (!values.some((v) => v != null)) continue;
    rows.push(makeRow(requirementLabel(key), values, 0));
  }
  if (!rows.length) return null;
  return { rows };
}

export type Diff = {
  cols: Col[];
  ids: string[];
  ready: boolean;
  kindsMatch: boolean;
  kinds: string[];
  rows: Row[];
  differing: number;
  /** Rows across every block, for the "n/m" count in the header. */
  total: number;
  attacks: any[];
  /** Per-damage-type armour resistances, or null when no column is an armour. */
  resistances: { rows: Row[]; present: boolean[] };
  /** Research and base-service prerequisites, for any kind of article. */
  requirements: { rows: Row[] };
  /** The clip each column is firing, parallel to cols. Null where not a weapon. */
  ammo: string[];
  /** Top-level field names that differ - drives the in-place row highlighting. */
  diffKeys: Set<string>;
  unknown: string[];
};

export function buildDiff(ids: string[], ammoSel: string[] = []): Diff {
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
    total: 0,
    resistances: null,
    requirements: null,
    ammo: cols.map((c, i) => chosenAmmo(c, ammoSel[i])),
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

  // Anything with a dedicated block below is dropped from the flat stat list so
  // it is not reported twice.
  const owned = new Set<string>([RESISTANCE_FIELD, ...REQUIREMENT_FIELDS]);
  const rows = keys
    .filter((k) => !owned.has(k.indexOf(".") == -1 ? k : k.substring(0, k.indexOf("."))))
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

  const resistances = buildResistances(cols);
  const requirements = buildRequirements(cols);

  const diffKeys = new Set<string>();
  for (const r of rows)
    if (r.differs)
      diffKeys.add(
        r.key.indexOf(".") == -1 ? r.key : r.key.substring(0, r.key.indexOf("."))
      );

  // The blocks above own fields that are no longer in `rows`, so their highlight
  // keys have to be added by hand. Requirement rows are keyed by display label,
  // hence the re-check against the raw field name.
  if (resistances && resistances.rows.some((r) => r.differs))
    diffKeys.add(RESISTANCE_FIELD);
  if (requirements)
    for (const key of REQUIREMENT_FIELDS) {
      const values = cols.map((c) => fieldAcross(c, key));
      if (values.some((v) => v != null) && !values.every((v) => sameValue(v, values[0])))
        diffKeys.add(key);
    }

  const differing =
    rows.filter((r) => r.differs).length +
    (resistances ? resistances.rows.filter((r) => r.differs).length : 0) +
    (requirements ? requirements.rows.filter((r) => r.differs).length : 0);

  const total =
    rows.length +
    (resistances ? resistances.rows.length : 0) +
    (requirements ? requirements.rows.length : 0);

  return {
    cols,
    ids,
    ready: true,
    kindsMatch,
    kinds,
    rows,
    differing,
    total,
    resistances,
    requirements,
    ammo: cols.map((c, i) => chosenAmmo(c, ammoSel[i])),
    attacks: buildAttacks(cols, ammoSel),
    diffKeys,
    unknown,
  };
}
