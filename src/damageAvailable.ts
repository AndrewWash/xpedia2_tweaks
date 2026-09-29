/**
 * Which weapons can this campaign actually field.
 *
 * Three verdicts per weapon, because the ruleset alone cannot answer the
 * question. Of 2,965 item entries in XPiratez, 2,184 carry none of `requires`,
 * `requiresBuy` or `costBuy` - and for pure mission loot (the AUX_* built-ins,
 * or STR_ROBO_PARROT which a random event hands you) there is no gate anywhere
 * in the ruleset at all. Nothing in the rules distinguishes "you have never seen
 * one" from "you own six". Only the save knows, which is why ownership is a
 * first-class signal here rather than a nicety:
 *
 *   owned     it is in a base store or loaded on a craft, right now
 *   buyable   purchasable, and the research that gates buying is done
 *   makeable  some manufacture project builds it and its research is done
 *
 * A NOTE ON WHERE GATES LIVE. compareDiff's fieldAcross() resolves a
 * requirement by looking at every collection sharing one STR_ id, which is the
 * right answer for the Compare table - "what research does this thing need" has
 * one answer. It is the wrong answer here, and deliberately not used: a
 * manufacture project's `requires` gates BUILDING, not buying, so pulling it
 * onto the purchase path would report a laser rifle as purchasable the moment it
 * became craftable. The two paths are kept separate - buy gates are read off the
 * item, build gates off each manufacture project that produces it - which also
 * happens to be how the engine reads them.
 *
 * NOT MODELLED, and worth knowing before trusting a "can get" verdict:
 *   - requiresBaseFunc / requiresBuyBaseFunc: the workshop, lab or service a
 *     project or purchase needs. A weapon you cannot build for want of a
 *     facility still reads as makeable.
 *   - market availability beyond research: diplomacy, contacts and stock.
 *   - event-granted items, which can only ever read as owned.
 */
import { rul } from "./Ruleset";
import type { SaveState } from "./damageSave";
import type { WeaponOption } from "./damageWeapons";

export type Availability = {
  owned: boolean;
  /** How many you hold, across every base and craft. */
  count: number;
  buyable: boolean;
  makeable: boolean;
  /** owned || buyable || makeable */
  obtainable: boolean;
  /**
   * For an ammo-fed weapon, whether any clip it takes is in stores. False on a
   * weapon you own but have no shells for - reported, never filtered on, since
   * "I own it but it is empty" is information rather than grounds for hiding.
   */
  ammoOwned: boolean;
  /** True when it takes no clips, so ammoOwned is not a meaningful question. */
  selfLoading: boolean;
};

export type AvailabilityMode = "off" | "stores" | "obtainable";

const asList = (v: any): string[] =>
  v == null ? [] : Array.isArray(v) ? v.filter((x) => typeof x == "string") : typeof v == "string" ? [v] : [];

/** Every id in the list is complete. An empty list is no gate, so it passes. */
function allDone(ids: string[], discovered: Set<string>): boolean {
  for (const id of ids) if (!discovered.has(id)) return false;
  return true;
}

/**
 * Can this be bought?
 *
 * Needs a purchase price and its buy research. `requires` and `requiresBuy` are
 * both read off the item and ANDed, which is the conservative reading and makes
 * the `requires: [STR_UNAVAILABLE]` idiom work correctly: nothing ever
 * discovers STR_UNAVAILABLE, so TROLLIUM and its kin stay permanently
 * unavailable instead of appearing the moment you have a shopping list.
 */
function canBuy(item: any, discovered: Set<string>): boolean {
  if (!item) return false;
  const price = +item.costBuy;
  if (!(price > 0)) return false;
  return (
    allDone(asList(item.requires), discovered) &&
    allDone(asList(item.requiresBuy), discovered)
  );
}

/**
 * Can this be built?
 *
 * Ruleset back-links every project's totalProducedItems onto the items it makes,
 * so there is no index to build here. A project with no `requires` is
 * unconditionally available, which is correct: STR_BAMBOO has a manufacture
 * entry with no research gate and is craftable from the first day.
 *
 * `item.manufacture` HAS TWO SHAPES, and reading only one of them made this
 * function return false for every item in the mod. backLink() builds it as an
 * ARRAY of project ids; the facilities pass then hangs named properties on that
 * same value (`item.manufacture[facilityType] = refund`) for anything you get
 * back when a facility is dismantled. The old code called Object.keys() on it,
 * which on an array yields "0", "1", "2" - indices, not project ids - so every
 * lookup in rul.manufacture missed and nothing was ever makeable. The Flintlock
 * Rifle is the visible symptom: researched, buildable, and absent from "owned or
 * can get" until you actually built one.
 */
