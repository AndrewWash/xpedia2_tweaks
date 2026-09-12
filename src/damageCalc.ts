/**
 * Damage model.
 *
 * The arithmetic here follows OXCE's own source rather than the mod tooltips,
 * because the two questions that actually matter are not answered by the
 * tooltips and the tooltips contradict the ruleset reference on one of them.
 * From `BattleUnit::damage()` and `RuleDamageType`:
 *
 *   power   = weapon (or ammo) power + damageBonus(attacker stats)
 *   rolled  = RandomType spread applied to power          "primary damage"
 *   rolled *= armour.damageModifier[damageType]           RESISTANCE FIRST
 *   armour -= rolled * ToArmorPre                         banked, see below
 *   damage  = rolled - armour(side) * ArmorEffectiveness  then armour
 *   health += damage * ToHealth                           To* take POST-armour
 *   stun   += damage * ToStun                             damage, not power
 *   armour -= damage * ToArmor                            also banked
 *
 * The three things worth restating, because getting them backwards changes
 * every number: resistance multiplies BEFORE armour is subtracted, every To*
 * factor is taken from the damage that survived armour, and the armour damage
 * does NOT help the hit that caused it. That last one looks wrong next to the
 * reference's own wording ("applied to the unit's armor before armor is
 * considered") and the source settles it - BattleUnit::damage accumulates both
 * armour terms into one `toArmor` total and only applies it at the end:
 *
 *   std::get<toArmor>(args.data) += type->getArmorPreFinalDamage(damage);
 *   if (type->ArmorEffectiveness > 0.0f) damage -= getArmor(side) * ...;
 *   std::get<toArmor>(args.data) += type->getArmorFinalDamage(damage);
 *   setValueMax(_currentArmor[side], -std::get<toArmor>(args.data), 0, _maxArmor[side]);
 *
 * so the subtraction uses the armour as it stood when the hit landed, and the
 * next hit on that facing is the one that benefits. Which is why attacks-to-kill
 * is simulated shot by shot (simulateAttacks) rather than divided out.
 *
 * Everything here is a distribution, never a single number - a 0-200% roll
 * against armour means a large share of shots simply bounce, and an average
 * that hides that is worse than useless.
 */
import { rul, damageTypes } from "./Ruleset";

/** OXCE RuleDamageType constructor defaults. */
export const ALTER_DEFAULTS = {
  ArmorEffectiveness: 1.0,
  ToArmorPre: 0.0,
  ToArmor: 0.1,
  ToHealth: 1.0,
  ToStun: 0.25,
  ToWound: 1.0,
  ToTime: 0.0,
  ToEnergy: 0.0,
  ToMorale: 0.0,
  ToMana: 0.0,
  RandomHealth: false,
  RandomStun: true,
  RandomWound: true,
  RandomArmorPre: false,
  RandomArmor: false,
  RandomType: 8,
};

/**
 * Per-damage-type overrides of ALTER_DEFAULTS.
 *
 * Transcribed from the "Item Damage Types" table in the OXCE reference that
 * ships with the mod (mods/xpedia/Language/STR_RULESET_REFERENCE_HTML.en-US.html).
 * A blank cell there means "use the generic default", so only the cells that
 * actually carried a value appear below.
 *
 * Keyed by the damage type INDEX, because that is what the engine keys on - the
 * mod renames the types but keeps the slots, so XPiratez's own names line up
 * with the engine's meaning:
 *
 *   0 CHARM=DT_NONE   1 PIERCING=DT_AP    2 BURN=DT_IN     3 CONCUSSIVE=DT_HE
 *   4 LASER           5 PLASMA            6 DAZE=DT_STUN   7 CUTTING=DT_MELEE
 *   8 CHEM=DT_ACID    9 CHOKING=DT_SMOKE  10-19 share one column
 *
 * This is what makes a stun weapon read correctly without the mod having to
 * spell it out: index 6 defaults to ToHealth 0 / ToStun 1, so a daze weapon
 * does stun damage rather than the 25%-of-health the generic default implies.
 * Likewise burn and choking default to ArmorEffectiveness 0 - they ignore
 * armour entirely, exactly as the community damage guide describes.
 *
 * Anything the weapon states in its own damageAlter still wins over these.
 */
export const DAMAGE_TYPE_DEFAULTS: { [dt: number]: { [k: string]: any } } = {
  0: { RandomType: 5 },
  1: { RandomType: 8, IgnoreOverKill: true },
  2: {
    RandomType: 4,
    ArmorEffectiveness: 0.0,
    ToHealth: 1.0,
    ToArmor: 0.0,
    ToWound: 0.0,
    ToItem: 0.0,
    ToTile: 0.0,
    ToStun: 0.0,
    FixRadius: -1,
    IgnoreOverKill: true,
    IgnoreDirection: true,
  },
  3: { RandomType: 9, ToItem: 1.0, FixRadius: -1, IgnoreOverKill: true },
  4: { RandomType: 8, IgnoreOverKill: true },
  5: { RandomType: 8, IgnoreOverKill: true },
  6: {
    RandomType: 8,
    ToHealth: 0.0,
    ToArmor: 0.0,
    ToWound: 0.0,
    ToItem: 0.0,
    ToTile: 0.0,
    ToStun: 1.0,
    RandomStun: false,
    FixRadius: -1,
    IgnoreOverKill: true,
    IgnorePainImmunity: true,
  },
  7: { RandomType: 8, IgnoreOverKill: true },
  8: { RandomType: 8, IgnoreOverKill: true },
  9: {
    RandomType: 5,
    ArmorEffectiveness: 0.0,
    ToHealth: 0.0,
    ToArmor: 0.0,
    ToWound: 0.0,
    ToItem: 0.0,
    ToTile: 0.0,
    ToStun: 1.0,
    FixRadius: -1,
    IgnoreOverKill: true,
    IgnoreDirection: true,
  },
};

