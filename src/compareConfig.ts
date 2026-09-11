/**
 * Compare-mode configuration.
 *
 * This is the file to edit when compare misses something. It is plain data with
 * no logic in it, so adding a stat is a one-line change:
 *
 *   - Compare shows a stat but colours the delta grey?
 *       Add the field name to HIGHER_BETTER or LOWER_BETTER.
 *   - Compare shows a junk row you never want to see?
 *       Add the field name to SKIP_FIELDS (or a fragment to SKIP_SUBSTR).
 *   - A whole kind of article will not compare at all?
 *       Add its ruleset collection to KINDS.
 *   - A weapon attack is missing a row (snap/aimed/auto table)?
 *       Add the field to ATTACK_FIELDS, and its direction to ATTACK_DIR.
 *
 * Field names are the raw ruleset keys, exactly as they appear in the .rul files
 * and in the stat table on an article page - `power`, `tuSnap`, `speedMax`. The
 * quickest way to find one: open the article, and the left-hand column of the
 * stat table is the key list.
 *
 * Nested keys use a dot: `cost.time`, `damageAlter.ToHealth`. Only one level of
 * nesting is read (see FLATTEN_DEPTH below).
 *
 * After editing, run `npm run build` and reload the page. If you are going to be
 * editing a lot, leave `npm run watch` running instead and it rebuilds on save.
 */

/**
 * Ruleset collections we know how to diff, in the order we probe them for an id.
 * The names are the properties on `rul` (see Ruleset.ts) - `rul.items`,
 * `rul.armors`, and so on. First collection containing the id wins, so if an id
 * exists in two places the earlier entry here is the one that gets compared.
 */
export const KINDS = [
  "items",
  "armors",
  "units",
  "crafts",
  "craftWeapons",
  "facilities",
  "manufacture",
  "research",
  "commendations",
  "soldiers",
  "soldierBonuses",
  "soldierTransformation",
  "ufos",
  "alienDeployments",
  "alienRaces",
  "countries",
  "events",
  "enviroEffects",
  "startingConditions",
];

/**
 * Fields that are presentation or bookkeeping, never worth a diff row.
 * Matched exactly, against both plain and nested keys' own segment.
 */
export const SKIP_FIELDS = [
  "id",
  "type",
  "name",
  "title",
  "list",
  "listOrder",
  "index",
  "text",
  "section",
  "sections",
  "article",
  "layersDefinition",
  "layersDefaultPrefix",
  "dollSprites",
  "customArmorPreviewIndex",
  "battlescapeTerrainData",
  "craftInventoryTile",
  "deployment",
  "mapBlocks",
];

/**
 * Any field whose name *contains* one of these (case-insensitive) is skipped.
 * This sweeps up the whole sprite/sound/animation family without having to list
 * every variant. Keep these fragments distinctive - a short one like "in" would
 * silently eat half the ruleset.
 */
export const SKIP_SUBSTR = ["sprite", "sound", "animation", "palette"];

/**
 * Full dotted paths to skip. SKIP_FIELDS matches a key wherever it appears, so
 * it cannot target one nested field without hitting the same name everywhere -
 * that is what this is for.
 *
 * The armor.* entries exist because the Armor class derives an `armor` object
 * from frontArmor/sideArmor/rearArmor/underArmor, so every armour reported each
 * value twice. The flat scalars are the ones kept: they are the names that
 * appear in HIGHER_BETTER, so they get the better/worse colouring.
 */
export const SKIP_PATHS = [
  "armor.Front",
  "armor.Side",
  "armor.Rear",
  "armor.Under",
];

/**
 * Which way is "better" for a given field. This drives three things: the green
 * "best" cell, the red "worst" cell, and the colour of the Δ column.
 *
 * Deliberately hand-curated: anything not listed here still shows its numbers
 * and its delta, just in neutral grey rather than guessing which way is good.
 * That is the right failure mode when a mod invents its own stats - a wrong
 * green is worse than no green.
 */
export const HIGHER_BETTER = [
  "power", "damage", "damageMax", "accuracy", "accuracyAimed", "accuracySnap",
  "accuracyAuto", "accuracyMelee", "accuracyThrow", "accuracyUse", "range",
  "maxRange", "aimRange", "snapRange", "autoRange", "ammoMax", "clipSize",
  "armor", "frontArmor", "sideArmor", "rearArmor", "underArmor",
  "health", "stamina", "strength", "firing", "throwing", "melee", "reactions",
  "bravery", "psiStrength", "psiSkill", "mana", "tu",
  "speedMax", "accel", "repairRate", "radarRange", "radarChance", "sightRange",
  "soldiers", "vehicles", "weapons", "storage", "personnel", "workshops",
  "laboratories", "defense", "hitRatio", "aliens",
  "profit", "profitPerHour", "costSell", "fundingBase", "fundingCap",
  "autoShots", "shotgunPellets", "blastRadius", "meleePower",
  "energyRecovery", "healthRecovery", "stunRecovery", "moraleRecovery",
  "manaRecoveryPerDay", "sickBayAbsoluteBonus", "sickBayRelativeBonus",
  "psiVision", "heatVision", "camouflageAtDark", "camouflageAtDay",
  "visibilityAtDark", "visibilityAtDay", "throwRange",
];