function canMake(item: any, discovered: Set<string>): boolean {
  if (!item || !item.manufacture) return false;
  const projects = Array.isArray(item.manufacture)
    ? item.manufacture
    : Object.keys(item.manufacture);
  for (const projectId of projects) {
    if (typeof projectId != "string") continue;
    const project = rul.manufacture && rul.manufacture[projectId];
    if (!project) continue;
    if (allDone(asList(project.requires), discovered)) return true;
  }
  return false;
}

/**
 * Work out every weapon's standing in one pass.
 *
 * Done once per loaded save rather than per row: the filter and the chip counts
 * both consult it on every keystroke, and re-deriving it each time would mean
 * walking the manufacture links of 635 weapons for nothing.
 */
export function buildAvailability(
  weapons: WeaponOption[],
  save: SaveState
): Map<string, Availability> {
  const out = new Map<string, Availability>();
  if (!save) return out;

  for (const w of weapons) {
    const item = w.item;
    const count = save.owned.get(w.id) || 0;
    const owned = count > 0;
    const buyable = canBuy(item, save.discovered);
    const makeable = canMake(item, save.discovered);

    const selfLoading = !w.ammoOptions || !w.ammoOptions.length;
    const ammoOwned = selfLoading
      ? true
      : w.ammoOptions.some((a) => (save.owned.get(a) || 0) > 0);

    out.set(w.id, {
      owned,
      count,
      buyable,
      makeable,
      obtainable: owned || buyable || makeable,
      ammoOwned,
      selfLoading,
    });
  }
  return out;
}

/**
 * Whether an ARMOUR can be put on, under the chosen mode.
 *
 * An armour is stocked as an ordinary item named by its `storeItem`, so its
 * availability is that item's - the same 1:1 link Compare already follows to
 * find an armour's research requirements (REQUIREMENT_VIA_FIELDS).
 *
 * Two cases mean "always available" rather than "unavailable": no `storeItem`
 * at all, and the explicit STR_NONE the mod uses for innate suits that cost you
 * nothing to wear. 539 of 567 armours name a store item; the rest are free.
 */
export function armorAvailable(
  armorId: string,
  mode: AvailabilityMode,
  save: SaveState
): boolean {
  if (mode == "off" || !save) return true;
  const armor = rul.armors ? rul.armors[armorId] : null;
  if (!armor) return true;

  const store = armor.storeItem;
  if (!store || store == "STR_NONE") return true;

  if ((save.owned.get(store) || 0) > 0) return true;
  if (mode == "stores") return false;

  const item = rul.items ? rul.items[store] : null;
  return canBuy(item, save.discovered) || canMake(item, save.discovered);
}

/**
 * Which clips this campaign could actually put in the gun.
 *
 * Returns a predicate, or null when every clip is allowed - the caller treats
 * null as "no restriction" so the common case does no work per clip.
 *
 * Gated exactly like the weapons themselves: `stores` means a clip you hold,
 * `obtainable` adds the ones your research lets you buy or build. That matters
 * because ranking a launcher on a warhead you cannot get is the same lie as
 * listing a weapon you cannot get - the Bombard reads 350 power on an Atomic
 * round you have never seen, and nothing on screen says so.
 *
 * It is a preference, not a filter: scoreWeaponBestClip falls back to the whole
 * clip list when none are fieldable, because a gun you own with nothing to load
 * is still worth a row. The ⚠ NO AMMO marker already tells you it is dry.
 */
export function clipAllowed(
  mode: AvailabilityMode,
  save: SaveState
): ((id: string) => boolean) | null {
  if (mode == "off" || !save) return null;
  if (mode == "stores") return (id) => (save.owned.get(id) || 0) > 0;
  return (id) => {
    if ((save.owned.get(id) || 0) > 0) return true;
    const item = rul.items ? rul.items[id] : null;
    return canBuy(item, save.discovered) || canMake(item, save.discovered);
  };
}

/** Does this weapon pass the chosen mode? */
export function passesAvailability(
  id: string,
  mode: AvailabilityMode,
  table: Map<string, Availability>
): boolean {
  if (mode == "off") return true;
  if (!table || !table.size) return true;
  const a = table.get(id);
  if (!a) return false;
  return mode == "stores" ? a.owned : a.obtainable;
}

/** Why a weapon is in the list, for the row tooltip. */
export function availabilityNote(a: Availability): string {
  if (!a) return "";
  const parts = [];
  if (a.owned) parts.push(a.count + " in stores");
  if (a.buyable) parts.push("can be bought");
  if (a.makeable) parts.push("can be manufactured");
  if (!parts.length) return "Not available in this campaign";
  if (!a.selfLoading && !a.ammoOwned) parts.push("NO AMMO in stores");
  return parts.join(" · ");
}