/** Types 10-19 share a single column in the table. */
export const DAMAGE_TYPE_DEFAULTS_HIGH = { RandomType: 8, IgnoreOverKill: true };

/** The per-type override set for a damage type index, or an empty object. */
export function damageTypeDefaults(dt: number): { [k: string]: any } {
  const n = +dt;
  if (isNaN(n)) return {};
  if (n >= 10) return DAMAGE_TYPE_DEFAULTS_HIGH;
  return DAMAGE_TYPE_DEFAULTS[n] || {};
}

/**
 * Mod-level constants, read from the ruleset rather than assumed.
 *
 * Every one of these is a top-level key a ruleset may override (Mod.cpp reads
 * them straight off the merged YAML), and the engine default is only the
 * fallback. XPiratez leaves all of them alone, so nothing here changes for it -
 * but a different mod is exactly the case this has to survive, and a hardcoded
 * damageRange would silently misreport every weapon in it.
 */
export function modGlobal(key: string, def: number): number {
  const v = rul && rul.raw ? rul.raw[key] : undefined;
  return v == null || v === "" || isNaN(+v) ? def : +v;
}

/** DRT_STANDARD width: 100 means 0-200% of power. */
const damageRange = () => modGlobal("damageRange", 100);
/** DRT_EXPLOSION width: 50 means 50-150%. */
const explosiveDamageRange = () => modGlobal("explosiveDamageRange", 50);

/**
 * DRT_FIRE window, which is a flat range independent of power. A two-element
 * list in the ruleset, so it needs its own reader rather than modGlobal.
 */
function fireDamageRange(): number[] {
  const v = rul && rul.raw ? rul.raw.fireDamageRange : null;
  if (Array.isArray(v) && v.length == 2 && !isNaN(+v[0]) && !isNaN(+v[1]))
    return [+v[0], +v[1]];
  return [5, 10];
}

export type Stats = { [k: string]: number };

/**
 * How many of a shotgun's pellets to assume land on the target.
 *
 *   "derived" - scale by the engine's own pellet precision (see pelletSpread)
 *   "all"     - every pellet connects; the optimistic bound
 *   "first"   - only the aimed pellet connects; the pessimistic bound
 *
 * Worth knowing why this is a setting rather than a calculation. OXCE fires each
 * pellet as its own projectile and resolves it with a voxel trace against the
 * target's model, so whether a scattered pellet connects depends on range, the
 * target's size and whatever is in the way. That is not derivable from the
 * ruleset. What IS derivable is how tightly the pellets are thrown, and
 * "derived" uses exactly that - but the step from tightness to hits is an
 * approximation, and it is labelled as one in the UI.
 */
export type PelletModel = "derived" | "all" | "first";

/**
 * Pellet precision, 0 (maximum scatter) to 1 (no scatter).
 *
 * From ProjectileFlyBState. shotgunSpread comes off the AMMO, shotgunChoke off
 * the WEAPON, and the two behaviours differ:
 *
 *   behavior 1 (what XPiratez uses on 83 items):
 *     precision = (1 - spread/100) * choke/100
 *     One value for every pellet, and they cluster around where the FIRST
 *     pellet actually hit rather than around the original aim point.
 *
 *   behavior 0 (vanilla, one item in XPiratez):
 *     pellet i gets accuracy/100 - i*5*spread/100
 *     which at the default spread of 100 is zero for every pellet after the
 *     first - they scatter as widely as the engine allows.
 */
/**
 * Ruleset defaults for the shotgun fields. These matter more than they look:
 * an unset spread means FULL scatter, not none, so reading a missing value as
 * zero claims every pellet lands when the engine would throw them everywhere.
 */
export const SHOTGUN_DEFAULTS = { behavior: 0, spread: 100, choke: 100 };

const orDefault = (v: any, def: number) =>
  v == null || v === "" || isNaN(+v) ? def : +v;

export function pelletPrecision(
  behavior: number,
  spread: number,
  choke: number,
  pelletIndex: number,
  accuracyPct: number
): number {
  const b = orDefault(behavior, SHOTGUN_DEFAULTS.behavior);
  const sp = orDefault(spread, SHOTGUN_DEFAULTS.spread);
  const ch = orDefault(choke, SHOTGUN_DEFAULTS.choke);

  if (b === 1) {
    return Math.min(1, Math.max(0, (1 - sp / 100) * (ch / 100)));
  }
  const p = (+accuracyPct || 0) / 100 - pelletIndex * 5 * (sp / 100);
  return Math.min(1, Math.max(0, p));
}

