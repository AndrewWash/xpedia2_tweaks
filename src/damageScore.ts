/**
 * The effectiveness score: one glanceable number for "is this weapon worth
 * using against this enemy at all".
 *
 * The score itself is one line - 100 / (1 + TU / the soldier's TU bar) - and all
 * the work is in the TU it is handed. That comes from simulateAttacks in
 * damageCalc.ts, which walks a DISTRIBUTION of accumulated damage rather than a
 * running average and stops when the target is down four times out of five.
 *
 * Why a distribution, and not health / average damage: averages hide variance,
 * and variance is most of what separates a reliable weapon from a lucky one.
 * The mean said a Good Lookin' Rock (0-68 damage, mean 31) one-shots a 30 HP
 * nurse; it manages that about half the time. The same arithmetic ranked a
 * Machete above a Cutlass hitting twice as hard, because the Machete's mean
 * scraped over the line more cheaply. Both are fixed by counting the spread.
 *
 * A miss is a wasted attack, not reduced damage - the other half of the same
 * point. attacksForHits below is the closed form of that idea for the simple
 * case of a fixed number of hits; the live pipeline uses the fuller simulation
 * because damage spread and armour degradation do not fit a closed form.
 *
 * WHAT THIS DOES NOT KNOW. It is a ranking aid over what the ruleset actually
 * states, not a verdict on a weapon: ammo capacity and reload cost, energy
 * cost, weight and encumbrance, energy shields (reported but not modelled),
 * and the exposure of standing in the open for another turn are all outside
 * it.
 *
 * The hit rate it uses is NOT the figure the firing panel shows. For direct
 * fire the engine deviates the aim point rather than rolling against accuracy,
 * so the panel figure is a floor on how often you connect and the real rate
 * depends on range; damageHit.ts reproduces that geometry. What it still does
 * not know is cover, terrain and the target's actual voxel model, so treat a
 * high score as "worth trying", never as "guaranteed".
 */

/**
 * How sure you want to be. 0.8 means the shot count is the one that drops the
 * target four times out of five, rather than the average - averages hide
 * exactly the tail risk that makes an inaccurate weapon a bad bet.
 */
export const SCORE_CONFIDENCE = 0.8;

/**
 * Shots needed to land `hits` of them, at the given confidence.
 *
 * The smallest n with P(at least `hits` successes in n trials) >= confidence.
 * Walked upward from n = hits with the negative binomial pmf - the chance that
 * the n-th shot is the one that lands the `hits`-th hit - accumulated as a CDF:
 *
 *   term(n) = C(n-1, hits-1) * p^hits * (1-p)^(n-hits)
 *   term(n+1) / term(n) = (n / (n - hits + 1)) * (1 - p)
 *
 * That recurrence is what keeps this O(maxShots) instead of O(n^2). Summing a
 * binomial tail from scratch for every candidate n is the obvious way to write
 * it and it is far too slow to run across a couple of thousand firing modes -
 * the same trap MAX_BUCKETS in damageCalc.ts exists to avoid.
 *
 * Returns null when the target cannot be dropped: no hits would ever do it, or
 * the shot cannot connect, or it would take more shots than maxShots.
 */
export function attacksForHits(
  hits: number,
  p: number,
  confidence = SCORE_CONFIDENCE,
  maxShots = 100
): number {
  const k = Math.ceil(+hits);
  if (!(k > 0)) return null;
  if (!(p > 0)) return null;
  // A shot that always lands needs exactly one shot per hit.
  if (p >= 1) return k <= maxShots ? k : null;
  if (k > maxShots) return null;

  const q = 1 - p;
  const want = Math.min(1, Math.max(0, +confidence));
  // Confidence of zero asks nothing of the weapon, so the first n that can
  // possibly work is the answer.
  if (want <= 0) return k;

  // term at n = k: every one of the first k shots hits.
  let term = Math.pow(p, k);
  let cdf = term;
  if (cdf >= want) return k;

  for (let n = k + 1; n <= maxShots; n++) {
    term *= ((n - 1) / (n - k)) * q;
    cdf += term;
    if (cdf >= want) return n;
  }
  return null;
}

/**
 * 0-100, anchored on the soldier's own time units.
 *
 *   score = 100 / (1 + reliableTu / soldierTu)
 *
 * so 50 is exactly one full turn's worth of TU to drop the target, above 50 is
 * faster than a turn and below it is slower. Anchoring it to something real
 * rather than to the best weapon in the list is what lets the number answer
 * "worth using at all" - the best of a bad set still reads badly, which a
 * relative score could never say.
 *
 * The shape keeps useful resolution where the good weapons are: a quarter-turn
 * kill is 80, half a turn is 67, one turn 50, two turns 33, five turns 17.
 */
export function effectivenessScore(reliableTu: number, soldierTu: number): number {
  if (reliableTu == null || !isFinite(reliableTu) || reliableTu <= 0) {
    // No TU cost at all is not a perfect weapon, it is an unknown one - the
    // caller could not read a cost off the ruleset. Say nothing.
    return reliableTu === 0 ? null : 0;
  }
  const bar = +soldierTu;
  if (!(bar > 0)) return null;
  return Math.round(100 / (1 + reliableTu / bar));
}

export type ScoreBand = "good" | "fair" | "poor" | "none";

/**
 * The colour bands, which are just the anchor read back out: "inside a turn",
 * "one to three turns", "worse than that", "never".
 */
export function scoreBand(score: number): ScoreBand {
  if (score == null || !(score > 0)) return "none";
  if (score >= 50) return "good";
  if (score >= 25) return "fair";
  return "poor";
}

/** Turns implied by a score, for tooltips. The inverse of the formula above. */
export function scoreTurns(score: number): number {
  if (score == null || !(score > 0)) return null;
  return 100 / score - 1;
}
