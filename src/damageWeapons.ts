/**
 * Turning the item list into something shootable.
 *
 * Kept apart from damageCalc.ts so the arithmetic there stays free of ruleset
 * trivia, and apart from compareDiff.ts so the calculator does not drag the
 * whole diff engine around with it.
 */
import { rul, battleTypes } from "./Ruleset";
import { withAmmo } from "./compareDiff";
import {
  damageProfile,
  simulateAttacks,
  armorValue,
  accuracyPercent,
  attacksPerTurn,
  tuPerAttack,
  rangeAt,
  rangeLimits,
  approachTu,
  fireDistance,
} from "./damageCalc";
import type { RangeLimits } from "./damageCalc";
import { effectivenessScore, SCORE_CONFIDENCE } from "./damageScore";
import { hitChance, targetGeometry } from "./damageHit";
import { sightDistance } from "./damageSight";
import type { PelletModel } from "./damageCalc";
import type { Stats, Target, DamageResult, AccuracyOpts } from "./damageCalc";

/** Firing modes worth ranking. `ammo` is the clip's own entry, not a mode you
 *  can choose, and psi/panic/mindControl do not use the damage pipeline. */
export const USABLE_MODES = ["snap", "aimed", "auto", "melee", "throw"];

/**
 * Past this many attacks the weapon is not killing the target and saying so is
 * more use than a number.
 *
 * A pistol-bash against 32 armour works out at 1026 swings and 9234 TU - both
 * arithmetically right and both useless, and the precision is fake anyway:
 * nearly every roll of that attack fails to beat the armour at all, so the
 * expected damage it is divided by is a rounding artefact.
 */
export const MAX_USEFUL_ATTACKS = 100;

/**
 * What an "unlimited" range counts as when averaging a hybrid's reach.
 *
 * 360 of the mod's ranged items never state an `aimRange`, so they inherit the
 * engine default of 200 tiles. Averaging that in literally makes a Hunting
 * Rifle's melee approach (18 + 200) / 2 = 109 tiles, or 436 TU, which is
 * nonsense. 30 tiles covers about 90% of any map, so past it the extra reach
 * buys nothing you would ever use.
 *
 * Applied per mode before the average, so a weapon that states a real range
 * shorter than this is untouched: the Flintlock's snap 15 and aimed 17 average
 * to 16 exactly as they should.
 */
export const UNLIMITED_RANGE_BENCHMARK = 30;

/**
 * What "effective" means for this comparison.
 *
 * XPiratez is as much a capture game as a killing one, and the two questions
 * have different answers - a daze weapon does no health damage at all, so
 * ranking it on health puts every stun weapon at the bottom marked unable.
 * A unit goes down when accumulated stun reaches its health, so the stun track
 * uses the same threshold against avgStunPerAttack.
 */
/**
 *   "drop"  down by any means - health out, or stun over whatever health is
 *           left. This is what you watch happen on screen, and the two tracks
 *           genuinely add: stun only has to cover the health damage did not.
 *   "kill"  dead specifically, health alone.
 *   "stun"  knocked out with stun alone, for a clean capture.
 */
export type Goal = "kill" | "stun" | "drop";

export type WeaponKind = "melee" | "ranged" | "thrown" | "other";

/**
 * Which firing modes a listing is interested in.
 *
 * The kind and damage-type filters are properties of a MODE, not of a weapon,
 * and applying them only at weapon level was visibly wrong: with Ranged
 * selected the Good Lookin' Rock still sat at the top on the strength of its
 * melee swing. A weapon qualifies if any mode matches, but once it is in the
 * list only the matching modes should be scored, ranked or shown.
 */
export type ModeFilter = (attack: any) => boolean;