/**
 * Expected number of projectiles landing on the target.
 *
 * The aimed pellet is counted as connecting; the rest are scaled by precision.
 * Never exceeds the number fired, never drops below one.
 */
export function expectedHits(
  pellets: number,
  model: PelletModel,
  behavior: number,
  spread: number,
  choke: number,
  accuracyPct: number
): number {
  const n = Math.max(1, +pellets || 1);
  if (n === 1) return 1;
  if (model === "all") return n;
  if (model === "first") return 1;

  if (orDefault(behavior, SHOTGUN_DEFAULTS.behavior) === 1) {
    const p = pelletPrecision(1, spread, choke, 1, accuracyPct);
    return 1 + (n - 1) * p;
  }
  // behavior 0 decays per pellet, so sum them rather than scaling one value.
  let total = 1;
  for (let i = 1; i < n; i++)
    total += pelletPrecision(0, spread, choke, i, accuracyPct);
  return total;
}

/**
 * The stat keys a soldier form offers.
 *
 * Two are not in Ruleset's own statsList and both matter:
 *   mana - every unit in the mod has it, the list just never caught up
 *   rank - a damage-bonus input on 12 weapons (the Laslock Shotgun's power
 *          scales with it: base 16 for a swabby, 31 for a Pirate Queen).
 *          Leaving it out silently zeroed the bonus on all of them.
 */
export const STAT_KEYS = [
  "tu", "stamina", "health", "bravery", "reactions", "firing",
  "throwing", "strength", "psiStrength", "psiSkill", "melee", "mana", "rank",
];

/**
 * Stats the ruleset does not give min/max/cap values for, so the form needs
 * its own bounds. Rank is the six standard OpenXcom promotion steps, which
 * XPiratez names swabby(0) through pirate queen(5).
 */
export const STAT_BOUNDS: { [k: string]: { def: number; cap: number } } = {
  rank: { def: 1, cap: 5 },
};

/**
 * Evaluate one of the mod's stat formulas: `{flatHundred: 0.15, strength: 0.5}`
 * means "+15, plus half of Strength".
 *
 *   flatHundred: c  ->  100 * c
 *   flatOne:     c  ->        c
 *   <stat>:      c  ->  c * stat
 *   <stat>: [a,b]   ->  a*stat + b*stat^2 + ...
 *
 * Same shape is used by damageBonus, meleeBonus, accuracyMultiplier,
 * meleeMultiplier, throwMultiplier, psiDefence and meleeDodge - which is why
 * this is one function rather than several.
 */
export function evalBonus(bonus: any, stats: Stats): number {
  if (!bonus || typeof bonus != "object") return 0;
  let total = 0;
  for (const key of Object.keys(bonus)) {
    const c = bonus[key];
    if (key == "flatHundred") {
      total += 100 * (+c || 0);
      continue;
    }
    if (key == "flatOne") {
      total += +c || 0;
      continue;
    }
    const stat = +stats[key] || 0;
    if (Array.isArray(c)) {
      for (let i = 0; i < c.length; i++) total += (+c[i] || 0) * Math.pow(stat, i + 1);
    } else {
      total += (+c || 0) * stat;
    }
  }
  return total;
}

/** A value with the probability of rolling it. */
export type Outcome = { v: number; p: number };

/**
 * The spread of "primary damage" around a power value.
 *
 * Returned as an explicit distribution rather than min/max, because the shape
 * matters: a flat 0-200% and a two-dice 0-200% have the same bounds and very
 * different odds of bouncing off armour.
 */
/**
 * Largest number of buckets a distribution is allowed.
 *
 * Enumerating every integer looks tidy and does not scale: a power-1000 weapon
 * spans 2000 values, and the two-dice convolution is O(power^2) - a million
 * iterations for one attack, times a couple of thousand attacks when the whole
 * weapon list is ranked. That froze the page. Sampling the same shape at a
 * fixed resolution is indistinguishable at display precision and bounded.
 */
const MAX_BUCKETS = 201;

/** Evenly spaced samples across [lo, hi], each equally likely. */
function uniformBuckets(lo: number, hi: number): Outcome[] {
  lo = Math.max(0, Math.round(lo));
  hi = Math.max(lo, Math.round(hi));
  const span = hi - lo + 1;
  if (span <= MAX_BUCKETS) {
    const out: Outcome[] = [];
    for (let v = lo; v <= hi; v++) out.push({ v, p: 1 / span });
    return out;
  }
  const out: Outcome[] = [];
  for (let i = 0; i < MAX_BUCKETS; i++) {
    out.push({ v: lo + ((hi - lo) * i) / (MAX_BUCKETS - 1), p: 1 / MAX_BUCKETS });
  }
  return out;
}

/**
 * Two independent rolls of 0..power summed: same bounds as a flat 0-200% but
 * triangular, so the extremes are rare. Sampled from the triangular density
 * rather than convolved, for the reason in MAX_BUCKETS.
 */
function twoDiceBuckets(power: number): Outcome[] {
  const hi = power * 2;
  if (power <= 0) return [{ v: 0, p: 1 }];
  const n = Math.min(MAX_BUCKETS, hi + 1);
  const out: Outcome[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = (hi * i) / (n - 1 || 1);
    // Triangular: density rises to the midpoint and falls away symmetrically.
    const w = power - Math.abs(v - power);
    const p = Math.max(w, 1e-9);
    out.push({ v, p });
    total += p;
  }
  for (const o of out) o.p /= total;
  return out;
}

