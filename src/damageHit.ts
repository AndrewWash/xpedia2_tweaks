/**
 * How often a shot actually CONNECTS, which is not what the firing panel says.
 *
 * This module exists because of one mistake worth spelling out. The percentage
 * beside a firing mode was being used as P(hit), and for direct fire the engine
 * has no such roll at all. `Projectile::applyAccuracy` converts accuracy into a
 * positional DEVIATION of the aim point, scaled by how far away the target is:
 *
 *     int deviation = RNG::generate(0, 100) - (accuracy * 100);
 *     if (deviation >= 0) deviation += 50;   // the "miss cloud"
 *     else                deviation += 10;   // accuracy >= 109 becomes 1
 *     deviation = std::max(1, zShift * deviation / 200);   // range ratio
 *     target->x += RNG::generate(0, deviation) - deviation / 2;
 *     target->y += RNG::generate(0, deviation) - deviation / 2;
 *     target->z += RNG::generate(0, deviation / 2) / 2 - deviation / 8;
 *
 * Two consequences fall straight out of that, and both are large:
 *
 *   1. Every roll below the accuracy takes the `+= 10` branch, which after the
 *      max(1, ...) floor is a deviation of one voxel - a dead-on hit at any
 *      range. So the displayed accuracy is a FLOOR on the real hit rate, never
 *      an estimate of it.
 *   2. The other rolls land in a box whose size grows linearly with distance.
 *      Close in that box is still smaller than the target, so those rolls hit
 *      too; far out it is many times the target's width and most of them miss.
 *
 * Together: a 60% rifle is near-certain at three tiles and close to its stated
 * 60% at twenty. Treating the panel figure as a flat probability under-rated
 * guns at exactly the ranges fights happen at, which is the gap between this
 * calculator's rankings and how the weapons play.
 *
 * MELEE IS DIFFERENT and is not modelled here: a melee attack really is a
 * straight RNG::percent(accuracy) roll, so for it the panel figure IS the hit
 * probability. Thrown attacks are left on the panel figure too - the throw arc
 * has its own accuracy handling, and a grenade that lands a tile off still goes
 * off next to the target, so neither this model nor a flat probability
 * describes it well. See hitChance() for the dispatch.
 *
 * WHAT THIS DELIBERATELY DOES NOT KNOW: cover, intervening terrain, the
 * target's real LOFT voxel model, kneeling, and the fact that a shot which
 * deviates past the target can still clip it on the way. It is a geometric
 * approximation of the engine's own deviation maths - better than a flat
 * probability by a wide margin, but not a voxel trace.
 */
import { rul } from "./Ruleset";
import type { Target } from "./damageCalc";

/** The engine's voxel grid: a tile is 16 voxels across and 24 tall. */
export const VOXELS_PER_TILE = 16;

/**
 * Half-width of a 1x1 unit's silhouette, in voxels.
 *
 * A unit's LOFT is a blob inside its 16-voxel tile, not the whole tile -
 * roughly 10 voxels across at the torso, so 5 either side of centre. A 2x2 unit
 * is one extra tile wide, which adds 16 voxels of width and so 8 to the half.
 */
export const UNIT_HALF_WIDTH = 5;

/** Fallback stand height when a unit does not state one. */
export const DEFAULT_STAND_HEIGHT = 22;

export type HitGeometry = {
  /** Half the target's silhouette width, in voxels. */
  halfWidth: number;
  /** Half its height, in voxels - the aim point sits at centre of mass. */
  halfHeight: number;
};

/** The silhouette a shot has to land inside, from the unit and its armour. */
export function targetGeometry(target: Target): HitGeometry {
  const size = target && target.armor && +target.armor.size > 1 ? +target.armor.size : 1;
  const stated = target && target.unit ? +target.unit.standHeight : NaN;
  const height = isNaN(stated) || stated <= 0 ? DEFAULT_STAND_HEIGHT : stated;
  return {
    halfWidth: UNIT_HALF_WIDTH + (size - 1) * (VOXELS_PER_TILE / 2),
    halfHeight: height / 2,
  };
}

/**
 * Whether the mod pins the uniform-spread option on.
 *
 * `oxceUniformShootingSpread` replaces the deliberately non-uniform xy branch
 * below with a plain average. It is a user option, so it is only knowable here
 * when a mod fixes it - XPiratez does not, and the engine default is off.
 */
export function uniformSpread(): boolean {
  const fixed = rul && rul.raw ? rul.raw.fixedUserOptions : null;
  if (fixed && fixed.oxceUniformShootingSpread != null)
    return !!fixed.oxceUniformShootingSpread;
  return false;
}

/**
 * The horizontal half of the range ratio, ported branch for branch. The
 * asymmetry is deliberate in the engine and it is not small: a shot straight
 * along an axis spreads about half as much as the same shot on the diagonal.
 */
export function xyShiftVoxels(xDist: number, yDist: number, uniform = false): number {
  const x = Math.abs(Math.round(xDist));
  const y = Math.abs(Math.round(yDist));
  if (uniform) return Math.trunc((x + y) / 2);
  if (Math.trunc(x / 2) <= y) return Math.trunc(x / 4) + y;
  return Math.trunc((x + y) / 2);
}

/** The full range ratio. zDist is 0 for the flat engagement we assume. */
export function zShiftVoxels(xyShift: number, zDist = 0): number {
  const z = Math.abs(Math.round(zDist));
  if (xyShift <= z) return Math.trunc(xyShift / 2) + z;
  return xyShift + Math.trunc(z / 2);
}