export type WeaponOption = {
  item: any;
  id: string;
  title: string;
  /** Clips this weapon accepts, already filtered to ones that resolve. */
  ammoOptions: string[];
  /**
   * Every class this weapon belongs to. A list, not a single value: plenty of
   * XPiratez gear is a hybrid, and a blade with a ranged special should turn up
   * under both Melee and Ranged rather than only under whichever one
   * battleType happens to name.
   */
  kinds: WeaponKind[];
  /** Vehicle turret or armour built-in rather than something you pick up. */
  fixed: boolean;
  /**
   * The mod's own weapon-type tags, e.g. STR_BAT_CAT_PISTOL / _SHOTGUN / _RIFLE.
   *
   * Kept raw rather than mapped to a fixed list of our own, because these are
   * the mod author's categories - another mod will have entirely different ones
   * and the filter should pick them up without a code change.
   */
  categories: string[];
  /**
   * How many hands it needs. Three states, the same ones the article page
   * shows (Item.svelte:36-40):
   *   "one"  - one-handed, no penalty
   *   "two"  - two-handed, but usable one-handed at oneHandedPenalty
   *   "both" - blockBothHands: cannot be used one-handed at all
   */
  hands: WeaponHands;
  /**
   * Effective damage types across all its modes AND every clip it can load, as
   * indices into damageTypes. See weaponDamageTypes.
   *
   * Taken off the resolved Attack, so a weapon whose damageAlter overrides
   * ResistType is listed under the type the target actually resists with - the
   * Rope reads as CHOKING (9), not the DAZE (6) its damageType field names.
   */
  damageTypes: number[];
};

export type WeaponHands = "one" | "two" | "both";