export function rollDistribution(power: number, randomType: number): Outcome[] {
  const p = Math.max(0, Math.round(power));

  switch (randomType) {
    case 5: // DRT_NONE
      return [{ v: 0, p: 1 }];
    case 3: // DRT_FLAT
      return [{ v: p, p: 1 }];
    case 1: // DRT_UFO - 0..200%
      return uniformBuckets(0, p * 2);
    case 2: // DRT_TFTD - 50..150%
      return uniformBuckets(p * 0.5, p * 1.5);
    case 7: // DRT_EASY - 50..200%
      return uniformBuckets(p * 0.5, p * 2);
    case 4: { // DRT_FIRE - a flat window, independent of power
      const fire = fireDamageRange();
      return uniformBuckets(fire[0], fire[1]);
    }
    case 9: { // DRT_EXPLOSION
      const w = explosiveDamageRange();
      return uniformBuckets((p * (100 - w)) / 100, (p * (100 + w)) / 100);
    }
    case 6: // DRT_UFO_WITH_TWO_DICE
      return twoDiceBuckets(p);
    case 0: // DRT_DEFAULT - resolves per damage type; treated as standard here
    case 8: // DRT_STANDARD
    default:
      const w = damageRange();
      return uniformBuckets((p * (100 - w)) / 100, (p * (100 + w)) / 100);
  }
}

/**
 * Reading of an alter key, falling back the way the engine does:
 * the weapon's own damageAlter, then the damage type's default, then the
 * generic default.
 *
 * `dt` is optional only so older callers keep working; pass it, or a stun
 * weapon that does not spell out ToStun will be read as a health weapon.
 */
export function alterValue(alter: any, key: string, dt?: number): any {
  const generic = ALTER_DEFAULTS[key];
  const perType = dt == null ? undefined : damageTypeDefaults(dt)[key];
  const fallback = perType === undefined ? generic : perType;

  const v = alter ? alter[key] : undefined;
  if (v === undefined || v === null || v === "") return fallback;

  const wantsBool = typeof generic == "boolean" || typeof fallback == "boolean";
  if (wantsBool) {
    if (typeof v == "boolean") return v;
    return String(v).toLowerCase() == "true";
  }
  const n = +v;
  return isNaN(n) ? fallback : n;
}

export type Target = {
  id: string;
  title: string;
  /** The unit entry, when the target is a unit rather than a bare armour. */
  unit: any;
  /** The armour actually worn - where resistances and armour values live. */
  armor: any;
  health: number;
  /** ARMOR_ENERGY_SHIELD_* tags, when present. Not modelled, only reported. */
  shield: { capacity: number; perTurn: number; type: number };
};

/** Resolve an id to something shootable: a unit, or an armour on its own. */
export function resolveTarget(id: string): Target {
  if (!id) return null;
  const unit = rul.units ? rul.units[id] : null;
  const armor = unit ? rul.armors[unit.armor] : rul.armors ? rul.armors[id] : null;
  if (!armor) return null;

  const tags = armor.tags || {};
  const cap = +tags.ARMOR_ENERGY_SHIELD_CAPACITY || 0;

  return {
    id,
    title: rul.tr(id),
    unit,
    armor,
    health: (unit && unit.stats && +unit.stats.health) || 0,
    shield: cap
      ? {
          capacity: cap,
          perTurn: +tags.ARMOR_ENERGY_SHIELD_PER_TURN || 0,
          type: +tags.ARMOR_ENERGY_SHIELD_TYPE || 0,
        }
      : null,
  };
}

export const SIDES = ["Front", "Side", "Rear", "Under"];

/** Armour value on one facing, falling back to Front. */
export function armorValue(target: Target, side: string): number {
  if (!target || !target.armor) return 0;
  const a = target.armor.armor || {};
  const v = a[side];
  return +(v != null ? v : a.Front) || 0;
}

export type DamageResult = {
  /** Power after stat bonuses, before the roll. */
  power: number;
  /** Resistance multiplier actually applied, 1 = neutral. */
  resist: number;
  damageTypeName: string;
  effectiveArmor: number;
  /**
   * The rolled damage before armour, after resistance. Carried rather than
   * reconstructed: post-armour damage is clamped at zero, so adding the armour
   * back to it reports a power-18 shell as rolling 32-36 instead of 0-36.
   */
  rollMin: number;
  rollMax: number;
  /** Post-armour damage: the number every To* factor is taken from. */
  min: number;
  max: number;
  avg: number;
  /** Share of rolls that fail to beat armour at all. */
  pZero: number;
  avgHealth: number;
  avgStun: number;
  avgWounds: number;
  /** Projectiles the attack throws: shots x pellets. */
  hitsPerAttack: number;
  /**
   * Projectiles expected to land. Equal to hitsPerAttack for anything that is
   * not a shotgun; below it once pellets scatter. This is what the per-attack
   * damage is scaled by.
   */
  expectedHitsPerAttack: number;
  avgHealthPerAttack: number;
  avgStunPerAttack: number;
  /** Armour on this facing that the numbers above were computed against. */
  armorAtStart: number;
  /**
   * Armour stripped by one projectile, split the way the engine splits it:
   *
   *   avgArmorPre  = ToArmorPre  x the resisted ROLL - lands even when the
   *                  attack fails to scratch the unit
   *   avgArmorPost = ToArmor     x the damage that got THROUGH, so zero on a
   *                  hit that bounced
   */
  avgArmorPre: number;
  avgArmorPost: number;
  avgArmorLoss: number;
  /** Armour stripped by the whole attack, capped at the armour that is there. */
  armorLossPerAttack: number;
};

