/**
 * How far away you can actually see this enemy.
 *
 * Sight is the constant every weapon is measured against. A gal advances, spots
 * something at her view distance, and only THEN does the player choose: shoot
 * from here, or close the distance. A rifle shoots from there for free; a
 * Sawed-Off has to walk to four tiles; a cutlass has to walk to one. That walk
 * is the real, comparable cost, and it is meaningless without knowing where the
 * spotting happened.
 *
 * And sight is not one number. It swings with the light, with the armour the
 * gal is wearing, and with how well the enemy is hidden. Against a camouflaged
 * target the whole ranking inverts, because you cannot shoot what you cannot
 * see - which is exactly why melee is good against catgirls.
 *
 * PORTED FROM SOURCE, not from the wiki. A distributed OXCE build ships only
 * the binary and data, so this came from MeridianOXC/OpenXcom, branch
 * oxce-plus, src/Savegame/BattleUnit.cpp:4593 -
 *
 *   int BattleUnit::getMaxViewDistance(int baseVisibility, int nerf, int buff) const
 *   {
 *       int result = baseVisibility;
 *       if (nerf > 0)  result = nerf;    // fixed distance nerf
 *       else           result += nerf;   // relative distance nerf
 *       if (result < 1) result = 1;      // can't go under melee distance
 *       result += buff;                  // relative distance buff
 *       if (result > baseVisibility) result = baseVisibility;  // don't overbuff
 *       return result;
 *   }
 *
 * with `nerf` the TARGET's camouflage and `buff` the VIEWER's anti-camouflage
 * (BattleUnit.cpp:4616 and :4633).
 *
 * Four things about that function are not obvious and all four change answers:
 *
 *   1. A POSITIVE camouflage is a hard cap, not a subtraction. `result = nerf`
 *      throws the base away entirely, so `camouflageAtDark: 5` means "seen only
 *      from five tiles" however good your night vision is.
 *   2. A NEGATIVE camouflage is a relative reduction instead. Both signs make
 *      the target harder to see; they just do it by different mechanisms.
 *   3. Anti-camouflage can never take you past your own base sight. It only
 *      claws back what camouflage took.
 *   4. The floor is 1 - "can't go under melee distance". Even perfect
 *      concealment is spotted when it is standing next to you.
 *
 * NOT modelled, deliberately: `heatVision` is NOT night vision. Its script
 * binding is getVisibilityThroughSmoke (BattleUnit.cpp:6771), i.e. smoke
 * penetration, and smoke is out of scope - so the 470 items carrying it change
 * nothing here. Neither is psiVision (seeing through walls), squad sight,
 * terrain blocking line of sight, or the soldier-bonus visibility terms.
 */
import { rul } from "./Ruleset";
import { modGlobal } from "./damageCalc";

/**
 * Engine defaults from BattleUnit.cpp:184-189 (soldiers) and :586-588 (others).
 *
 * Dark defaults to 9 for a player unit; a HOSTILE with no stated value gets the
 * global maximum instead, which is worth knowing but not something this tool
 * needs - we only ever compute what OUR soldier can see.
 */
export const SIGHT_DEFAULTS = {
  /** Fallback dark visibility for a unit whose armour does not state one. */
  dark: 9,
  /** Engine default for the global cap, when the mod does not override it. */
  maxViewDistance: 20,
};

/** The mod's global sight ceiling. XPiratez sets 40; the engine default is 20. */
export function maxViewDistance(): number {
  return modGlobal("maxViewDistance", SIGHT_DEFAULTS.maxViewDistance);
}