/**
 * One outer roll turned into a deviation, in voxels.
 *
 * `roll` is the engine's RNG::generate(0, 100). Integer truncation is kept
 * faithfully: the C++ assigns `RNG::generate(0,100) - (accuracy * 100)` to an
 * int, so the branch below tests the ALREADY TRUNCATED value.
 */
export function deviationVoxels(accuracyPct: number, zShift: number, roll: number): number {
  let dev = Math.trunc(roll - (+accuracyPct || 0));
  dev += dev >= 0 ? 50 : 10;
  return Math.max(1, Math.trunc((zShift * dev) / 200));
}

/**
 * P(the aim point stays within `half` of centre on one axis), for the engine's
 * `RNG::generate(0, d) - d / 2`.
 *
 * Counted over the d+1 discrete outcomes rather than integrated, because at the
 * small deviations that matter most - d of 1 to 6, the close-range case - the
 * off-by-one in `d / 2` is a large part of the answer.
 */
function axisChance(d: number, half: number): number {
  const shift = Math.trunc(d / 2);
  const lo = Math.max(0, Math.ceil(shift - half));
  const hi = Math.min(d, Math.floor(shift + half));
  return hi < lo ? 0 : (hi - lo + 1) / (d + 1);
}

/**
 * The same for the vertical axis, which has its own tighter formula:
 * `RNG::generate(0, d / 2) / 2 - d / 8` spans about a quarter of the horizontal
 * spread. Units are tall, so this rarely binds - but at extreme range it does.
 */
function heightChance(d: number, half: number): number {
  const span = Math.trunc(d / 2);
  const drop = Math.trunc(d / 8);
  // v in [0, span] maps to trunc(v / 2) - drop, so each accepted quotient k
  // covers the two rolls 2k and 2k+1.
  const lo = 2 * Math.max(0, Math.ceil(drop - half));
  const hi = Math.min(span, 2 * Math.floor(drop + half) + 1);
  return hi < lo ? 0 : (hi - lo + 1) / (span + 1);
}

/**
 * Angles sampled when averaging over which way the shot is fired.
 *
 * The xy branch above makes spread depend on the firing direction, and nobody
 * gets to choose where the enemy is standing, so the honest answer is the
 * average over directions. Everything reduces by symmetry to the first 45
 * degrees; midpoints of eight equal slices are plenty, the function being
 * smooth across them.
 */
const ANGLE_SAMPLES = 8;

/** Never claim certainty: the LOFT has gaps and no cover is modelled at all. */
export const MAX_HIT_CHANCE = 0.99;

const cache = new Map<string, number>();

/**
 * The chance a direct-fire shot connects, at this accuracy and this range.
 *
 * Averaged over the engine's 101 outer rolls and over the firing direction.
 * Cached because it is called once per firing mode per weapon - a couple of
 * thousand times per ranking - while depending on only a handful of distinct
 * inputs.
 */
export function spreadHitChance(
  accuracyPct: number,
  distanceTiles: number,
  geom: HitGeometry,
  uniform?: boolean
): number {
  const acc = Math.max(0, +accuracyPct || 0);
  const dist = Math.max(0, +distanceTiles || 0);
  const uni = uniform == null ? uniformSpread() : !!uniform;
  const w = geom ? geom.halfWidth : UNIT_HALF_WIDTH;
  const h = geom ? geom.halfHeight : DEFAULT_STAND_HEIGHT / 2;

  const key = acc + "|" + dist + "|" + w + "|" + h + "|" + (uni ? 1 : 0);
  const seen = cache.get(key);
  if (seen != null) return seen;

  const voxels = dist * VOXELS_PER_TILE;
  let total = 0;
  for (let a = 0; a < ANGLE_SAMPLES; a++) {
    const theta = ((a + 0.5) / ANGLE_SAMPLES) * (Math.PI / 4);
    const shift = zShiftVoxels(
      xyShiftVoxels(voxels * Math.cos(theta), voxels * Math.sin(theta), uni)
    );
    let sum = 0;
    for (let roll = 0; roll <= 100; roll++) {
      const d = deviationVoxels(acc, shift, roll);
      /**
       * Both horizontal rolls displace the aim point, but only the component
       * ACROSS the line of sight can miss - the component along it just moves
       * the point nearer or further along a ray that still passes through the
       * target. That across component has the same variance as a single axis
       * whatever the firing angle, so one axis is the right thing to test.
       */
      sum += axisChance(d, w) * heightChance(d, h);
    }
    total += sum / 101;
  }
  const out = Math.min(MAX_HIT_CHANCE, Math.max(0, total / ANGLE_SAMPLES));
  cache.set(key, out);
  return out;
}

/** Drop the memo when the ruleset or the options behind it change. */
export function resetHitCache(): void {
  cache.clear();
}

/**
 * Hit chance for one firing mode.
 *
 * Melee is a real percentage roll in the engine, so it passes straight through.
 * So does a throw, for the reasons in the header. Everything else deviates.
 */
export function hitChance(
  mode: string,
  accuracyPct: number,
  distanceTiles: number,
  geom: HitGeometry,
  uniform?: boolean
): number {
  const flat = Math.min(1, Math.max(0, (+accuracyPct || 0) / 100));
  if (mode == "melee" || mode == "throw") return flat;
  return spreadHitChance(accuracyPct, distanceTiles, geom, uniform);
}
