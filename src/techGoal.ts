/**
 * "How do I get X?" for anything in the pedia, not just research topics.
 *
 * techTree.ts answers questions about RESEARCH: what can I start, what is this
 * blocked on, what order do I take these in. That is only half of what a player
 * actually asks. The other half is about a THING - a laspistol, a crate of
 * Necroplane Parts, a hangar - and the honest answer to that is very often not
 * a research topic at all. It is "buy it, once you have the contact", or "it
 * drops on these missions", or "one random event hands you a few".
 *
 * So this module turns any id in the ruleset into a list of ROUTES: concrete
 * ways to end up holding the thing, each carrying whatever research gates that
 * particular route.
 *
 * ROUTES ARE ALTERNATIVES, NEVER A UNION. Buying a Necroplane Part and pulling
 * one out of a wreck are different answers; merging their prerequisites would
 * invent a tech path nobody has to walk. Every route therefore gets its own
 * `path`, and `best` picks the shortest one that actually has research in it
 * rather than averaging them together.
 *
 * WHAT IT DOES NOT DO, and says so rather than guessing: it does not work out
 * whether a mission can still appear (that lives in missionScripts' triggers,
 * several layers off), how likely a weighted event roll is, or whether a
 * facility's services are built. Those are named in words and left to the
 * player - see `services` and the mission/event routes.
 *
 * No UI in here, same as techTree.ts.
 */
import { rul } from "./Ruleset";
import type { SaveState } from "./damageSave";
import { pathToAll, statusOf, topic } from "./techTree";
import { salvageProblem, salvageReady, setsForType, usersOfSet } from "./salvage";

export type GoalKind =
  | "research"
  | "item"
  | "manufacture"
  | "facility"
  | "craft"
  | "craftWeapon"
  | "armor"
  | "unit"
  | "deployment"
  | "other";

/** Heading a kind files under in the search results. */
export const KIND_LABEL: { [k in GoalKind]: string } = {
  research: "Research",
  item: "Items",
  manufacture: "Manufacturing",
  facility: "Facilities",
  craft: "Craft",
  craftWeapon: "Craft weapons",
  armor: "Armour",
  unit: "Units",
  deployment: "Missions",
  other: "Other",
};

/** The order the result groups are shown in. */
export const KIND_ORDER: GoalKind[] = [
  "item",
  "research",
  "manufacture",
  "craft",
  "craftWeapon",
  "armor",
  "facility",
  "unit",
  "deployment",
  "other",
];

const coll = (name: string): { [id: string]: any } => (rul && rul[name]) || {};

/**
 * What an id mostly IS.
 *
 * Plenty of ids live in several collections at once - a creature is routinely
 * an item, a unit and a research topic under one name - so this is a priority
 * order, not a lookup. `item` wins over `research` because when a player types
 * a thing's name they mean the thing, and the same-id topic is reachable from
 * the thing's routes anyway.
 */
export function kindOf(id: string): GoalKind {
  if (!id) return "other";
  if (coll("items")[id]) return "item";
  if (coll("research")[id]) return "research";
  if (coll("manufacture")[id]) return "manufacture";
  if (coll("crafts")[id]) return "craft";
  if (coll("craftWeapons")[id]) return "craftWeapon";
  if (coll("armors")[id]) return "armor";
  if (coll("facilities")[id]) return "facility";
  if (coll("units")[id]) return "unit";
  if (coll("alienDeployments")[id]) return "deployment";
  return "other";
}

/** Plain text for matching: no icon markup, no tooltip wrapper. */
const plain = (id: string): string => {
  const s = rul.tr(id, { icon: "none", notip: true });
  return typeof s == "string" ? s : id;
};

/** "1 craft" / "3 craft", "1 mission" / "55 missions". */
const count = (n: number, one: string, many = one + "s") => n + " " + (n == 1 ? one : many);

const asList = (v: any): string[] =>
  v == null ? [] : (Array.isArray(v) ? v : [v]).filter((x) => typeof x == "string" && x);

