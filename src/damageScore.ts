/**
 * The effectiveness score: one glanceable number for "is this weapon worth
 * using against this enemy at all".
 *
 * Three steps, and the middle one is the whole point of this file.
 *
 *   1. How many HITS does it take to drop the target? That comes from
 *      simulateAttacks with the hit rate left out, so the armour still degrades
 *      hit by hit - a hit is the only thing that strips armour.
 *   2. How many SHOTS to land that many hits? A negative binomial, below.
 *   3. Turn that into TU and compare it against the soldier's own bar.
 *
 * Why step 2 exists at all. The rest of the calculator folds accuracy into the
 * damage, so a 50%-accuracy shot is treated as doing half damage every time.
 * The average is right and the spread is thrown away, which is the one thing
 * that matters here: you do not get half a hit, you either connect for full or
 * you spend the TU for nothing. Modelled properly the gap is much wider than
 * the linear version suggests:
 *
 *                        folded into damage      misses as misses
 *   2 hits at 90% acc    ceil(2/0.9) = 3         2 shots
 *   2 hits at 50% acc    ceil(2/0.5) = 4         5 shots
 *                        1.33x worse             2.5x worse
 *
 * Which is why a slightly slower, accurate weapon really does beat a cheap
 * inaccurate one, and why the old TU-to-kill column could never show it.
 *
 * WHAT THIS DOES NOT KNOW. It is a ranking aid over what the ruleset actually
 * states, not a verdict on a weapon: ammo capacity and reload cost, energy
 * cost, weight and encumbrance, energy shields (reported but not modelled),
 * and the exposure of standing in the open for another turn are all outside
 * it. The accuracy it uses is the figure the firing panel shows, which is an
 * input to a voxel trace against the target's model and cover - not a true hit
 * probability. Treat a high score as "worth trying", never as "guaranteed".
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