/** Fields where a smaller number is the better one. Same rules as above. */
export const LOWER_BETTER = [
  "costBuy", "costRent", "weight", "size", "tuUse", "tuAimed", "tuSnap",
  "tuAuto", "tuMelee", "tuThrow", "buildCost", "buildTime", "monthlyCost",
  "monthlyMaintenance", "monthlySalary", "time", "cost", "space",
  "transferTime", "recoveryTime", "powerRangeReduction", "powerRangeThreshold",
  "dropoff", "invWidth", "invHeight", "oneHandedPenalty", "explosionSpeed",
  "refuelRate",
];

/**
 * Rows in the per-attack table for weapons - the snap-vs-aimed-vs-auto block at
 * the top of the difference summary. These are read off the Attack object
 * (Ruleset.ts), not off the item, so the names here are Attack's properties.
 */
export const ATTACK_FIELDS = [
  "damage",
  "damageType",
  "accuracy",
  "shots",
  "pellets",
  "range",
  "cost.time",
  "cost.energy",
];

/**
 * Direction for the attack rows above: 1 = higher is better, -1 = lower is
 * better. Anything left out is neutral. Kept separate from HIGHER_BETTER
 * because the same word can mean opposite things on an attack and on an item
 * (an attack's `cost.time` is a cost; an item's `time` may be a duration).
 */
export const ATTACK_DIR: { [k: string]: number } = {
  damage: 1,
  accuracy: 1,
  shots: 1,
  pellets: 1,
  range: 1,
  "cost.time": -1,
  "cost.energy": -1,
};

/**
 * Arrays longer than this are treated as backlink dumps ("used by these 60
 * units") and dropped, since listing them side by side tells you nothing.
 *
 * Note this also catches genuine wide stat arrays - armour resistances are one
 * entry per damage type, which is 24 - so raising it is a blunt instrument that
 * lets the noise back in too.
 */
export const MAX_LIST_LENGTH = 12;

/**
 * How many levels of nested object to read. 1 reaches the things people
 * actually compare (damageAlter, damageBonus, stats, cost) without dragging in
 * whole map definitions. Raising this gets expensive fast.
 */
export const FLATTEN_DEPTH = 1;

/** Most panes you can put side by side, and most rows you can tick to compare. */
export const MAX_PANES = 4;

/**
 * Fields that always get a row, even when the list is longer than
 * MAX_LIST_LENGTH. Prerequisite lists are the reason this exists: a late-game
 * item can require a dozen-plus technologies, and "what do I still need to
 * research" is exactly the question compare should answer, so these must never
 * be mistaken for backlink noise and dropped.
 */
export const FORCE_FIELDS = [
  "requires",
  "requiresBuy",
  "requiresBaseFunc",
  "requiresBuyBaseFunc",
  "dependencies",
  "getOneFree",
  "unlocks",
  "requiredItems",
  "producedItems",
  "damageModifier",
];

/**
 * Prerequisite rows, pulled out into their own block at the bottom of the
 * difference summary so they are always visible rather than buried by the
 * biggest-gap-first sort. Shown for every kind of article that has them, and a
 * row appears as soon as *any* column has that field.
 *
 * The label each one gets is in REQUIREMENT_LABELS below.
 */
export const REQUIREMENT_FIELDS = [
  "requires",
  "dependencies",
  "getOneFree",
  "unlocks",
  "requiresBuy",
  "requiresBaseFunc",
  "requiresBuyBaseFunc",
];

/** Display labels for the requirement rows. Falls back to the raw key. */
export const REQUIREMENT_LABELS: { [k: string]: string } = {
  requires: "STR_RESEARCH_REQUIRED",
  dependencies: "STR_DEPENDS_ON",
  getOneFree: "STR_GIVES_ONE_FOR_FREE",
  unlocks: "STR_UNLOCKS",
  requiresBuy: "STR_RESEARCH_REQUIRED_TO_BUY",
  requiresBaseFunc: "STR_SERVICES_REQUIRED",
  requiresBuyBaseFunc: "STR_SERVICES_REQUIRED_TO_BUY",
};

/**
 * Armour resistance block. `damageModifier` is one multiplier per damage type,
 * in the order of the `damageTypes` list in Ruleset.ts, so index N is the
 * resistance to damage type N. Shown as a percentage; lower is better, since it
 * is the fraction of incoming damage that gets through.
 */
export const RESISTANCE_FIELD = "damageModifier";

/**
 * Resistances are stored as multipliers (0.75) but read as percentages (75%),
 * so they are scaled by this before display. Keeping the scale here means the
 * delta column reports percentage points rather than a confusing "+0.25".
 */
export const RESISTANCE_SCALE = 100;

/**
 * A resistance of exactly 1.0 (100%, i.e. no modifier at all) on *every* column
 * is not worth a row. Set false to always list every damage type.
 */
export const RESISTANCE_HIDE_NEUTRAL = true;

/**
 * Most guns in XPiratez hold their damage on the ammo, not on the weapon, so a
 * bare gun-vs-gun diff has an empty damage row. When a weapon takes ammo we load
 * a clip and copy these fields off it onto each firing mode. Which clip is
 * picked defaults to the first compatible one and can be changed per column in
 * the difference summary.
 */
export const AMMO_DAMAGE_FIELDS = ["damage", "damageType", "damageBonus"];
