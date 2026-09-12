/**
 * Saved soldier profiles.
 *
 * Stored in localStorage under `xpediaSoldiers`, following the same idiom as
 * Compare's prefs: validate every field on load, never trust the shape, and
 * fail back to defaults rather than throwing on a browser with storage off.
 *
 * A profile carries base stats plus an optional worn armour. The armour matters
 * twice over: its `stats` are additive bonuses while worn (so a Gal in power
 * armour genuinely has different Firing), and it is what the soldier's own
 * resistances would come from if we ever point the calculator back at them.
 */
import { rul } from "./Ruleset";
import { STAT_KEYS, STAT_BOUNDS } from "./damageCalc";
import type { Stats } from "./damageCalc";
import type { RawSoldier } from "./damageSave";

const KEY = "xpediaSoldiers";

export type Soldier = {
  id: string;
  name: string;
  /** Base stats as typed by the user, before armour. */
  stats: Stats;
  /** Armour id, or "" for none. */
  armor: string;
  /**
   * Set when this profile was read out of a saved game rather than typed.
   *
   * Same shape as a manual profile on purpose, so effectiveStats and everything
   * downstream treat the two identically - the only difference is that these are
   * never written to localStorage and their stats are not editable in place.
   */
  fromSave?: SaveOrigin;
};

export type SaveOrigin = {
  /** The armour actually worn in the save, so an override can be undone. */
  wornArmor: string;
  /** Soldier type id, for the right stat caps. */
  type: string;
  /** Where they are and what shape they are in. Display only. */
  note: string;
};

/** A blank profile using the mod's own rookie roll as the starting point. */
export function defaultStats(soldierType?: string): Stats {
  const type = soldierType && rul.soldiers ? rul.soldiers[soldierType] : null;
  const min = (type && type.minStats) || {};
  const max = (type && type.maxStats) || {};
  const out: Stats = {};
  for (const k of STAT_KEYS) {
    if (STAT_BOUNDS[k]) {
      out[k] = STAT_BOUNDS[k].def;
      continue;
    }
    const lo = +min[k];
    const hi = +max[k];
    // Midpoint of the rookie roll when the ruleset gives one, else a plain
    // mid-range value so the form is never full of zeroes.
    out[k] = !isNaN(lo) && !isNaN(hi) ? Math.round((lo + hi) / 2) : k == "tu" ? 60 : 40;
  }
  return out;
}

/** Stat ceiling for a soldier type, used to bound the form inputs. */
export function statCaps(soldierType?: string): Stats {
  const type = soldierType && rul.soldiers ? rul.soldiers[soldierType] : null;
  const caps = (type && type.statCaps) || {};
  const out: Stats = {};
  for (const k of STAT_KEYS)
    out[k] = STAT_BOUNDS[k] ? STAT_BOUNDS[k].cap : +caps[k] || 0;
  return out;
}

/**
 * Base stats plus the worn armour's bonuses.
 *
 * Armour `stats` are additive and can push a soldier past their stat cap, which
 * is why the form allows values above the cap rather than clamping to it.
 */
export function effectiveStats(soldier: Soldier): Stats {
  const out: Stats = {};
  for (const k of STAT_KEYS) out[k] = +soldier.stats[k] || 0;
  const armor = soldier.armor && rul.armors ? rul.armors[soldier.armor] : null;
  if (armor && armor.stats && typeof armor.stats == "object")
    for (const k of STAT_KEYS) out[k] += +armor.stats[k] || 0;
  return out;
}

/**
 * Stats a standing bonus adds, e.g. STR_BEEFY_TRAIT -> {health: 6, strength: 4}.
 *
 * These live in rul.soldierBonuses as inert reference data - nothing else in
 * the app has ever read them, because until now no soldier had any.
 */
function bonusStats(name: string): Stats {
  const b = name && rul.soldierBonuses ? rul.soldierBonuses[name] : null;
  return b && b.stats && typeof b.stats == "object" ? b.stats : null;
}

/**
 * The bonus a medal grants at the level it has been awarded to.
 *
 * A commendation names a list of bonus types, one per decoration level, and the
 * soldier's `decorationLevel` indexes it - STR_MEDAL_STATGAIN at level 1 is
 * STR_MEDAL_STATGAIN_2, worth +2 stamina and +2 health.
 */
function commendationBonus(name: string, level: number): Stats {
  const c = name && rul.commendations ? rul.commendations[name] : null;
  const types = c && c.soldierBonusTypes;
  if (!Array.isArray(types) || !types.length) return null;
  const idx = Math.min(Math.max(0, level | 0), types.length - 1);
  return bonusStats(types[idx]);
}