/**
 * Everything about an attack that does not depend on the target's armour.
 *
 * Split out for one reason: armour degrades as you shoot it, so a useful
 * attacks-to-kill has to re-resolve the damage at every armour value along the
 * way. The roll distribution is the expensive part and it never changes, so it
 * is built once here and the cheap part (applyArmor) runs per step.
 */
export type DamageProfile = {
  power: number;
  resist: number;
  dt: number;
  damageTypeName: string;
  armorEff: number;
  /** The rolled damage, resistance already applied. */
  dist: Outcome[];
  rollMin: number;
  rollMax: number;
  toHealth: number;
  toStun: number;
  toWound: number;
  toArmorPre: number;
  toArmor: number;
  randomHealth: boolean;
  randomStun: boolean;
  randomWound: boolean;
  randomArmorPre: boolean;
  randomArmor: boolean;
  shots: number;
  pellets: number;
  hitsPerAttack: number;
  /** Projectiles expected to land, shots x expectedHits(pellets). */
  landed: number;
};

export function damageProfile(
  attack: any,
  attackerStats: Stats,
  target: Target,
  pelletModel: PelletModel = "derived",
  accuracyPct = 0
): DamageProfile {
  if (!attack || target == null) return null;

  const alter = attack.alter || {};
  const basePower = +attack.damage || 0;
  const power = basePower + evalBonus(attack.damageBonus, attackerStats);

  const dt = +attack.damageType;
  const mods = target.armor ? target.armor.damageModifier : null;
  const resist = Array.isArray(mods) && mods[dt] != null ? +mods[dt] : 1;

  // Resistance first, then armour. Folding it into the distribution here is
  // what makes that ordering impossible to get wrong further down.
  // Floored, because the engine's damage is an int all the way through:
  // reduceByResistance assigns a float product back into an int, so the
  // Ninja Warrior's 80% cutting resistance turns a 106 roll into 84, not 84.8.
  const dist = rollDistribution(power, alterValue(alter, "RandomType", dt)).map((o) => ({
    v: Math.floor(o.v * resist),
    p: o.p,
  }));
  let rollMin = Infinity;
  let rollMax = -Infinity;
  for (const o of dist) {
    if (o.v < rollMin) rollMin = o.v;
    if (o.v > rollMax) rollMax = o.v;
  }

  const shots = +attack.shots || 1;
  const pellets = +attack.pellets || 1;
  // Pellets scatter; shots do not - each aimed burst round gets its own roll.
  const landed =
    shots *
    expectedHits(
      pellets,
      pelletModel,
      attack.shotgunBehavior,
      attack.shotgunSpread,
      attack.shotgunChoke,
      accuracyPct
    );

  return {
    power,
    resist,
    dt,
    damageTypeName: damageTypes[dt] || String(dt),
    armorEff: alterValue(alter, "ArmorEffectiveness", dt),
    dist,
    rollMin: rollMin === Infinity ? 0 : rollMin,
    rollMax: rollMax === -Infinity ? 0 : rollMax,
    toHealth: alterValue(alter, "ToHealth", dt),
    toStun: alterValue(alter, "ToStun", dt),
    toWound: alterValue(alter, "ToWound", dt),
    toArmorPre: alterValue(alter, "ToArmorPre", dt),
    toArmor: alterValue(alter, "ToArmor", dt),
    randomHealth: alterValue(alter, "RandomHealth", dt),
    randomStun: alterValue(alter, "RandomStun", dt),
    randomWound: alterValue(alter, "RandomWound", dt),
    randomArmorPre: alterValue(alter, "RandomArmorPre", dt),
    randomArmor: alterValue(alter, "RandomArmor", dt),
    shots,
    pellets,
    hitsPerAttack: shots * pellets,
    landed,
  };
}

