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
  REQUIREMENT_VIA_FIELDS,
  REQUIREMENTS_FROM_ARTICLE,
  REQUIREMENT_LABELS,
  SIGN_MODE_FIELDS,
  ENUM_FIELDS,
  ENUM_VALUE_LABELS,
  STAT_SECTIONS,
  STAT_SECTION_OTHER,
  DAMAGE_TYPE_FIELDS,
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

/**
 * Language-key prefix for an enum field, or null. Understands dotted keys the
 * same way directionOf does.
 */
export function enumPrefix(key: string): string {
  if (!key) return null;
  if (key in ENUM_FIELDS) return ENUM_FIELDS[key];
  const tail = key.substring(key.lastIndexOf(".") + 1);
  return ENUM_FIELDS[tail] || null;
}

const DAMAGE_TYPE_FIELD = new Set(DAMAGE_TYPE_FIELDS);

/** True for a field whose numbers index the damageTypes table. */
function isDamageTypeField(key: string): boolean {
  if (!key) return false;
  if (DAMAGE_TYPE_FIELD.has(key)) return true;
  return DAMAGE_TYPE_FIELD.has(key.substring(key.lastIndexOf(".") + 1));
}

/**
 * Turn a damage type index into its STR_DAMAGE_* key, which Tr then names.
 *
 * Left alone when it is not a number - the attack table resolves damageType
 * before we ever see it, and re-mapping a name would throw it away.
 */
function damageTypeValue(v: any): any {
  const isNum =
    typeof v == "number" || (typeof v == "string" && v !== "" && !isNaN(+v));
  if (!isNum) return v;
  const name = damageTypes[+v];
  return name == null ? v : name;
}

function mapDamageTypes(v: any): any {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(damageTypeValue);
  return damageTypeValue(v);
}

/**
 * Hand-written label for one enum value, or null. Takes priority over the
 * language file - see ENUM_VALUE_LABELS for why that is sometimes needed.
 */
export function enumOverrideLabel(key: string, value: any): string {
  if (!key || value == null) return null;
  const field = key in ENUM_VALUE_LABELS ? key : key.substring(key.lastIndexOf(".") + 1);
  const map = ENUM_VALUE_LABELS[field];
  return map && map[value] != null ? map[value] : null;
}

const SIGN_MODE_FIELD = new Set(SIGN_MODE_FIELDS);

/** True for a field whose sign selects a mode - see SIGN_MODE_FIELDS. */
function isSignModeField(key: string): boolean {
  if (!key) return false;
  if (SIGN_MODE_FIELD.has(key)) return true;
  return SIGN_MODE_FIELD.has(key.substring(key.lastIndexOf(".") + 1));
}