/**
 * Turn the save's raw records into profiles the calculator can use.
 *
 * The one thing that makes this more than a field copy: `currentStats` in the
 * save is NOT the soldier's battle-time total. Transformation traits and medals
 * are a standing layer the engine adds when the mission starts, and the save
 * proves it - a gal carrying STR_REVOLUTIONARY (+10 bravery) shows bravery 30 in
 * both initialStats and currentStats. Reading currentStats alone would quietly
 * understate every veteran in the crew, so both layers are summed here:
 *
 *   currentStats  +  transformationBonuses  +  commendations at their level
 *
 * Armour is deliberately NOT folded in - effectiveStats already does that, and
 * doing it here as well would double it while making the armour un-swappable.
 */
export function soldiersFromSave(crew: RawSoldier[]): Soldier[] {
  if (!Array.isArray(crew)) return [];

  return crew.map((raw) => {
    const stats: Stats = {};
    for (const k of STAT_KEYS) stats[k] = +raw.stats[k] || 0;
    // Rank is its own field in the save and is not a ruleset stat at all, but a
    // dozen weapons scale their damage off it.
    stats.rank = +raw.rank || 0;

    const layers: Stats[] = [];
    for (const b of raw.bonuses || []) {
      const st = bonusStats(b);
      if (st) layers.push(st);
    }
    for (const c of raw.commendations || []) {
      const st = commendationBonus(c.name, c.level);
      if (st) layers.push(st);
    }
    for (const layer of layers)
      for (const k of STAT_KEYS) stats[k] += +layer[k] || 0;

    return {
      id: raw.key,
      name: raw.name,
      stats,
      armor: raw.armor,
      fromSave: {
        wornArmor: raw.armor,
        type: raw.type,
        note: conditionOf(raw),
      },
    };
  });
}

/** "on Airbus" / "wounded 13d" / "" - what to show beside the name. */
function conditionOf(raw: RawSoldier): string {
  if (raw.recovery > 0) return "wounded " + Math.ceil(raw.recovery) + "d";
  if (raw.craft) return "on " + rul.tr(raw.craft);
  return "";
}

/**
 * Armours a soldier can actually wear.
 *
 * An armour's `units` lists the soldier types allowed into it, and the mod means
 * it: a plain STR_SOLDIER cannot put on "camo paint /cat" or "/pea", which are
 * cut for the cat and peasant frames. Offering the whole 538-strong wardrobe to
 * everyone produced a picker where most entries were illegal for the gal in
 * front of you - so pass the type and get only what fits her.
 *
 * With no type given it falls back to every wearable armour, which is what a
 * hand-made profile with no declared type wants.
 */
export function wearableArmors(soldierType?: string): { id: string; title: string }[] {
  const out = [];
  for (const id of Object.keys(rul.armors || {})) {
    const a = rul.armors[id];
    if (!a || !a.units || !a.units.length) continue;
    if (soldierType && !a.units.includes(soldierType)) continue;
    out.push({ id, title: rul.tr(id) });
  }
  return out.sort((a, b) => (a.title < b.title ? -1 : 1));
}

function newId(): string {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function blankSoldier(name?: string): Soldier {
  return {
    id: newId(),
    name: name || "New soldier",
    stats: defaultStats("STR_SOLDIER"),
    armor: "",
  };
}

/** Coerce whatever came out of storage into a usable profile. */
function sanitize(raw: any): Soldier {
  if (!raw || typeof raw != "object") return null;
  const stats: Stats = {};
  const from = raw.stats && typeof raw.stats == "object" ? raw.stats : {};
  for (const k of STAT_KEYS) {
    const n = +from[k];
    stats[k] = isNaN(n) ? 0 : n;
  }
  return {
    id: typeof raw.id == "string" && raw.id ? raw.id : newId(),
    name: typeof raw.name == "string" && raw.name ? raw.name : "Unnamed",
    stats,
    armor: typeof raw.armor == "string" ? raw.armor : "",
  };
}

export function loadSoldiers(): Soldier[] {
  try {
    const raw = JSON.parse(localStorage[KEY] || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitize).filter(Boolean);
  } catch (e) {
    return [];
  }
}

export function saveSoldiers(list: Soldier[]) {
  try {
    localStorage[KEY] = JSON.stringify(list);
  } catch (e) {
    // Storage can be off or full; losing the save is better than losing the page.
  }
}

/** Everything the user has entered, as a file they can keep. */
export function exportSoldiers(list: Soldier[]): string {
  return JSON.stringify({ xpediaSoldiers: 1, soldiers: list }, null, 2);
}

export function importSoldiers(text: string): Soldier[] {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data && data.soldiers;
  if (!Array.isArray(list)) throw new Error("not a soldier file");
  const out = list.map(sanitize).filter(Boolean);
  if (!out.length) throw new Error("no soldiers in file");
  return out;
}