export type GoalMatch = { id: string; title: string; kind: GoalKind };

/**
 * The search index, built once.
 *
 * Every pedia article, which is the widest net available - items, research,
 * manufacture, facilities and the rest all create one. Rebuilt when the
 * language changes, since the titles are what people type against.
 */
let index: { id: string; title: string; low: string; idLow: string; kind: GoalKind }[] = null;
let indexLang = "";

function buildIndex() {
  if (index && indexLang == rul.langName) return;
  indexLang = rul.langName;
  index = Object.keys(rul.articles || {}).map((id) => {
    const title = plain(id);
    return { id, title, low: title.toLowerCase(), idLow: id.toLowerCase(), kind: kindOf(id) };
  });
}

/* No reset hook: buildIndex already rebuilds itself when rul.langName changes,
   which is the only invalidation that can happen in a session. See the note in
   techTree.ts. */

/**
 * Anything in the pedia whose name or id matches.
 *
 * Every word of the query must appear somewhere, so "laser pistol" finds the
 * Laser Pistol without also finding every pistol and every laser. Ranked so an
 * exact name lands first and a mere substring last, because "laser" should open
 * with the Laser topic rather than with Laser Cannon Ammo.
 */
export function searchGoals(query: string, limit = 60): GoalMatch[] {
  const q = (query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  buildIndex();
  const words = q.split(/\s+/).filter((w) => w);
  const hits: { m: GoalMatch; rank: number }[] = [];

  for (const e of index) {
    if (!words.every((w) => e.low.includes(w) || e.idLow.includes(w))) continue;
    const rank =
      e.low == q || e.idLow == q
        ? 0
        : e.low.startsWith(q)
          ? 1
          : e.idLow.startsWith(q)
            ? 2
            : e.low.includes(q)
              ? 3
              : 4;
    hits.push({ m: { id: e.id, title: e.title, kind: e.kind }, rank });
  }

  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.m.title.length - b.m.title.length ||
      (a.m.title < b.m.title ? -1 : a.m.title > b.m.title ? 1 : 0)
  );
  return hits.slice(0, limit).map((h) => h.m);
}

export type RouteGroup =
  | "research"
  | "manufacture"
  | "buy"
  | "mission"
  | "wreck"
  | "salvage"
  | "terrain"
  | "event"
  | "build"
  | "other";

/** Heading and one-line explanation per route group. */
export const GROUP_LABEL: { [k in RouteGroup]: string } = {
  research: "Research reward",
  manufacture: "Build it",
  buy: "Buy it",
  /**
   * These three were "Battlefield loot", "Craft wrecks" and "Found on terrain",
   * which hid the distinction that actually matters. `mission` means a UNIT is
   * holding one; `wreck` and `terrain` mean a copy is lying on a floor tile.
   * A ship routinely appears under both, and it means two different things -
   * its crew carry one AND there is a loose one on the deck.
   */
  mission: "Carried by enemies",
  wreck: "Found on craft",
  salvage: "Battlefield salvage",
  terrain: "Found on terrain",
  event: "Random events",
  build: "Base facility",
  other: "Other",
};

export const GROUP_HINT: { [k in RouteGroup]: string } = {
  research: "Finishing the topic hands you one outright.",
  manufacture: "A workshop project produces it.",
  buy: "It is on the purchase list once the research is done.",
  mission: "An enemy who spawns on these missions is carrying one, so you take it off them. Whether the mission can still turn up is not checked here.",
  wreck: "A copy is placed on a floor tile inside these craft, so it is lying there to be picked up whether or not anyone aboard is carrying one.",
  salvage:
    "It has its own recovery type, which means you get it by clearing the matching wreckage on the battlefield - a downed craft, a ruined structure - rather than by picking an item up. Which tiles those are lives in the map data, not in the ruleset, so they cannot be named here.",
  terrain: "A copy is placed on a floor tile of these terrains, so any mission that uses one can have it lying about.",
  event: "A random event can hand it to you. Events are rolled by the game, so there is nothing to research and nothing to aim for.",
  build: "Built as a base facility.",
  other: "",
};

