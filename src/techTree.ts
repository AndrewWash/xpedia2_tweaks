/**
 * The research tree, as questions rather than as a graph.
 *
 * XPiratez has 4612 research topics. A node-and-edge picture of that is a
 * hairball, and it answers a question nobody asks. What players actually ask is
 * four things, and every one of them is a LIST:
 *
 *   "What can I even do right now?"      -> availableNow
 *   "Why can't I research that?"          -> missingFor
 *   "Is this worth N days of brainers?"   -> daysFor
 *   "What do I need to get to X?"         -> pathTo
 *
 * No UI in here, so it can be tested the way damageCalc.ts is.
 *
 * WHAT THIS MODELS EXACTLY: `dependencies` against the save's `discovered`
 * set, plus `unlocks` as a bypass (see availability below). Those two decide
 * the great majority of real cases.
 *
 * It also models `needItem` against what the save holds, which turned out to be
 * essential rather than optional - see hasNeededItem. Judging on dependencies
 * alone called 1812 topics available against a real save; with the item gate it
 * is 82, and that is the difference between a usable screen and a wall.
 *
 * WHAT IT DOES NOT, and says so rather than guessing - see `caveatsFor`:
 *   getOneFreeProtected (102 uses)  conditional free grants
 *   disables (163)                  researching one thing can REMOVE another
 *   requiresBaseFunc (398)          gated on facilities, not research at all
 *   one-shot topics
 * A "can I research this" that ignored those would be confidently wrong, which
 * is worse than not answering.
 */
import { rul } from "./Ruleset";
import type { SaveState } from "./damageSave";

export type TopicStatus =
  | "done"
  /** A choice you already made rules this one out for good. */
  | "lockedOut"
  | "inProgress"
  | "available"
  /** Research is satisfied; you just do not hold the item it wants. */
  | "needsItem"
  | "blocked";

/** Everything the UI needs about one topic, for one save. */
export type TopicInfo = {
  id: string;
  title: string;
  status: TopicStatus;
  /** Unmet prerequisites, minimal - see missingFor. */
  missing: string[];
  /** Rolled cost when started, ruleset cost otherwise. Null when unknown. */
  cost: number;
  /** Work left: cost - spent for a started project, else cost. */
  remaining: number;
  /** Days at the save's brainer count, or null when that cannot be known. */
  days: number;
  /** Things this opens up. */
  unlocks: string[];
  getOneFree: string[];
  /** Choices already made that rule this out. Empty unless status is lockedOut. */
  lockedBy: string[];
  /** Non-research gates we do not model, in words. */
  caveats: string[];
};

const research = (): { [id: string]: any } => (rul && rul.research) || {};

/** A topic's ruleset entry, or null. */
export function topic(id: string): any {
  return id ? research()[id] || null : null;
}

const list = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x == "string") : []);

/**
 * Which topics each topic force-unlocks.
 *
 * `dependencies` and `unlocks` are DIFFERENT mechanisms and the UI must not
 * blur them. `dependencies` is the normal gate: all of them must be discovered.
 * `unlocks` is a bypass - researching the lister makes the listed topic
 * available whether or not its own dependencies are met. A topic reachable only
 * that way looks permanently blocked if you read `dependencies` alone.
 *
 * Built once and memoised; the ruleset does not change under us.
 */
let unlockIndex: Map<string, string[]> = null;

export function unlockedFrom(id: string): string[] {
  if (!unlockIndex) {
    unlockIndex = new Map();
    for (const r of Object.values<any>(research())) {
      if (!r || !r.name) continue;
      for (const u of list(r.unlocks)) {
        const cur = unlockIndex.get(u);
        if (cur) cur.push(r.name);
        else unlockIndex.set(u, [r.name]);
      }
    }
  }
  return unlockIndex.get(id) || [];
}

/**
 * Which topics each topic rules out.
 *
 * XPiratez uses `disables` for its branching choices - pick a Codex, a Captain,
 * embrace or reject the Power - and the ones you did not pick are gone for the
 * rest of the campaign. The mod has 163 topics carrying it and 185 distinct
 * targets, 64 of which are the "?Question?" style names it uses for forks.
 *
 * Ignoring it is not a rounding error: against a real save it left 11 topics
 * sitting in "available now" that the campaign had already ruled out, including
 * three Codices and four Captains that can never be taken.
 */
let disableIndex: Map<string, string[]> = null;

export function disabledBy(id: string): string[] {
  if (!disableIndex) {
    disableIndex = new Map();
    for (const r of Object.values<any>(research())) {
      if (!r || !r.name) continue;
      for (const t of list(r.disables)) {
        const cur = disableIndex.get(t);
        if (cur) cur.push(r.name);
        else disableIndex.set(t, [r.name]);
      }
    }
  }
  return disableIndex.get(id) || [];
}

/** Whether a choice already made has ruled this out. */
export function isLockedOut(id: string, save: SaveState): boolean {
  return disabledBy(id).some((d) => isDone(d, save));
}