/** Resolve a profile against one armour value. */
export function applyArmor(p: DamageProfile, armor: number): DamageResult {
  const standing = Math.max(0, armor);
  const effectiveArmor = standing * p.armorEff;

  let min = Infinity;
  let max = -Infinity;
  let avg = 0;
  let pZero = 0;
  let avgHealth = 0;
  let avgStun = 0;
  let avgWounds = 0;
  let avgArmorPre = 0;
  let avgArmorPost = 0;

  for (const o of p.dist) {
    // Also an int: `damage -= getArmor(side) * ArmorEffectiveness` assigns a
    // float back into an int, so 56 through 25.5 effective armour is 30, not
    // 30.5. Clamped at zero the way the engine clamps it.
    const dmg = Math.max(0, Math.floor(o.v - effectiveArmor));

    if (dmg < min) min = dmg;
    if (dmg > max) max = dmg;
    avg += dmg * o.p;
    if (dmg <= 0) pZero += o.p;

    avgHealth += term(p.randomHealth, dmg, p.toHealth) * o.p;
    avgStun += term(p.randomStun, dmg, p.toStun) * o.p;

    // Armour pre-damage is taken from the ROLL and does not care whether the
    // shot penetrated - this is the term that lets a weapon that cannot hurt a
    // tank still grind its plating off.
    avgArmorPre += term(p.randomArmorPre, o.v, p.toArmorPre) * o.p;
    avgArmorPost += term(p.randomArmor, dmg, p.toArmor) * o.p;

    if (dmg > 0) {
      if (p.randomWound) {
        // if rand(0,10) < damage*ToWound then 1-3 wounds, so 2 on average.
        const chance = Math.min(1, Math.max(0, (dmg * p.toWound) / 11));
        avgWounds += chance * 2 * o.p;
      } else {
        avgWounds += Math.round(dmg * p.toWound) * o.p;
      }
    }
  }

  const avgArmorLoss = avgArmorPre + avgArmorPost;

  return {
    power: p.power,
    resist: p.resist,
    damageTypeName: p.damageTypeName,
    effectiveArmor,
    rollMin: p.rollMin,
    rollMax: p.rollMax,
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    avg,
    // Summing many floats drifts past 1; a probability never should.
    pZero: Math.min(1, Math.max(0, pZero)),
    avgHealth,
    avgStun,
    avgWounds,
    hitsPerAttack: p.hitsPerAttack,
    expectedHitsPerAttack: p.landed,
    avgHealthPerAttack: avgHealth * p.landed,
    avgStunPerAttack: avgStun * p.landed,
    armorAtStart: standing,
    avgArmorPre,
    avgArmorPost,
    avgArmorLoss,
    // setValueMax clamps at zero: an attack cannot strip more than is there.
    armorLossPerAttack: Math.min(standing, avgArmorLoss * p.landed),
  };
}

/**
 * One To* term, the way getDamageHelper computes it:
 *
 *   if (damage > 0) return round(random ? rand(0, damage) * mult : damage * mult);
 *   else            return 0;
 *
 * The rounding is not cosmetic. ToArmor is 0.1 by default, so a hit that gets
 * 4 damage through does round(0.4) = ZERO armour damage, while one that gets 35
 * through does 4 - which is exactly the number the community guide arrives at
 * by hand. Averaging the rounded value across the roll distribution is the
 * expectation; rounding the average afterwards is not the same thing.
 *
 * The one approximation left is the randomised branch: rand(0, damage) averages
 * damage/2, and its own rounding is left out rather than convolving a second
 * uniform through the whole distribution.
 */
function term(random: boolean, damage: number, mult: number): number {
  if (!(damage > 0) || !mult) return 0;
  return random ? (damage / 2) * mult : Math.round(damage * mult);
}

/**
 * Expected damage of one attack against one target.
 *
 * `attack` must already have ammo merged in (see mergedAttack) - an ammo-fed
 * weapon carries no damage of its own.
 */
export function computeDamage(
  attack: any,
  attackerStats: Stats,
  target: Target,
  side: string,
  pelletModel: PelletModel = "derived",
  accuracyPct = 0,
  armorOverride?: number
): DamageResult {
  const p = damageProfile(attack, attackerStats, target, pelletModel, accuracyPct);
  if (!p) return null;
  return applyArmor(p, armorOverride == null ? armorValue(target, side) : armorOverride);
}

/**
 * What it actually takes to put a target down, shot by shot.
 *
 * The closed form this replaces - ceil(health / damage per attack) - assumes
 * every attack is as good as the first, and armour degradation makes that false
 * in both directions:
 *
 *   - A chem or plasma weapon strips the plating as it fires, so shot five
 *     hits a softer target than shot one. Dividing understates it.
 *   - A weapon that cannot currently penetrate at all still has a ToArmorPre
 *     term, so it grinds the armour down and eventually starts hurting. The
 *     division says "never"; the truth is "after six shots".
 *
 * Both come straight out of the engine's own accounting (see the header), and
 * the second one is the whole reason the mod's armour-shredders exist.
 *
 * Cost is kept down two ways: the roll distribution is built once by the
 * caller, and resolved results are cached per whole point of armour, because
 * the engine's armour IS an integer and a sequence can only ever walk down it.
 */
export type KillSequence = {
  /** Whole attacks expected to drop the target, or null if it never does. */
  attacks: number;
  /** Armour left on that facing when the target goes down. */
  armorEnd: number;
  armorStart: number;
  /** First attack that gets any damage through, or null if none ever does. */
  attacksToPenetrate: number;
  /** Whether this attack strips armour at all. */
  degrades: boolean;
  /** Resolved damage against the armour as it stands now: the first shot. */
  first: DamageResult;
};