/** The order route groups are shown in: things you can act on deliberately first. */
export const GROUP_ORDER: RouteGroup[] = [
  "research",
  "manufacture",
  "buy",
  "build",
  "mission",
  "wreck",
  "salvage",
  "terrain",
  "event",
  "other",
];

/**
 * A salvage route, resolved as far as the data allows.
 *
 * `sets` comes from the MCD scan (see salvage.ts); everything after it is
 * ruleset. When the scan has not finished, `ready` is false and the UI says so
 * rather than printing a bare number.
 */
export type SalvageDetail = {
  type: number;
  sets: { name: string; tiles: number }[];
  /** Craft whose wreck is built from those tilesets. Names, sorted, distinct. */
  crafts: string[];
  terrains: string[];
  /** Deployments that use those terrains. Names, sorted, distinct. */
  missions: string[];
  ready: boolean;
  problem: string;
};

export type Route = {
  group: RouteGroup;
  /** The route in one line, already translated. */
  label: string;
  /** Already-translated detail lines - projects, deployments, events. */
  via: string[];
  /** Research that must be done before this route is open at all. */
  gates: string[];
  /** Base services it also wants. Named, not evaluated - see caveats. */
  services: string[];
  /** Still-missing research for THIS route, in an order you could do it in. */
  path: string[];
  /** True when nothing stands between you and this route. */
  open: boolean;
  /** Set only on a salvage route. */
  salvage?: SalvageDetail;
};

function makeRoute(
  group: RouteGroup,
  label: string,
  gates: string[],
  save: SaveState,
  extra: { via?: string[]; services?: string[] } = {}
): Route {
  const real = gates.filter((g) => topic(g));
  const path = pathToAll(real, save);
  return {
    group,
    label,
    via: extra.via || [],
    gates,
    services: extra.services || [],
    path,
    open: path.length == 0,
  };
}

/**
 * One manufacture project, as a line: what it is and how much it yields.
 *
 * A random output gets its expected yield, which is the only honest number
 * available - randomProducedItems is a weighted roll, not a recipe. Below a
 * hundredth it is described in words instead, because "0 per run" reads as
 * "never" and is wrong.
 */
function projectLine(m: any, id: string): string {
  const each = m.producedItems && m.producedItems[id];
  if (each) return plain(m.id) + " — makes " + each;
  const avg = m.totalProducedItems ? +m.totalProducedItems[id] || 0 : 0;
  if (avg >= 0.01) return plain(m.id) + " — averages " + Math.round(avg * 100) / 100 + " per run";
  if (avg > 0) return plain(m.id) + " — rare random output";
  return plain(m.id);
}

/**
 * Turn a bare specialType into the tilesets, craft, terrains and missions it
 * stands for.
 *
 * The tileset half needs the MCD scan; until that lands, `ready` is false and
 * the caller is expected to say "still reading the tile data" rather than print
 * the number on its own.
 */
export function salvageDetail(type: number): SalvageDetail {
  const sets = setsForType(type);
  const craftIds: string[] = [];
  const terrainIds: string[] = [];
  for (const s of sets) {
    const u = usersOfSet(s.name);
    for (const c of u.crafts) if (!craftIds.includes(c)) craftIds.push(c);
    for (const t of u.terrains) if (!terrainIds.includes(t)) terrainIds.push(t);
  }

  // Terrain to mission, through the backlink Ruleset already builds from
  // alienDeployments.terrains.
  const missionIds: string[] = [];
  for (const t of terrainIds)
    for (const d of ((rul.terrains || {})[t] || {}).alienDeployments || [])
      if (!missionIds.includes(d)) missionIds.push(d);

  // Distinct names, alphabetical - same reasoning as `named` above: ids are
  // unique, the names people read are not, and ruleset order is not an order.
  const names = (ids: string[]) =>
    [...new Set(ids.map(plain))].sort((a, b) => a.localeCompare(b));

  return {
    type,
    sets,
    crafts: names(craftIds),
    terrains: names(terrainIds),
    missions: names(missionIds),
    ready: salvageReady(),
    problem: salvageProblem(),
  };
}