/**
 * A branching choice: it rules something out, something rules it out, or the
 * mod named it in its "?Question?" fork style.
 *
 * All three, because none alone catches the set - two of the 65 "?" topics
 * carry no `disables` of their own and are only ever a target.
 */
export function isRouteTopic(id: string): boolean {
  const t = topic(id);
  if (!t) return false;
  if (list(t.disables).length) return true;
  if (disabledBy(id).length) return true;
  const title = rul.tr(id);
  return typeof title == "string" && title.trim().startsWith("?");
}

/** Every branching choice in the mod. */
export function routeTopics(): string[] {
  return Object.keys(research()).filter(isRouteTopic);
}

/** Drop the memos when the ruleset is reloaded. */
export function resetTechIndex(): void {
  unlockIndex = null;
  disableIndex = null;
}

const isDone = (id: string, save: SaveState) =>
  !!(save && save.discovered && save.discovered.has(id));

/**
 * `needItem`: you must be holding an item with the SAME ID as the topic.
 *
 * This is not a footnote, it is the dominant gate in the whole tree. Against a
 * real save, judging on dependencies alone called 1812 topics available - an
 * unusable wall. 1754 of those want an item, and only 24 of those items were in
 * stores, so the honest list is 82. Nearly every "examine this thing" topic in
 * the mod works this way, which is most of the ruleset.
 */
export function hasNeededItem(id: string, save: SaveState): boolean {
  const t = topic(id);
  if (!t || !t.needItem) return true;
  if (!save || !save.owned) return false;
  return (save.owned.get(id) || 0) > 0;
}

/**
 * Whether the RESEARCH gates are satisfied - dependencies met, or something
 * discovered force-unlocks it. Says nothing about holding the item.
 */
export function researchUnblocked(id: string, save: SaveState): boolean {
  const t = topic(id);
  if (!t || isDone(id, save)) return false;
  // A road not taken is not a road you can go back for.
  if (isLockedOut(id, save)) return false;
  const deps = list(t.dependencies);
  if (!deps.length) return true;
  if (deps.every((d) => isDone(d, save))) return true;
  return unlockedFrom(id).some((u) => isDone(u, save));
}

/** Whether you could actually start it right now: research AND item. */
export function isAvailable(id: string, save: SaveState): boolean {
  return researchUnblocked(id, save) && hasNeededItem(id, save);
}

export function statusOf(id: string, save: SaveState): TopicStatus {
  if (isDone(id, save)) return "done";
  if (isLockedOut(id, save)) return "lockedOut";
  if (save && save.projects && save.projects.has(id)) return "inProgress";
  if (!researchUnblocked(id, save)) return "blocked";
  // Research is clear - the only thing stopping you is not having one.
  return hasNeededItem(id, save) ? "available" : "needsItem";
}

/**
 * The MINIMAL set of prerequisites still missing - the "why can't I research
 * this" answer.
 *
 * Deliberately one layer, not the whole ancestry: a topic three deep whose
 * middle layer is already discovered should report the immediate gap only.
 * Listing every ancestor buries the answer. pathTo is the recursive one.
 */
export function missingFor(id: string, save: SaveState): string[] {
  const t = topic(id);
  if (!t || isDone(id, save)) return [];
  return list(t.dependencies).filter((d) => !isDone(d, save));
}

/**
 * Every still-missing topic needed to reach `id`, in an order you could
 * actually research them in.
 *
 * Depth-first post-order, so a prerequisite always lands before whatever needs
 * it. Anything already discovered is pruned, and `seen` doubles as the cycle
 * guard - the mod does contain loops, and without it this would not terminate.
 */
export function pathTo(id: string, save: SaveState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const walk = (cur: string) => {
    if (!cur || seen.has(cur) || isDone(cur, save)) return;
    seen.add(cur);
    const t = topic(cur);
    if (!t) return;
    for (const d of list(t.dependencies)) walk(d);
    out.push(cur);
  };

  walk(id);
  return out;
}

/**
 * How much work is left on a topic.
 *
 * A started project's numbers come from the SAVE, not the ruleset: OXCE rolls
 * an actual cost per campaign, so the ruleset's figure is only ever an estimate
 * for something you have not begun.
 */
export function remainingCost(id: string, save: SaveState): number {
  const p = save && save.projects ? save.projects.get(id) : null;
  if (p) return p.remaining;
  const t = topic(id);
  const c = t ? +t.cost : NaN;
  return isNaN(c) ? 0 : c;
}

/**
 * Days at this campaign's brainer count, or null when it cannot be said.
 *
 * Null rather than Infinity when there are no brainers: "unknown" is the honest
 * answer and the UI can print a dash. Rounded up, because a part day is a day.
 */
export function daysFor(id: string, save: SaveState): number {
  const brains = save ? +save.scientists || 0 : 0;
  if (!(brains > 0)) return null;
  const left = remainingCost(id, save);
  if (!(left > 0)) return 0;
  return Math.ceil(left / brains);
}