export function simulateAttacks(
  p: DamageProfile,
  armorStart: number,
  pool: number,
  goal: "kill" | "stun",
  hitRate: number,
  maxAttacks: number
): KillSequence {
  const cache: { [a: number]: DamageResult } = {};
  const at = (a: number) => cache[a] || (cache[a] = applyArmor(p, a));

  let armor = Math.max(0, armorStart);
  const first = at(Math.round(armor));
  const out: KillSequence = {
    attacks: null,
    armorEnd: armor,
    armorStart: armor,
    attacksToPenetrate: null,
    degrades: first.armorLossPerAttack > 0,
    first,
  };
  if (!(pool > 0)) return out;

  const track = (d: DamageResult) =>
    (goal == "stun" ? d.avgStunPerAttack : d.avgHealthPerAttack) * hitRate;

  let left = pool;
  let attacks = 0;

  for (;;) {
    const d = at(Math.round(armor));
    const per = track(d);
    // Armour only matters to the damage while ArmorEffectiveness is non-zero -
    // a burn weapon can be shredding plating that was never in its way.
    const loss = p.armorEff > 0 ? d.armorLossPerAttack * hitRate : 0;

    // Nothing more will change, so the rest is arithmetic rather than a loop.
    if (loss <= 0) {
      if (per <= 0) return out;
      const more = Math.max(1, Math.ceil(left / per));
      if (attacks + more > maxAttacks) return out;
      out.attacksToPenetrate = out.attacksToPenetrate != null ? out.attacksToPenetrate : attacks + 1;
      out.attacks = attacks + more;
      out.armorEnd = armor;
      return out;
    }

    attacks++;
    if (attacks > maxAttacks) return out;
    if (per > 0 && out.attacksToPenetrate == null) out.attacksToPenetrate = attacks;
    left -= per;
    if (left <= 0) {
      out.attacks = attacks;
      out.armorEnd = Math.max(0, armor - loss);
      return out;
    }
    armor = Math.max(0, armor - loss);
  }
}

/**
 * The accuracy figure the game puts on the firing panel.
 *
 * Deliberately NOT called a hit chance. OXCE resolves a shot with a voxel trace
 * against the target's model, cover and intervening terrain; this number is an
 * input to that, not the outcome of it. Reproducing what the panel shows is
 * useful and honest - claiming it is a probability would not be.
 */
/**
 * Engine defaults for the accuracy modifiers, used when neither the item nor
 * the ruleset's own globals state one. Same reasoning as modGlobal above: an
 * item override wins, then the mod global, then these.
 */
export const GLOBALS = {
  kneelBonus: 120,
  oneHandedPenalty: 50,
  noLOSAccuracyPenalty: 50,
};

/** Item value, else the mod global, else the engine default. */
function accuracyGlobal(item: any, key: string): number {
  const own = item ? +item[key] : NaN;
  if (!isNaN(own) && item[key] != null) return own;
  return modGlobal(key, GLOBALS[key]);
}

export type AccuracyOpts = {
  distance: number;
  kneeling: boolean;
  oneHanded: boolean;
  /**
   * Whether UFO Extender accuracy is in force. Not a cosmetic setting, and not
   * "is there range falloff" either - see rangeLimits.
   */
  ufoExtender?: boolean;
  noLOS: boolean;
};

/**
 * Engine defaults for the range fields (RuleItem's constructor).
 *
 * A throw has its own pair, and they are why thrown weapons never show a range
 * penalty here: the dropoff range is 99 tiles and maxViewDistance is 40, so a
 * throw cannot reach the limit. XPiratez overrides neither field.
 */
const RANGE_DEFAULTS = {
  dropoff: 2,
  minRange: 0,
  maxRange: 200,
  throwDropoff: 5,
  throwDropoffRange: 99,
  aimRange: 200,
};

export type RangeLimits = {
  upper: number;
  lower: number;
  dropoff: number;
  /** Which limit actually costs accuracy at this distance, if either. */
  governing: "upper" | "lower" | null;
};

/**
 * The range window a shot is judged against, ported from RuleItem::calculateLimits.
 *
 * This is the whole of what the UFO Extender option does, and it is worth being
 * precise because the popular summary is wrong in both directions. It is NOT
 * cosmetic, and turning it OFF does NOT remove range falloff:
 *
 *             snap                  auto                  aimed
 *   on        snapRange (def 15)    autoRange (def 7)     aimRange (def 200)
 *   off       aimRange              aimRange              aimRange
 *
 * So off means every mode is judged against the AIMED range, which for a weapon
 * that never states one is 200 tiles and therefore no falloff in practice - but
 * for a weapon with a short aimRange it is a real penalty on every mode. Of the
 * XPiratez items, 260 state an aimRange.
 *
 * minRange is not gated by the option at all: standing too close costs you the
 * same dropoff per tile either way. maxRange is not part of this - it is a hard
 * cut-off, applied separately by the caller.
 *
 * The mod can also take the choice away. XPiratez pins the option on through
 * `fixedUserOptions` (Piratez_Globals.rul:9106), which OXCE honours over the
 * player's own options.cfg, so for this mod the ON column is the only reality.
 */
export function rangeLimits(
  attack: any,
  item: any,
  aimedRange: number,
  ufoExtender = true
): RangeLimits {
  const isThrow = attack && attack.mode == "throw";
  const num = (v: any, def: number) => (v == null || v === "" || isNaN(+v) ? def : +v);

  const aimed = num(aimedRange, RANGE_DEFAULTS.aimRange);
  let upper: number;
  if (isThrow) {
    upper = ufoExtender
      ? num(item && item.throwDropoffRange, RANGE_DEFAULTS.throwDropoffRange)
      : RANGE_DEFAULTS.maxRange;
  } else {
    upper = ufoExtender ? num(attack && attack.range, aimed) : aimed;
  }

  const lower = isThrow ? 0 : num(item && item.minRange, RANGE_DEFAULTS.minRange);
  const dropoff = isThrow
    ? num(item && item.throwDropoff, RANGE_DEFAULTS.throwDropoff)
    : num(item && item.dropoff, RANGE_DEFAULTS.dropoff);

  return { upper, lower, dropoff, governing: null };
}