/** The salvage route in one line, as specific as the data allows. */
function salvageLabel(d: SalvageDetail): string {
  if (!d.ready) return "Reading the tile data…";
  if (!d.sets.length)
    return "Recovery type " + d.type + " — no tileset in the installed mods defines it";
  const names = d.sets.map((s) => s.name).join(", ");
  return "Clear the wreckage built from " + names;
}

/**
 * Every way to end up holding `id`, each with its own research.
 *
 * Ordered by GROUP_ORDER at the end, so the routes you can actually steer
 * toward come before the ones that are just a fact about the world.
 */
export function routesTo(id: string, save: SaveState): Route[] {
  const out: Route[] = [];
  if (!id) return out;

  const item = coll("items")[id];
  const res = coll("research")[id];

  // The topic itself. For an id that is only a research topic this is the whole
  // answer; for a thing that also has a same-named topic it is the "study it"
  // route, which is usually what unlocks everything else.
  if (res)
    out.push(
      makeRoute("research", "Research " + plain(id), [id], save, {
        services: asList(res.requiresBaseFunc),
      })
    );

  if (item) {
    // Research that hands the item over on completion.
    for (const t of asList(item.spawnedBy)) {
      if (t == id) continue;
      out.push(makeRoute("research", "Finish " + plain(t) + " — it gives you one", [t], save));
    }

    /**
     * Workshop projects that output it, including random outputs - the backlink
     * is built from totalProducedItems, which folds randomProducedItems in.
     *
     * Projects behind the SAME research are merged into one route. Necroplane
     * Parts come out of twelve regional Scavenged Supplies extractions, all
     * gated on one topic; twelve identical boxes are twelve copies of one
     * answer, and they push the shop and the loot table off the bottom of the
     * column. Different research still means a different route, because it is a
     * different decision.
     */
    const byGate = new Map<string, { list: any[]; gates: string[]; services: string[] }>();
    for (const p of asList(item.manufacture)) {
      const m = coll("manufacture")[p];
      if (!m) continue;
      const gates = asList(m.requires);
      const services = asList(m.requiresBaseFunc);
      const key = gates.join("|") + "//" + services.join("|");
      const cur = byGate.get(key);
      if (cur) cur.list.push(m);
      else byGate.set(key, { list: [m], gates, services });
    }
    for (const g of byGate.values()) {
      const lines = g.list.map((m) => projectLine(m, id));
      out.push(
        makeRoute(
          "manufacture",
          g.list.length == 1 ? lines[0] : g.list.length + " projects produce it",
          g.gates,
          save,
          { via: g.list.length == 1 ? [] : lines, services: g.services }
        )
      );
    }

    if (+item.costBuy > 0)
      out.push(
        makeRoute("buy", "Buy for $" + (+item.costBuy).toLocaleString(), asList(item.requiresBuy), save, {
          services: asList(item.requiresBuyBaseFunc),
        })
      );

    /**
     * A field's backlinks as a sorted list of distinct NAMES.
     *
     * The backlinks arrive in ruleset file order, which is not an order anyone
     * can use - it is neither chronological nor alphabetical, just whatever
     * sequence the .rul files happen to define things in. And the ids are
     * unique while the names are not: four different deployments are all called
     * "Bandit Camp", so a raw map printed it four times and the count said four
     * when there is one thing to go and do. Distinct names, alphabetical.
     */
    const named = (field: string) =>
      [...new Set(asList(item[field]).map(plain))].sort((a, b) => a.localeCompare(b));

    const loot = named("loot");
    if (loot.length)
      out.push(
        makeRoute("mission", "Enemies on " + count(loot.length, "mission") + " carry one", [], save, {
          via: loot,
        })
      );

    const wrecks = named("ufos");
    if (wrecks.length)
      out.push(
        makeRoute("wreck", "Lying aboard " + count(wrecks.length, "craft", "craft"), [], save, { via: wrecks })
      );

    /**
     * A recovery type of its own: the item is salvaged off a battlefield tile
     * rather than picked up. 67 items in the mod carry one, every value
     * distinct, so it is a straight 1:1 "clear this kind of wreckage, get this"
     * - and for several of them it is the ONLY route the ruleset records.
     */
    if (+item.specialType > 0 && item.recover !== false) {
      const detail = salvageDetail(+item.specialType);
      const r = makeRoute("salvage", salvageLabel(detail), [], save);
      r.salvage = detail;
      out.push(r);
    }

    const terrains = named("terrains");
    if (terrains.length)
      out.push(
        makeRoute("terrain", "Lying on " + count(terrains.length, "terrain"), [], save, {
          via: terrains,
        })
      );

    const events = named("events");
    if (events.length)
      out.push(
        makeRoute("event", count(events.length, "event") + " can hand it over", [], save, { via: events })
      );
  }

  // Anything else that carries its own research gate: a facility, a craft, an
  // armour, a manufacture project searched for by name. The item and research
  // cases above already covered their own, so this only fires for the rest.
  for (const name of ["manufacture", "facilities", "crafts", "craftWeapons", "armors", "units"]) {
    const e = coll(name)[id];
    if (!e) continue;
    const gates = asList(e.requires);
    if (!gates.length) continue;
    if (out.some((r) => r.gates.join("|") == gates.join("|"))) continue;
    out.push(
      makeRoute(
        name == "facilities" ? "build" : name == "manufacture" ? "manufacture" : "other",
        name == "facilities" ? "Build it at a base" : "Needs this research first",
        gates,
        save,
        { services: asList(e.requiresBaseFunc) }
      )
    );
  }

  // Group first, then the cheapest option inside a group, so the answer you are
  // most likely to act on is the one at the top of its box.
  return out.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.path.length - b.path.length
  );
}