/** Which mode a value is in: <= 0 is relative, > 0 absolute. */
function signMode(v: number): number {
  return v > 0 ? 1 : 0;
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
 * The pedia Article for an id, as a requirement source, or null.
 *
 * Only its `requires` matters here; a self-referential value is dropped the same
 * way the article page drops it. See REQUIREMENTS_FROM_ARTICLE.
 */
function articleSource(id: string): any {
  if (!REQUIREMENTS_FROM_ARTICLE || typeof rul.article != "function") return null;
  let art = null;
  try {
    art = rul.article(id);
  } catch (e) {
    return null;
  }
  if (!art || art.requires == null) return null;
  const list = (Array.isArray(art.requires) ? art.requires : [art.requires]).filter(
    (r) => r && r != id
  );
  return list.length ? { requires: list } : null;
}

/** Every requirement source for an id: its entries, then its pedia article. */
function sourcesFor(id: string): any[] {
  const art = articleSource(id);
  return art ? [...allEntries(id), art] : allEntries(id);
}

/** First non-empty value for `key` among a set of entries, as a list. */
function firstValue(entries: any[], key: string): any[] {
  for (const e of entries) {
    const v = e[key];
    if (v == null) continue;
    // Some armours write `requires` as a bare string rather than a list.
    const list = Array.isArray(v) ? v : [v];
    if (list.length) return list;
  }
  return null;
}

/**
 * First non-empty value for `key`, looked for on every entry sharing this id
 * and then, only if those have nothing, through the single-target links in
 * REQUIREMENT_VIA_FIELDS. `linked` says which of the two it came from.
 *
 * Note the links are strictly 1:1 (see REQUIREMENT_VIA_FIELDS) - following a
 * fan-out backlink was tried and reverted because it attributed a casino
 * coupon's prerequisites to whatever the coupon could produce.
 */
function fieldAcross(col: Col, key: string): { list: any[]; linked: boolean } {
  if (!col) return null;

  const own = firstValue(col.entries, key);
  if (own) return { list: own, linked: false };

  for (const e of col.entries)
    for (const viaField of REQUIREMENT_VIA_FIELDS) {
      const targetId = e[viaField];
      if (!targetId || typeof targetId != "string") continue;
      const via = firstValue(sourcesFor(targetId), key);
      if (via) return { list: via, linked: true };
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
        entries: sourcesFor(id),
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
  kind: "number" | "bool" | "list" | "string" | "enum";
  differs: boolean;
  rel: number;
  dir: number;
  best: number;
  worst: number;
  uniques: Set<any>[];
  delta: number;
  pct: number;
  /** Value came from a linked entry rather than this one - see fieldAcross. */
  linked: boolean;
  /**
   * The values span more than one mode of a SIGN_MODE_FIELDS field, so they are
   * not on a common scale. best/worst and the delta are suppressed.
   */
  mixedMode: boolean;
};

function makeRow(key: string, values: any[], dir?: number): Row {
  // Resolve damage type indices to names up front, so everything downstream -
  // differs, uniques, rendering - works on the names rather than the numbers.
  if (isDamageTypeField(key)) values = values.map(mapDamageTypes);

  const present = values.filter((v) => v != null);
  const numeric =
    present.length > 0 &&
    present.every(
      (v) => typeof v == "number" || (typeof v == "string" && v !== "" && !isNaN(+v))
    );
  const list = present.some((v) => Array.isArray(v));
  // An enum is stored as a number but must never be treated as a quantity.
  const isEnum = !list && numeric && enumPrefix(key) != null;

  let differs = false;
  for (let i = 1; i < values.length; i++)
    if (!sameValue(values[0], values[i])) differs = true;

  const row: Row = {
    key,
    values,
    kind: list
      ? "list"
      : isEnum
      ? "enum"
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
    linked: false,
    mixedMode: false,
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

    // Values from different modes are not on one scale, so any verdict drawn
    // from them would be made up. Show the numbers, skip the judgement.
    if (isSignModeField(key)) {
      const modes = new Set(nums.filter((n) => n != null).map(signMode));
      if (modes.size > 1) {
        row.mixedMode = true;
        row.best = -1;
        row.worst = -1;
        row.delta = null;
        row.pct = null;
      }
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
export function withAmmo(attack: any, ammoId: string) {
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
  // Only reached for ammo-fed weapons, where the clip is authoritative for
  // everything about the projectile - including how many of them there are.
  for (const f of AMMO_DAMAGE_FIELDS)
    if (shot[f] != null) merged[f] = shot[f];
  // The clip's damageAlter wins too - that is where ToHealth/ToStun live.
  if (shot.alter) merged.alter = Object.assign({}, attack.alter || {}, shot.alter);
  // Pellet scatter is split across the two items: spread is a property of the
  // shell, choke of the barrel (ProjectileFlyBState reads them from exactly
  // those two places).
  if (ammo.shotgunSpread != null) merged.shotgunSpread = ammo.shotgunSpread;
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
    const found = cols.map((c) => fieldAcross(c, key));
    if (!found.some((f) => f != null)) continue;
    const values = found.map((f) => (f ? f.list : null));
    // ↗ marks a row where a column had to reach through a link (an armour's
    // store item, say) to find the requirement, rather than owning it directly.
    const row = makeRow(requirementLabel(key), values, 0);
    row.linked = found.some((f) => f && f.linked);
    rows.push(row);
  }
  if (!rows.length) return null;
  return { rows };
}

/**
 * Pattern -> RegExp, with "*" as the only wildcard. Built once at module load;
 * the patterns are static config so there is nothing to invalidate.
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "i");
}

const SECTION_MATCHERS = STAT_SECTIONS.map((sec) => ({
  label: sec.label,
  icon: sec.icon,
  patterns: sec.fields.map(patternToRegExp),
}));

export type StatSection = {
  label: string;
  icon: string;
  rows: Row[];
};

/**
 * Drop each row into the first section that claims it, preserving the order the
 * patterns are declared in - that is what keeps related stats adjacent instead
 * of scattered by the old biggest-difference-first sort.
 *
 * Rows caught by the same wildcard are ordered alphabetically so a family like
 * damageAlter.* comes out stable and predictable.
 */
function buildSections(rows: Row[]): StatSection[] {
  const buckets = SECTION_MATCHERS.map(() => [] as { row: Row; rank: number }[]);
  const other: { row: Row; rank: number }[] = [];

  for (const row of rows) {
    let placed = false;
    for (let i = 0; i < SECTION_MATCHERS.length && !placed; i++) {
      const patterns = SECTION_MATCHERS[i].patterns;
      for (let j = 0; j < patterns.length; j++)
        if (patterns[j].test(row.key)) {
          buckets[i].push({ row, rank: j });
          placed = true;
          break;
        }
    }
    if (!placed) other.push({ row, rank: 0 });
  }

  const order = (list: { row: Row; rank: number }[]) =>
    list
      .sort((a, b) => (a.rank != b.rank ? a.rank - b.rank : a.row.key < b.row.key ? -1 : 1))
      .map((e) => e.row);

  const out: StatSection[] = [];
  for (let i = 0; i < SECTION_MATCHERS.length; i++)
    if (buckets[i].length)
      out.push({
        label: SECTION_MATCHERS[i].label,
        icon: SECTION_MATCHERS[i].icon,
        rows: order(buckets[i]),
      });
  if (other.length)
    out.push({ ...STAT_SECTION_OTHER, rows: order(other) });
  return out;
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
  /** The flat stat rows, grouped and ordered by STAT_SECTIONS. */
  sections: StatSection[];
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
    sections: [],
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

  // No global sort any more: buildSections below groups these by subject and
  // orders them within each group. Sorting by size of difference here read well
  // for a single row but tore apart families like damageAlter.*.

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
      const values = cols.map((c) => {
        const f = fieldAcross(c, key);
        return f ? f.list : null;
      });
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
    sections: buildSections(rows),
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
