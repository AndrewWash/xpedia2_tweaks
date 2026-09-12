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

const KEY = "xpediaSoldiers";

export type Soldier = {
  id: string;
  name: string;
  /** Base stats as typed by the user, before armour. */
  stats: Stats;
  /** Armour id, or "" for none. */
  armor: string;
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

/** Armours a player soldier can actually wear. */
export function wearableArmors(): { id: string; title: string }[] {
  const out = [];
  for (const id of Object.keys(rul.armors || {})) {
    const a = rul.armors[id];
    if (!a || !a.units || !a.units.length) continue;
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