export type GoalPlan = {
  id: string;
  title: string;
  kind: GoalKind;
  /** Whether the save already has the research side of this settled. */
  status: string;
  /** Research the thing itself declares, whatever route you take. */
  prereq: string[];
  routes: Route[];
  /** The shortest route that has research in it, or null when none has any. */
  best: Route;
  /** Routes that need nothing researched at all. */
  free: Route[];
  /** Said out loud when there is no tech path to give. */
  note: string;
};

/**
 * Everything the goal panel needs about one target.
 *
 * `best` is deliberately chosen only from routes that HAVE research: a route
 * with no gates always has a zero-length path, so letting those compete would
 * make "it drops on missions" beat every real tech path and answer a question
 * nobody asked. They are reported separately, in `free`.
 */
export function goalPlan(id: string, save: SaveState): GoalPlan {
  if (!id || !(rul.articles || {})[id]) return null;
  const routes = routesTo(id, save);
  const gated = routes.filter((r) => r.gates.length);
  const free = routes.filter((r) => !r.gates.length);

  let best: Route = null;
  for (const r of gated) if (!best || r.path.length < best.path.length) best = r;

  const item = coll("items")[id];
  const art = (rul.articles || {})[id];
  const prereq = [
    ...new Set([
      ...asList(item && item.requires),
      ...asList(art && art.requires).filter((r) => r != id),
    ]),
  ];

  let note = "";
  if (!routes.length)
    note =
      "Nothing in the ruleset says how this is obtained - no research, no project, no shop entry, no loot table. It is most likely built in, given at the start, or reached through something the pedia does not record.";
  else if (!gated.length)
    note = "No research gates this. Everything below is already open to you.";
  else if (best && best.open)
    note = "Nothing left to research - the " + GROUP_LABEL[best.group].toLowerCase() + " route is open.";

  return {
    id,
    title: plain(id),
    kind: kindOf(id),
    status: topic(id) ? statusOf(id, save) : "",
    prereq,
    routes,
    best,
    free,
    note,
  };
}