/** The limits with `governing` filled in for one distance. */
export function rangeAt(
  attack: any,
  item: any,
  aimedRange: number,
  ufoExtender: boolean,
  distance: number
): RangeLimits {
  const l = rangeLimits(attack, item, aimedRange, ufoExtender);
  // Whole tiles: the engine's distance is ceil(sqrt(distanceSq)), an int.
  const d = Math.floor(+distance || 0);
  if (l.upper && d > l.upper) l.governing = "upper";
  else if (l.lower && d < l.lower) l.governing = "lower";
  return l;
}

export function accuracyPercent(
  attack: any,
  item: any,
  stats: Stats,
  opts: AccuracyOpts,
  aimedRange?: number
): number {
  if (!attack) return 0;
  const base = +attack.accuracy || 0;
  /**
   * The multiplier formula yields a PERCENTAGE, not a factor: {firing: 1} means
   * "100% of Firing", so a 57-Firing gal scores 57, and a 70-accuracy weapon
   * ends up at 70 x 0.57 = 40%. Forgetting the /100 gives accuracies in the
   * thousands, which is how this was first written.
   *
   * Truncated, and then every step below truncates too, because this is all
   * int arithmetic in the engine (BattleUnit::getFiringAccuracy):
   *
   *   result = item->getRules()->getAccuracyMultiplier(attack)
   *          * item->getRules()->getAccuracySnap() / 100;
   *   if (kneeled) result = result * getKneelBonus(mod) / 100;
   *   ...
   *   return result * modifier / 100;
   *
   * and RuleStatBonus::getBonus returns an int. A Boarding Gun in the hands of
   * a 70-Firing gal is 0.65x70 + 35 = 80.5 -> 80, not 80.5, and float maths
   * here would report a percent that the game never shows.
   */
  const multPct = Math.trunc(evalBonus(attack.accuracyMultiplier, stats));

  let acc = Math.trunc((multPct * base) / 100);
  if (opts.kneeling) acc = Math.trunc((acc * accuracyGlobal(item, "kneelBonus")) / 100);
  if (opts.oneHanded && item.twoHanded)
    acc = Math.trunc((acc * accuracyGlobal(item, "oneHandedPenalty")) / 100);
  // Not part of getFiringAccuracy - the engine applies this one when the shot
  // is actually resolved without line of sight, so it is off the panel figure.
  if (opts.noLOS) acc = Math.trunc((acc * accuracyGlobal(item, "noLOSAccuracyPenalty")) / 100);

  // Range falloff. Which limit applies depends on the UFO Extender option, and
  // rangeLimits is the only place that branch is stated.
  const distance = Math.floor(+opts.distance || 0);
  const limits = rangeAt(
    attack,
    item,
    aimedRange == null ? +attack.range : aimedRange,
    opts.ufoExtender !== false,
    distance
  );
  if (limits.governing == "upper") acc -= limits.dropoff * (distance - limits.upper);
  else if (limits.governing == "lower") acc -= limits.dropoff * (limits.lower - distance);

  // Separate from all of the above, and not affected by the option: past
  // maxRange the shot simply cannot be taken.
  const maxRange = +item.maxRange;
  if (maxRange && distance > maxRange) return 0;

  return Math.max(0, acc);
}

/**
 * OXCE RuleItem defaults for costs the ruleset can leave out. Only throwing has
 * one that matters here: a grenade usually writes costThrow with just an energy
 * cost, and the time silently stays at the engine's 25%.
 */
const DEFAULT_TU_PERCENT: { [mode: string]: number } = { throw: 25 };

/**
 * TU one attack costs. Most weapons quote a percentage of the firer's TU bar;
 * only flatRate weapons quote an absolute number.
 *
 * An absent cost falls back to the engine default; an explicit zero is left as
 * zero, because some items really are free to use and the caller needs to be
 * able to tell the two apart.
 */
export function tuPerAttack(attack: any, stats: Stats): number {
  const tu = +stats.tu || 0;
  if (!attack || !attack.cost) return 0;
  let t = attack.cost.time;
  if (t == null && attack.mode in DEFAULT_TU_PERCENT) t = DEFAULT_TU_PERCENT[attack.mode];
  const n = +t || 0;
  if (n <= 0) return 0;

  // Whole time units only. A percentage cost is taken off the firer's own bar -
  // 30% on a 100 TU gal is 30 TU, not a fraction of one - truncated the way the
  // engine does it, and never below 1: you cannot fire part of a shot.
  const raw = attack.flatTime ? n : (n * tu) / 100;
  return Math.max(1, Math.floor(raw));
}

/** How many times this attack can be made with a full TU bar. */
export function attacksPerTurn(attack: any, stats: Stats): number {
  const tu = +stats.tu || 0;
  const cost = tuPerAttack(attack, stats);
  if (!tu || cost <= 0) return 0;
  return Math.floor(tu / cost);
}