const num = (v: any): number => {
  const n = +v;
  return v == null || v === "" || isNaN(n) ? 0 : n;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * A viewer's base sight before the target is considered.
 *
 * `visibilityAtDay` / `visibilityAtDark` are falsy-checked in the engine, not
 * null-checked - a stated 0 falls back to the default exactly as an absent one
 * does, which is why num() collapsing both to 0 is faithful rather than sloppy.
 */
export function baseSight(armor: any, isDay: boolean): number {
  const cap = maxViewDistance();
  if (isDay) {
    const stated = num(armor && armor.visibilityAtDay);
    return clamp(stated || cap, 1, cap);
  }
  const stated = num(armor && armor.visibilityAtDark);
  return clamp(stated || SIGHT_DEFAULTS.dark, 1, cap);
}

/**
 * BattleUnit::getMaxViewDistance, ported branch for branch.
 *
 * Kept as its own exported function rather than inlined so the odd bits - the
 * positive nerf discarding the base, the floor of 1 applied BEFORE the buff -
 * can be tested directly against the hand-worked cases from the source.
 */
export function applySight(baseVisibility: number, nerf: number, buff: number): number {
  let result = baseVisibility;
  if (nerf > 0) result = nerf;
  else result += nerf;
  if (result < 1) result = 1;
  result += buff;
  if (result > baseVisibility) result = baseVisibility;
  return result;
}

export type SightBreakdown = {
  /** Tiles at which this soldier spots this enemy. */
  tiles: number;
  /** Her sight before the enemy's concealment is applied. */
  base: number;
  /** The enemy's camouflage for these light conditions. */
  camouflage: number;
  /** Her anti-camouflage for these light conditions. */
  antiCamouflage: number;
  isDay: boolean;
  /** True when a positive camouflage overrode the base outright. */
  capped: boolean;
  /** Everything either armour states that bears on seeing, modelled or not. */
  fields: SightField[];
};

/**
 * One visibility-related value, for display.
 *
 * `used` says whether it actually moved the number above. The ones that do not
 * are still shown, because "this armour has heatVision 50 and it changes
 * nothing here" is information - it stops the reader assuming the calculator
 * quietly folded it in.
 */
export type SightField = {
  key: string;
  label: string;
  /** "soldier" or "enemy" - whose armour it came from. */
  side: string;
  value: number;
  used: boolean;
  note: string;
};

/** Every visibility field worth surfacing, and what it does. */
const FIELD_NOTES: { [k: string]: string } = {
  visibilityAtDay:
    "How far this armour sees in daylight. Unset means the mod's maxViewDistance.",
  visibilityAtDark:
    "How far this armour sees in darkness. Unset means 9 tiles for a player unit.",
  camouflageAtDay:
    "How hard this unit is to see in daylight. POSITIVE is a hard cap replacing the viewer's sight outright; negative subtracts from it.",
  camouflageAtDark:
    "How hard this unit is to see in darkness. POSITIVE is a hard cap replacing the viewer's sight outright; negative subtracts from it.",
  antiCamouflageAtDay:
    "Sees through daylight camouflage. Can only claw back what camouflage took - never takes you past your own base sight.",
  antiCamouflageAtDark:
    "Sees through darkness camouflage. Can only claw back what camouflage took - never takes you past your own base sight.",
  personalLight:
    "Tiles this unit lights around itself. A target inside that radius counts as LIT, so day sight applies to it even at night. Not modelled: it never exceeds the dark sight distance on the armours checked.",
  heatVision:
    "NOT night vision, despite the name - its engine binding is getVisibilityThroughSmoke, so it is smoke penetration. Smoke is not modelled, so this changes nothing here.",
  psiVision:
    "Senses units through walls within this many tiles, regardless of light. Not modelled.",
  visibilityThroughSmoke: "Smoke penetration. Smoke is not modelled.",
  visibilityThroughFire: "Fire penetration. Fire is not modelled.",
};

/** Which fields are actually consumed by the arithmetic, per light condition. */
const USED_FIELDS = (isDay: boolean) => [
  isDay ? "visibilityAtDay" : "visibilityAtDark",
  isDay ? "camouflageAtDay" : "camouflageAtDark",
  isDay ? "antiCamouflageAtDay" : "antiCamouflageAtDark",
];

function collectFields(armor: any, side: string, isDay: boolean): SightField[] {
  const used = USED_FIELDS(isDay);
  const out: SightField[] = [];
  for (const key of Object.keys(FIELD_NOTES)) {
    // Camouflage belongs to whoever is being looked AT; the rest to the viewer.
    const isCamo = key.indexOf("camouflage") === 0;
    if (isCamo && side != "enemy") continue;
    if (!isCamo && key.indexOf("antiCamouflage") !== 0 && side == "enemy") continue;
    if (key.indexOf("antiCamouflage") === 0 && side != "soldier") continue;
    const v = num(armor && armor[key]);
    if (!v) continue;
    out.push({
      key,
      label: key,
      side,
      value: v,
      used: used.includes(key),
      note: FIELD_NOTES[key],
    });
  }
  return out;
}

/**
 * How far this soldier sees this enemy, with the working shown.
 *
 * `soldierArmor` may be null - a manually typed soldier with no armour picked
 * still needs a number, and the engine's own fallbacks are the honest one.
 */
export function sightDistance(
  soldierArmor: any,
  targetArmor: any,
  isDay = true
): SightBreakdown {
  const base = baseSight(soldierArmor, isDay);
  const camouflage = num(
    targetArmor && (isDay ? targetArmor.camouflageAtDay : targetArmor.camouflageAtDark)
  );
  const antiCamouflage = num(
    soldierArmor &&
      (isDay ? soldierArmor.antiCamouflageAtDay : soldierArmor.antiCamouflageAtDark)
  );
  return {
    tiles: applySight(base, camouflage, antiCamouflage),
    base,
    camouflage,
    antiCamouflage,
    isDay,
    capped: camouflage > 0,
    fields: [
      ...collectFields(soldierArmor, "soldier", isDay),
      ...collectFields(targetArmor, "enemy", isDay),
    ],
  };
}

/** One line explaining a sight number, for the tooltip. */
export function sightNote(s: SightBreakdown): string {
  if (!s) return "";
  const light = s.isDay ? "day" : "night";
  const parts = [s.base + " tiles " + light + " sight"];
  if (s.capped)
    parts.push("capped to " + s.camouflage + " by the enemy's camouflage (a positive value replaces your sight outright)");
  else if (s.camouflage < 0)
    parts.push(s.camouflage + " from the enemy's camouflage");
  if (s.antiCamouflage > 0)
    parts.push("+" + s.antiCamouflage + " anti-camouflage, which can never take you past your own base sight");
  if (s.tiles <= 1) parts.push("floored at 1 - you always spot something standing next to you");
  return parts.join(" · ") + " = " + s.tiles + " tiles";
}

/** Armour lookup for a resolved target, which stores the armour object already. */
export function targetArmorOf(target: any): any {
  return target ? target.armor : null;
}

/** Armour lookup by id, for the soldier side where only an id is held. */
export function armorById(id: string): any {
  if (!id || !rul || !rul.armors) return null;
  return rul.armors[id] || null;
}