/** Non-research gates this tool does not evaluate, in words. */
export function caveatsFor(id: string): string[] {
  const t = topic(id);
  if (!t) return [];
  const out: string[] = [];
  const base = list(t.requiresBaseFunc);
  if (base.length)
    out.push("Needs base facilities: " + base.join(", ") + " — not checked here.");
  if (t.needItem)
    out.push("Needs one " + rul.tr(id) + " in stores. " +
      (t.destroyItem ? "It is consumed." : "It is not consumed."));
  if (list(t.disables).length)
    out.push(
      "A branching choice - taking it rules out for good: " +
        list(t.disables).map((d) => rul.tr(d)).join(", ")
    );
  if (t.getOneFreeProtected && typeof t.getOneFreeProtected == "object")
    out.push("Grants a conditional free topic (getOneFreeProtected) — not modelled.");
  if (t.lookup) out.push("Shows the article for " + t.lookup + " when completed.");
  return out;
}

/** Everything the UI needs about one topic. */
export function topicInfo(id: string, save: SaveState): TopicInfo {
  const t = topic(id);
  if (!t) return null;
  const p = save && save.projects ? save.projects.get(id) : null;
  return {
    id,
    title: rul.tr(id),
    status: statusOf(id, save),
    missing: missingFor(id, save),
    cost: p ? p.cost : +t.cost || 0,
    remaining: remainingCost(id, save),
    days: daysFor(id, save),
    unlocks: list(t.unlocks),
    getOneFree: list(t.getOneFree),
    lockedBy: disabledBy(id).filter((d) => isDone(d, save)),
    caveats: caveatsFor(id),
  };
}

/**
 * Topics you could start right now.
 *
 * The default screen, and the one that removes the overwhelm: the honest answer
 * to "what are my options" is usually a couple of dozen, not four thousand.
 */
export function availableNow(save: SaveState): string[] {
  const out: string[] = [];
  for (const id of Object.keys(research())) if (isAvailable(id, save)) out.push(id);
  return out;
}

/** Topics already underway, from the save's own project list. */
export function inProgress(save: SaveState): string[] {
  if (!save || !save.projects) return [];
  return [...save.projects.keys()].filter((id) => topic(id));
}

/**
 * For every topic, how many OTHER topics it is the last thing standing between
 * you and.
 *
 * This is the honest measure of "impactful", and it is a fact rather than a
 * weighting: a blocked topic whose only unmet dependency is X becomes available
 * the moment X is done. Count those per X and you have exactly what finishing X
 * buys you.
 *
 * One pass over the ruleset rather than a scan per topic - asking
 * "what does this unblock" for each of 4612 topics individually would be
 * quadratic and far too slow to sort a list with.
 */
export function unblockCounts(save: SaveState): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of Object.keys(research())) {
    if (isDone(id, save)) continue;
    const t = research()[id];
    const unmet = list(t.dependencies).filter((d) => !isDone(d, save));
    // Exactly one thing missing: that one thing is the gate.
    if (unmet.length !== 1) continue;
    out.set(unmet[0], (out.get(unmet[0]) || 0) + 1);
  }
  return out;
}

export type Impact = {
  /** Topics that become available the moment this is done. */
  unblocks: number;
  /** Concrete things it hands you: manufacture, purchases, a free item. */
  gear: number;
  /** Days at the save's brainer count, or null. */
  days: number;
  /** Value per day. Higher is better. */
  score: number;
};

/**
 * Value per day: how much this opens up, against how long it takes.
 *
 * value  = topics it unblocks + things it lets you build, buy or receive
 * score  = value / days
 *
 * Deliberately a ratio rather than a weighted sum, so there is nothing to tune
 * and nothing to argue with: a cheap topic that frees six others beats an
 * expensive one that frees two, and both beat a dead end. With no brainers to
 * divide by, the remaining cost stands in - the ordering is the same, only the
 * units differ.
 *
 * Pass `counts` from unblockCounts so a whole list can be sorted in one pass.
 */
export function impactOf(id: string, save: SaveState, counts?: Map<string, number>): Impact {
  const c = counts || unblockCounts(save);
  const o = opensUp(id);
  const unblocks = c.get(id) || 0;
  const gear = o.manufacture.length + o.buy.length + (o.item ? 1 : 0);
  const days = daysFor(id, save);
  const denominator = days != null ? Math.max(1, days) : Math.max(1, remainingCost(id, save));
  return { unblocks, gear, days, score: (unblocks + gear) / denominator };
}

/**
 * What having this topic opens up, beyond more research.
 *
 * Reads the reverse links Ruleset already builds at load - `manufacture` from
 * manufacture.requires, `allowsBuying` from item.requiresBuy, `spawnedItem`,
 * `leadsTo` from other topics' dependencies, `freeFrom` from getOneFree.
 */
export function opensUp(id: string): {
  research: string[];
  manufacture: string[];
  buy: string[];
  item: string;
} {
  const t = topic(id);
  if (!t) return { research: [], manufacture: [], buy: [], item: "" };
  const forward = new Set<string>([...list(t.unlocks), ...list(t.leadsTo)]);
  return {
    research: [...forward],
    manufacture: list(t.manufacture),
    buy: list(t.allowsBuying),
    item: typeof t.spawnedItem == "string" ? t.spawnedItem : "",
  };
}