/** Distinct effective damage types across a set of already-resolved attacks. */
export function attackDamageTypes(attacks: any[]): number[] {
  const out = new Set<number>();
  for (const a of attacks) {
    if (!a || !a.possible || !USABLE_MODES.includes(a.mode)) continue;
    const dt = +a.damageType;
    if (!isNaN(dt)) out.add(dt);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Every damage type a weapon can deliver, counting the clips it can load.
 *
 * Reading the raw attack list is not enough, and the way it fails is total
 * rather than partial: Ruleset's Attack only takes `damageType` off the item
 * when the item has no compatibleAmmo (Ruleset.ts:624-628), because for a gun
 * the type belongs to the shell. So every rifle, pistol, SMG and shotgun in the
 * mod came back with NO damage types at all - filtering by piercing returned a
 * single weapon, the Pepper Pistol, which is ammo-less.
 *
 * Resolved per clip through attacksOf so the answer matches what the rest of
 * the calculator uses: the merged `attack.damageType` is the same field the
 * Resist column and computeDamage read, so the filter can never disagree with
 * the numbers beside it. A gun that loads both AP and HE shells counts as both,
 * which is the useful reading of "show me what can hurt this".
 */
export function weaponDamageTypes(item: any, attacks: any[], ammoOptions: string[]): number[] {
  const out = new Set<number>(attackDamageTypes(attacks));
  for (const clip of ammoOptions && ammoOptions.length ? ammoOptions : [null]) {
    for (const dt of attackDamageTypes(attacksOf(item, clip))) out.add(dt);
  }
  return [...out].sort((x, y) => x - y);
}

export function weaponHands(item: any): WeaponHands {
  if (!item.twoHanded) return "one";
  return item.blockBothHands ? "both" : "two";
}

/**
 * Mode names that are wall-breaking utility rather than a way to kill someone.
 *
 * XPiratez implements these as a RANGED mode with `maxRange: 1` so they can
 * smash terrain - Hammer, Steam Hammer, Anchor, Wreckin' Ball, Crowbar,
 * Pickaxe, Magic Hammer all carry `confSnap`/`confAimed` named STR_CRUSH with
 * `firing: 0.0` and a closeQuartersMultiplier on strength or melee.
 *
 * Being ranged, they pay no approach and are scored at one tile, where the
 * Hit% geometry is at its most generous - so they rank far above what they are
 * worth against a person, because in practice close-quarters combat is what
 * decides them and that is not modelled.
 *
 * A name list rather than a shape test on purpose: "ranged mode with range 1"
 * would also catch legitimate point-blank weapons. Another mod names its own,
 * so this is the one place to add them.
 */
export const UTILITY_MODE_NAMES = ["STR_CRUSH"];

/** Whether a resolved attack is one of those. */
export function isUtilityMode(attack: any): boolean {
  return !!attack && UTILITY_MODE_NAMES.includes(attack.name);
}

/** Which class one firing mode belongs to. */
export function modeKind(mode: string): WeaponKind {
  if (mode == "melee") return "melee";
  if (mode == "throw") return "thrown";
  if (mode == "snap" || mode == "aimed" || mode == "auto") return "ranged";
  return "other";
}

/**
 * Classes taken from the firing modes the weapon actually has, which is what a
 * player means by "melee" or "ranged" - battleType alone puts the Hellblade,
 * whose best attack is a swing, in Ranged because it also has a Warp Blast.
 */
export function weaponKinds(attacks: any[]): WeaponKind[] {
  const out = new Set<WeaponKind>();
  for (const a of attacks) {
    if (!a || !a.possible) continue;
    out.add(modeKind(a.mode));
  }
  if (!out.size) out.add("other");
  return [...out];
}

/**
 * Every item a soldier can actually pick up and use.
 *
 * Carriability is decided by the UNION of three signals, because no single one
 * of them is set on all real gear:
 *
 *   categories                  - Rope has five, no inventory sections
 *   supportedInventorySections  - Stygian Sickle has nine, no categories
 *   weight                      - a thing you carry has mass
 *
 * Two narrower versions of this test shipped and both were wrong. Requiring a
 * category dropped 124 real weapons (Stygian Sickle, Death Blaster, Prismatic
 * Staff...). Requiring inventory sections dropped the Rope, which is exactly
 * the weapon you want against a choking-vulnerable target. Requiring inventory
 * *size* does nothing at all: Ruleset.ts:1103 defaults 0x0 to 1x1.
 *
 * The engine's internal items have none of the three - self-destruct charges,
 * hull explosions and the AURA_* environmental effects. (AURA_* do carry an
 * invWidth, which is why that field is no help.)
 */
export function weaponList(): WeaponOption[] {
  const out: WeaponOption[] = [];
  for (const item of Object.values<any>(rul.items || {})) {
    if (!item || typeof item.attacks != "function") continue;
    // The mod's own marker for things that never reach a soldier's hands.
    if (item.ignoreInCraftEquip) continue;
    const carriable =
      (item.categories && item.categories.length) ||
      (item.supportedInventorySections && item.supportedInventorySections.length) ||
      +item.weight > 0;
    if (!carriable) continue;

    let attacks = [];
    try {
      attacks = item.attacks() || [];
    } catch (e) {
      continue;
    }
    if (!attacks.some((a) => a && a.possible && USABLE_MODES.includes(a.mode))) continue;

    const ammoOptions = (item.compatibleAmmo || []).filter((a) => a && rul.items[a]);

    out.push({
      item,
      id: item.id,
      title: rul.tr(item.id),
      ammoOptions,
      kinds: weaponKinds(attacks),
      hands: weaponHands(item),
      damageTypes: weaponDamageTypes(item, attacks, ammoOptions),
      fixed: !!(item.fixedWeapon || item.builtIn),
      categories: Array.isArray(item.categories) ? item.categories : [],
    });
  }
  return out.sort((a, b) => (a.title < b.title ? -1 : 1));
}

/** The attacks of one weapon, with the chosen clip merged in. */
export function attacksOf(item: any, ammoId: string): any[] {
  if (!item || typeof item.attacks != "function") return [];
  let list = [];
  try {
    list = item.attacks() || [];
  } catch (e) {
    return [];
  }
  const clip = ammoId || (item.compatibleAmmo || []).filter((a) => rul.items[a])[0];
  const ammoItem = clip ? rul.items[clip] : null;
  return list
    .filter((a) => a && a.possible && USABLE_MODES.includes(a.mode))
    .map((a) => {
      const merged = withAmmo(a, clip);
      // Choke and behaviour belong to the gun; spread comes off the shell and
      // withAmmo has already copied it when there is one.
      merged.shotgunChoke = item.shotgunChoke;
      merged.shotgunBehavior = item.shotgunBehavior;
      if (merged.shotgunSpread == null)
        merged.shotgunSpread = ammoItem && ammoItem.shotgunSpread != null
          ? ammoItem.shotgunSpread
          : item.shotgunSpread;
      return merged;
    });
}

/**
 * The weapon's AIMED range, which is the limit every mode falls back to when
 * UFO Extender accuracy is off (RuleItem::calculateLimits).
 *
 * A snap or auto Attack carries its own range and not this one, so it has to be
 * read off the item. Taken from the item's aimed mode when it has one - which is
 * where Ruleset has already resolved `aimRange` and the engine default of 200 -
 * then the raw field, then the default.
 */
export function aimedRangeOf(item: any, attacks?: any[]): number {
  const list = attacks || attacksOf(item, null);
  const aimed = list.find((a) => a && a.mode == "aimed");
  if (aimed && aimed.range != null && !isNaN(+aimed.range)) return +aimed.range;
  if (item && item.aimRange != null && !isNaN(+item.aimRange)) return +item.aimRange;
  return 200;
}

export type ModeResult = {
  mode: string;
  label: string;
  attack: any;
  damage: DamageResult;
  accuracy: number;
  /**
   * How often the attack actually CONNECTS, 0-1, which for direct fire is not
   * `accuracy / 100` - see damageHit.ts. Kept beside the accuracy rather than
   * replacing it because they are different facts and the table shows both.
   */
  hitRate: number;
  perTurn: number;
  /** Expected health damage across a full turn of attacking, accuracy applied. */
  healthPerTurn: number;
  stunPerTurn: number;
  /** Expected health damage from one attack, after accuracy. */
  perAttack: number;
  tuCost: number;
  /**
   * TU to walk from where the enemy was spotted to where this mode can be used,
   * charged once. Zero for anything usable from where you stand. See
   * approachTu and fireDistance in damageCalc.ts.
   */
  approachTu: number;
  /** Tiles this mode is actually used from. 1 for melee. */
  fireDistance: number;
  /** Tiles at which this soldier spots this enemy, with the working shown. */
  sight: any;
  /**
   * What actually separates weapons.
   *
   * Damage-per-turn is a trap against a soft target: a 40-pellet burst reports
   * hundreds of damage against a 35 HP enemy, which says nothing except that it
   * overkills. How much of your TU bar it takes to put the target down does not
   * have that problem, and it is the question being asked anyway.
   */
  attacksToKill: number;
  tuToKill: number;
  /**
   * TU cost as a fraction of the soldier's bar. Below 1 it is also what she has
   * left, and the decimals are the at-a-glance reading of how fast the weapon
   * is. See the note where it is computed for why wholeTurns exists too.
   */
  turnsToKill: number;
  /** The tactical turn count: whole turns, since a partial shot is not a thing. */
  wholeTurns: number;
  /**
   * The verdict, 0-100, where 50 means one full turn of this soldier's TU to
   * drop this target. See damageScore.ts for why it is anchored that way and
   * why it counts misses rather than shrinking the damage.
   */
  score: number;
  /** Chance the target is actually down after `attacksToKill` attacks. */
  killChance: number;
  /**
   * Armour this attack strips per landing hit.
   *
   * Its own column because it answers a question the damage numbers cannot: a
   * weapon that barely scratches a tank can still be the right thing to fire at
   * it, if what you are doing is opening it up for the next gal.
   */
  armorPerAttack: number;
  /** Armour left on the facing once the target is down. */
  armorEnd: number;
  /** First attack that gets anything through, > 1 when armour has to go first. */
  attacksToPenetrate: number;
  /** Whether the armour moves at all while this attack is used. */
  degrades: boolean;
  /** The range window this mode's accuracy was judged against. */
  limits: RangeLimits;
};

export type WeaponResult = {
  id: string;
  title: string;
  item: any;
  ammoId: string;
  modes: ModeResult[];
  /** The highest-scoring mode - the weapon's verdict, and what the list sorts on. */
  best: ModeResult;
};

/**
 * Score one weapon against one target.
 *
 * Two readings of accuracy live here on purpose, because they answer different
 * questions and mixing them was the old mistake:
 *
 *   the DISPLAYED columns fold the hit rate into expected damage, which is the
 *   right thing for "what does one attack do on average"
 *
 *   the SCORE counts a miss as a miss - see damageScore.ts - which is the only
 *   way to tell a reliable weapon from a coin-flip one
 *
 * The hit rate behind both is the one from damageHit.ts, not the panel figure -
 * for direct fire the panel figure is a floor on how often you connect, not an
 * estimate of it. It is still a geometric model with no cover in it, so this
 * remains a ranking aid rather than a prediction.
 */
function killRank(m: ModeResult): number {
  // Ranked on the score, descending, so the table's order and its own Score
  // column can never disagree. Nulls and zeroes sink.
  return m && m.score != null && isFinite(m.score) ? -m.score : Infinity;
}

export function scoreWeapon(
  weapon: WeaponOption,
  ammoId: string,
  stats: Stats,
  target: Target,
  side: string,
  opts: AccuracyOpts,
  pelletModel: PelletModel = "derived",
  goal: Goal = "kill",
  modeFilter: ModeFilter = null
): WeaponResult {
  const clip = ammoId || weapon.ammoOptions[0] || null;
  const modes: ModeResult[] = [];

  const attacks = attacksOf(weapon.item, clip);
  // Ranges are read off the weapon's whole attack list, filter or not: the
  // aimed range still governs falloff even when you are only looking at snap.
  const aimedRange = aimedRangeOf(weapon.item, attacks);
  // The silhouette a shot has to land inside. A property of the target, so it
  // is the same for every mode and every weapon in the ranking.
  const geom = targetGeometry(target);
  /**
   * How far away this soldier spots THIS enemy, in these light conditions.
   *
   * The constant every mode is measured against, and it is not a constant at
   * all - it swings with her armour, the enemy's camouflage and the light. A
   * property of the pairing, so it is computed once here rather than per mode.
   */
  const sight = sightDistance(opts.soldierArmor, target && target.armor, opts.isDay !== false);

  /**
   * The approach cost, off a single distance cutoff.
   *
   *   APPR = max(0, cutoff - this mode's reach) * tuPerTile
   *
   * One rule for every mode, melee included (its reach is 0 - it works only in
   * contact). The cutoff is the Range box, and it stands for the distance a
   * fight typically opens at.
   *
   * The trade-off it encodes: a weapon that reaches AT or BEYOND the cutoff
   * pays nothing, because you can already act from where the fight starts and
   * that is the safer position. Anything shorter has to be walked into range,
   * and the walk is both TU and exposure. A Sawed-Off (snapRange 4) against a
   * cutoff of 16 pays (16 - 4) x 4 = 48 TU; a rifle reaching 18 pays nothing.
   *
   * Measured over the mod, the median ranged reach is 18 tiles and the mean
   * (with the 200-tile default capped at 30) is 18.6, so a cutoff near 16-18
   * sits right in the middle of what weapons actually do.
   */
  const cutoff = Math.max(0, +opts.distance || 0);

  /**
   * The previous model, kept because it may come back rather than because it
   * is used: a hybrid's melee charged from the average of its OWN guns' reach,
   * so clubbing with a rifle cost the shot you gave up. Switched off to see the
   * flat cutoff on its own. UNLIMITED_RANGE_BENCHMARK exists only for this.
   */
  const HYBRID_MELEE_FROM_OWN_RANGE = false;
  const rangedReach = attacks
    .filter((a) => modeKind(a.mode) == "ranged")
    .map((a) =>
      Math.min(
        UNLIMITED_RANGE_BENCHMARK,
        rangeLimits(a, weapon.item, aimedRange, opts.ufoExtender !== false).upper
      )
    );
  const meleeFrom =
    HYBRID_MELEE_FROM_OWN_RANGE && rangedReach.length
      ? Math.round(rangedReach.reduce((a, b) => a + b, 0) / rangedReach.length)
      : cutoff;

  for (const attack of attacks) {
    if (modeFilter && !modeFilter(attack)) continue;
    /**
     * Where the attack is made FROM, which is not where you spotted the enemy.
     * A Sawed-Off sighted at 40 tiles is not fired from 40 - you walk it into
     * its four-tile range first, and judging its accuracy at the spotting
     * distance was costing it 100 points off a stated 130.
     */
    const fireAt = fireDistance(attack, weapon.item, aimedRange, sight.tiles, opts.ufoExtender !== false);
    // Accuracy first: the pellet model for vanilla shotgun behaviour needs it.
    const accuracy = accuracyPercent(attack, weapon.item, stats, opts, aimedRange, fireAt);
    const profile = damageProfile(attack, stats, target, pelletModel, accuracy);
    if (!profile) continue;
    const perTurn = attacksPerTurn(attack, stats);
    /**
     * How often it lands - NOT the accuracy figure, for direct fire.
     *
     * The engine does not roll against accuracy for a projectile; it turns
     * accuracy into how far the aim point drifts, and the drift grows with
     * range. So a 60% gun lands about 96% of its shots at three tiles and 65%
     * at twenty, and using the flat 60% under-rated every gun at the ranges
     * fights happen at. damageHit.ts has the derivation. Melee and thrown
     * modes pass straight through, melee because it genuinely is a percentage
     * roll.
     *
     * One value, used by the simulation AND by every displayed column that
     * folds in hit chance. Letting those two diverge is the bug that put a
     * Machete's "TU to kill 12" beside a better score than a Cutlass's 8.
     */
    const hitRate = hitChance(attack.mode, accuracy, fireAt, geom);
    const hp = target.health || 0;
    /**
     * ONE simulation, used for both the ranking and the columns.
     *
     * There used to be two: an expectation-based count for the Attacks column
     * and a confidence-based one for the Score. They disagreed, visibly - a
     * Machete showed "TU to kill 12" next to a better score than a Cutlass
     * showing 8. Now there is a single number and everything reads it.
     */
    const seq = simulateAttacks(
      profile,
      armorValue(target, side),
      hp,
      goal,
      hitRate,
      MAX_USEFUL_ATTACKS,
      SCORE_CONFIDENCE
    );
    // Everything displayed is the FIRST attack - the target as you find it.
    const damage = seq.first;
    // The chosen goal decides which damage track drives the ranking.
    const perAttack =
      (goal == "stun"
        ? damage.avgStunPerAttack
        : goal == "drop"
          ? damage.avgHealthPerAttack + damage.avgStunPerAttack
          : damage.avgHealthPerAttack) * hitRate;
    const tuCost = tuPerAttack(attack, stats);
    const attacksToKill = seq.attacks;
    /**
     * Getting there is part of the cost.
     *
     * A melee mode cannot be used from the Range the rest of the table is
     * judged at - the gal has to walk. Charged once, before the first swing,
     * because you close the distance and then keep swinging. Ranged and thrown
     * modes are zero: you use those from where you stand.
     *
     * Leaving this out was the single biggest thing flattering melee. A Cutlass
     * read "16 TU to drop the G.O." from ten tiles away, against a gun's 24 -
     * comparing a number that skipped nine tiles of walking against one that
     * did not.
     */
    /**
     * Melee walks from the manual Range box, everything else from sight.
     *
     * Deliberately asymmetric. A melee weapon has no choice to weigh - it works
     * at one tile and that is that - so its approach is the one number worth
     * dialling in by hand. Every other mode has a real reach, and what matters
     * is how much of the spotting distance it has to give up to use it: an
     * aimRange 200 rifle gives up nothing, a Sawed-Off gives up everything past
     * four tiles.
     */
    // Melee has no reach at all, so it walks the whole cutoff.
    const modeReach =
      attack.mode == "melee"
        ? 0
        : rangeLimits(attack, weapon.item, aimedRange, opts.ufoExtender !== false).upper;
    const approach = approachTu(
      attack.mode == "melee" ? meleeFrom : cutoff,
      modeReach,
      opts.tuPerTile,
      opts.freeTiles
    );
    // A zero TU cost would make every such weapon a free instant kill. We do
    // not know the real cost, so we say so rather than inventing one.
    const tuToKill =
      attacksToKill != null && tuCost > 0 ? approach + attacksToKill * tuCost : null;
    const score = effectivenessScore(tuToKill, stats.tu);

    /**
     * Two different true answers, so both are kept.
     *
     * turnsToKill is the TU cost as a FRACTION of the bar, matching the TU
     * column beside it. Below 1 it doubles as what you have left.
     *
     * wholeTurns is the tactical count, because you cannot carry time units
     * between turns or fire part of a shot. Derived from the TU total rather
     * than from attacks-per-turn so it accounts for a first turn partly spent
     * walking - otherwise a melee mode could report "1 turn" for a kill whose
     * approach alone eats the whole bar.
     */
    const turnsToKill = tuToKill != null && stats.tu ? tuToKill / stats.tu : null;
    const wholeTurns =
      tuToKill != null && stats.tu > 0
        ? Math.ceil(tuToKill / stats.tu)
        : attacksToKill != null && perTurn > 0
          ? Math.ceil(attacksToKill / perTurn)
          : null;

    modes.push({
      mode: attack.mode,
      // Custom attack names come through as STR_ ids from conf<Mode>.name.
      label: attack.name ? rul.tr(attack.name) : attack.mode,
      attack,
      damage,
      accuracy,
      hitRate,
      perTurn,
      healthPerTurn: perAttack * perTurn,
      stunPerTurn: damage.avgStunPerAttack * hitRate * perTurn,
      perAttack,
      tuCost,
      approachTu: approach,
      fireDistance: fireAt,
      sight,
      attacksToKill,
      tuToKill,
      turnsToKill,
      wholeTurns,
      score,
      killChance: seq.chance,
      limits: rangeAt(attack, weapon.item, aimedRange, opts.ufoExtender !== false, fireAt),
      // Armour stripped by a hit that LANDS. Scaling this by the hit rate
      // smeared a fraction of the armour damage across shots that missed and
      // stripped nothing at all.
      armorPerAttack: damage.armorLossPerAttack,
      armorEnd: seq.armorEnd,
      attacksToPenetrate: seq.attacksToPenetrate,
      degrades: seq.degrades,
    });
  }

  modes.sort((a, b) => killRank(a) - killRank(b));

  return {
    id: weapon.id,
    title: weapon.title,
    item: weapon.item,
    ammoId: clip,
    modes,
    best: modes[0] || null,
  };
}

/** Rank a whole weapon list against one target. */
export function rankWeapons(
  weapons: WeaponOption[],
  stats: Stats,
  target: Target,
  side: string,
  opts: AccuracyOpts,
  ammoBy: { [id: string]: string } = {},
  pelletModel: PelletModel = "derived",
  goal: Goal = "kill",
  modeFilter: ModeFilter = null
): WeaponResult[] {
  return weapons
    .map((w) =>
      scoreWeapon(w, ammoBy[w.id], stats, target, side, opts, pelletModel, goal, modeFilter)
    )
    // A weapon can pass the weapon-level test on a clip you are not carrying
    // and then have no matching mode at all. Nothing to show for it.
    .filter((r) => r.best)
    .sort((a, b) => killRank(a.best) - killRank(b.best));
}

/**
 * Races that are not real enemies. STR_DUMMY is the mod's own test-range race -
 * four 1 HP, 0 TU units that otherwise sit at the top of every ranking because
 * anything kills them instantly.
 *
 * Deliberately a race list rather than a stats test: a 0 TU unit is not always
 * noise (a destructible objective is a legitimate thing to shoot), so filtering
 * on "cannot act" would throw away targets worth calculating.
 */
export const EXCLUDED_RACES = ["STR_DUMMY"];

/** Every unit that can be shot at, for the target picker. */
export function targetList(): { id: string; title: string }[] {
  const out = [];
  for (const id of Object.keys(rul.units || {})) {
    const u = rul.units[id];
    if (!u || !u.armor || !rul.armors[u.armor]) continue;
    if (u.race && EXCLUDED_RACES.includes(u.race)) continue;
    out.push({ id, title: rul.tr(id) });
  }
  return out.sort((a, b) => (a.title < b.title ? -1 : 1));
}
