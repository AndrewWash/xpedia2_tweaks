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
  // The corpse an armour leaves is an item id, never something you weigh up
  // when choosing between two of them. Delete either line to get it back.
  "corpseBattle",
  "corpseGeo",
  // A backlink listing every map the thing can turn up on. Ruleset.ts writes it
  // onto items, units and enviroEffects via crosslink().
  "terrains",
  // A backlink map of every recipe this item is an ingredient in. Flattens to
  // one row per recipe (componentOf.STR_DISASSEMBLY_LASER_PISTOL and friends),
  // which says nothing about the item itself.
  "componentOf",
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
  "psiVision", "heatVision", "throwRange",
  "visibilityAtDark", "visibilityAtDay",
  // SPOT: tiles of enemy camouflage this unit cancels. Always positive in the
  // ruleset, and more is plainly better.
  "antiCamouflageAtDay", "antiCamouflageAtDark",
];

/** Fields where a smaller number is the better one. Same rules as above. */
export const LOWER_BETTER = [
  "costBuy", "costRent", "weight", "size", "tuUse", "tuAimed", "tuSnap",
  "tuAuto", "tuMelee", "tuThrow", "buildCost", "buildTime", "monthlyCost",
  "monthlyMaintenance", "monthlySalary", "time", "cost", "space",
  "transferTime", "recoveryTime", "powerRangeReduction", "powerRangeThreshold",
  "dropoff", "invWidth", "invHeight", "oneHandedPenalty", "explosionSpeed",
  "refuelRate",
  // Within one camouflage mode a lower number is stealthier: -23 conceals better
  // than -12, and "seen at 12 tiles" beats "seen at 15". Across modes the row is
  // left unranked - see SIGN_MODE_FIELDS.
  "camouflageAtDay", "camouflageAtDark",
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
  "getOneFreeProtected",
  "unlocks",
  "unlocksMissions",
  "disables",
  "unlockedResearch",
  "researchList",
  "interruptResearch",
  "requiredCommendations",
  "requiredPreviousTransformations",
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
  // gating - what you must have done first
  "requires",
  "dependencies",
  "requiresBuy",
  "requiresBaseFunc",
  "requiresBuyBaseFunc",
  "requiredCommendations",
  "requiredPreviousTransformations",
  // consequences - what having it opens up
  "getOneFree",
  "getOneFreeProtected",
  "unlocks",
  "unlocksMissions",
  "unlockedResearch",
  "researchList",
  "interruptResearch",
  "disables",
];

/**
 * Single-target links to follow when an entry has no prerequisites of its own.
 *
 * Each field here must hold exactly ONE id. That restriction is the whole point:
 * following a fan-out backlink such as `item.manufacture` pulls in every project
 * that happens to output the item - lootboxes, casino coupons - and would
 * cheerfully report a laser rifle as requiring STR_GAMBLING.
 *
 * `armor.storeItem` is 1:1 - it is the item you actually wear - so the research
 * gating that item is exactly the research gating the armour. Without this, the
 * 496 wearable armours show no research at all: the armour record carries none
 * (only 29 of 969 have `requires`) and most have no same-id research entry
 * either. It all lives on the store item.
 *
 * Rows found through a link are marked with ↗ so a linked item's prerequisite is
 * never mistaken for the article's own. The entry's own value always wins; a
 * link is only consulted when the entry and its same-id siblings have nothing.
 */
export const REQUIREMENT_VIA_FIELDS = ["storeItem"];

/**
 * Longer routes from an entry to the thing that actually carries its research,
 * for armours that have no `storeItem` because you do not wear them.
 *
 * A creature's armour is the Parrot case. `PARROT_ARMOR` has no storeItem, no
 * requires, and its pedia article declares none either, so every link above
 * dead-ends and the page shows no prerequisites at all - while the research is
 * sitting one hop further on:
 *
 *   armors.PARROT_ARMOR .users                = [STR_PARROT_PIR]
 *   units.STR_PARROT_PIR .civilianRecoveryType = STR_PARROT
 *   items.STR_PARROT   -> manufacture.STR_PARROT.requires = [STR_ANIMAL_TAMING]
 *
 * Robo-Parrot only works today by luck: its ufopaedia entry happens to state a
 * `requires` where the Parrot's does not.
 *
 * Each step names a field holding an id. The 1:1 rule from REQUIREMENT_VIA_FIELDS
 * still applies and is enforced per step in followChain: a step yielding more
 * than one id is abandoned rather than guessed at, so an armour worn by three
 * different units contributes nothing instead of attributing one unit's tech to
 * all of them. `users` and `spawnedBy` are lists that are almost always single.
 *
 * Ordered: civilianRecoveryType is the tighter signal, so it is tried first.
 */
export const REQUIREMENT_VIA_CHAINS = [
  ["users", "civilianRecoveryType"],
  ["users", "spawnedBy"],
];

/**
 * Also read requirements off the pedia Article object, `rul.article(id)`.
 *
 * Articles are a separate collection from items/armors/research and are not in
 * KINDS, because they carry no stats to diff - but each one has its own
 * `requires`, and that is the field behind the "Research required:" line the
 * article page prints. For a lot of entries it is the only place the information
 * lives: 338 of 969 armour articles have one, where only 29 armour *records* do.
 *
 * Self-referential values (requires == the article's own id) are ignored, which
 * is exactly what the article page does with them.
 */
export const REQUIREMENTS_FROM_ARTICLE = true;

/** Display labels for the requirement rows. Falls back to the raw key. */
export const REQUIREMENT_LABELS: { [k: string]: string } = {
  requires: "STR_RESEARCH_REQUIRED",
  dependencies: "STR_DEPENDS_ON",
  getOneFree: "STR_GIVES_ONE_FOR_FREE",
  getOneFreeProtected: "STR_GIVES_ONE_FOR_FREE",
  unlocks: "STR_UNLOCKS",
  requiresBuy: "STR_RESEARCH_REQUIRED_TO_BUY",
  requiresBaseFunc: "STR_SERVICES_REQUIRED",
  requiresBuyBaseFunc: "STR_SERVICES_REQUIRED_TO_BUY",
  disables: "STR_DISABLES",
};

/**
 * Fields where the SIGN of the number selects a different mode, so two values of
 * opposite sign are not measuring the same thing and must not be ranked against
 * each other.
 *
 * camouflageAtDay / camouflageAtDark are the case this exists for. OXCE's own
 * tooltip:
 *
 *   <= 0  relative "CAMO"  - seen from |v| tiles nearer than usual (0 = no camo)
 *    > 0  absolute "INVIS" - seen from exactly v tiles, whatever the usual is
 *
 * Within either mode a lower number is stealthier, which is why camouflageAt*
 * sits in LOWER_BETTER. Across modes there is no answer: "23 tiles nearer than
 * usual" versus "always seen at 15 tiles" depends entirely on what the spotter's
 * usual range is, and that belongs to the unit doing the looking, not to either
 * armour being compared. A row mixing signs therefore shows both numbers and no
 * verdict, rather than a confident wrong one.
 *
 * (An earlier version of this file tried to normalise both modes onto a single
 * "tiles you are visible from" scale by subtracting from maxViewDistance. That
 * produced numbers like 39 for camouflageAtDark, implying you are spotted from
 * 39 tiles away in the dark. The baseline is not a constant and it is not 40 at
 * night, so the scale was fiction. Hence this narrower, honest approach.)
 */
export const SIGN_MODE_FIELDS = ["camouflageAtDay", "camouflageAtDark"];

/**
 * Numeric fields that are really enumerations, mapped to the language-key prefix
 * that names each value.
 *
 * `experienceTrainingMode: 13` is not the number thirteen, it is "train
 * reactions and melee". The labels already ship in xpedia's own language file as
 * experienceTrainingMode0 … experienceTrainingMode32, which is how the article
 * page renders it; this just points the comparison at the same strings.
 *
 * A field listed here shows its label instead of the raw number and gets no
 * delta and no better/worse colouring - the arithmetic difference between two
 * enum ids is meaningless, and "+7 (+54%)" on a training mode is nonsense.
 *
 * To add one: find the prefix in mods/xpedia/Language/en-US.yml, where the keys
 * are <prefix><number>, and put the ruleset field name on the left. If a value
 * has no matching string the raw number is shown, so a partial map is safe.
 */
export const ENUM_FIELDS: { [field: string]: string } = {
  experienceTrainingMode: "experienceTrainingMode",
  // damageAlter.RandomType - the damage spread. Labels are RandomType_0 … _7.
  RandomType: "RandomType_",
  // "Item type": 1 is a firearm, 2 ammo, 3 melee, and so on.
  battleType: "battleType",
  // Craft weapon hardpoint class: light, heavy, missile, bomb …
  weaponType: "weaponType",
  // Containment needed to hold a live prisoner.
  prisonType: "prisonType",
};

/**
 * Per-value label overrides for ENUM_FIELDS, used when the mod's own string is
 * missing or wrong. Keyed by field, then by the numeric value.
 *
 * Only battleType needs this today, and only because of a typo upstream:
 * mods/xpedia/Language/en-US.yml declares `battleType10` twice (lines 2148 and
 * 2149). YAML keeps the last one, so "Electro-flare" is silently destroyed and
 * `battleType11` never gets written at all - which left 312 corpse items showing
 * a bare "11". The two names below come from the engine's own internalBattleTypes
 * table (BT_FLARE, BT_CORPSE), not from guesswork.
 *
 * Fixing those two lines in the language file would make this entry redundant.
 * It is kept here instead so the mod's data is left alone.
 */
export const ENUM_VALUE_LABELS: { [field: string]: { [value: string]: string } } = {
  battleType: {
    10: "Electro-flare",
    11: "Corpse",
  },
};

/**
 * Fields holding a damage type as a number.
 *
 * These are not <prefix><number> lang keys like ENUM_FIELDS - the number indexes
 * the `damageTypes` table in Ruleset.ts, which yields a STR_DAMAGE_* key that the
 * mod then names. So "6" becomes STR_DAMAGE_STUN becomes whatever XPiratez calls
 * it. Same resolution the attack table already uses, just applied to the plain
 * stat rows so the two agree.
 *
 * A value that is already a name is left alone, and an index with no entry in
 * the table falls back to the raw number.
 */
export const DAMAGE_TYPE_FIELDS = [
  "damageType",
  "damageTypes",
  "meleeType",
  "ResistType",
];

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
export const AMMO_DAMAGE_FIELDS = [
  "damage",
  "damageType",
  "damageBonus",
  // Shotgun spread lives on the shell, not the gun: the Police Shotgun sets no
  // shotgunPellets at all while its shells are 18 power x 7 pellets. Leaving
  // this out made every ammo-fed shotgun report a seventh of its real damage.
  "pellets",
];

/**
 * How the flat stat list is grouped and ordered.
 *
 * Before this existed the stats were one long list sorted by "biggest relative
 * difference first", which answered "what differs most" but scattered related
 * fields all over - ToTile at the top and FixRadius forty rows below it, and the
 * per-mode accuracy/TU numbers stranded at the bottom, far from the attack
 * tables that restate them.
 *
 * Now every stat row lands in the FIRST section below whose patterns match it,
 * so section order here is priority order. A section with no visible rows is not
 * drawn at all, which is why this list can cover weapons, armour, craft and
 * facilities at once - a given comparison only lights up the handful that apply.
 *
 * Patterns are matched against the full flattened key ("damageAlter.ToTile") and
 * "*" is a wildcard, so "damageAlter.*" takes the whole family and "accuracy*"
 * takes accuracySnap, accuracyAimed and friends. Within a section, rows come out
 * in the order their pattern is listed here - that is what puts ToTile next to
 * FixRadius - and rows caught by the same wildcard fall back to alphabetical.
 *
 * To move a row: find the pattern catching it and move it, or add its exact name
 * to the section you want (exact names should go before the wildcards that would
 * otherwise swallow them). To hide it entirely use SKIP_FIELDS instead.
 */
export const STAT_SECTIONS: {
  label: string;
  icon: string;
  fields: string[];
}[] = [
  {
    // What the thing *is*. Short, and first, because it frames everything below.
    label: "Type",
    icon: "🏷",
    fields: ["battleType", "internalBattleType", "weaponType", "prisonType"],
  },
  {
    // Sits directly under the per-attack ⚔ tables. Those already break damage
    // down by firing mode; these are the weapon-wide numbers behind them.
    label: "Damage",
    icon: "💥",
    fields: [
      "power",
      "meleePower",
      "damageType",
      "meleeType",
      "damageTypes",
      "autoShots",
      "shotgunPellets",
      "shotgun*",
      "clipSize",
      "tuLoad",
      "compatibleAmmo",
      "compatibleWeapons",
      "damageBonus.*",
      "meleeBonus.*",
    ],
  },
  {
    // The fields the user sees restated at the bottom of a weapon article -
    // pulled up here so they sit with the attack tables rather than after them.
    label: "Accuracy & TU cost",
    icon: "🎯",
    fields: [
      // Listed in firing-mode order so this reads the same way as the ⚔ tables
      // above it, rather than alphabetically.
      "accuracySnap",
      "accuracyAimed",
      "accuracyAuto",
      "accuracyMelee",
      "accuracyThrow",
      "accuracyUse",
      "accuracyCloseQuarters",
      "accuracy*",
      "tuSnap",
      "tuAimed",
      "tuAuto",
      "tuMelee",
      "tuThrow",
      "tuUse",
      "tu*",
      "costSnap.time",
      "costSnap.energy",
      "costAimed.time",
      "costAimed.energy",
      "costAuto.time",
      "costAuto.energy",
      "costMelee.time",
      "costMelee.energy",
      "costThrow.time",
      "costThrow.energy",
      "costUse.time",
      "costUse.energy",
      "cost*.time",
      "cost*.energy",
      "flat*",
      "flatRate",
      "accuracyMultiplier.*",
      "meleeMultiplier.*",
      "throwMultiplier.*",
      "kneelBonus",
      "oneHandedPenalty",
      "noLOSAccuracyPenalty",
      "experienceTrainingMode",
    ],
  },
  {
    label: "Range",
    icon: "📏",
    fields: [
      "maxRange",
      "aimRange",
      "snapRange",
      "autoRange",
      "throwRange",
      "*Range",
      "dropoff",
      "powerRangeThreshold",
      "powerRangeReduction",
      "bulletSpeed",
      "explosionSpeed",
      "sprayWaypoints",
    ],
  },
  {
    // ToTile and FixRadius belong side by side: one says how hard the hit chews
    // terrain, the other says how wide. Order below runs roughly "what it does
    // to a unit" -> "what it does to the map" -> flags.
    label: "Damage effects",
    icon: "🧪",
    fields: [
      "damageAlter.RandomType",
      "damageAlter.ArmorEffectiveness",
      "damageAlter.ToArmorPre",
      "damageAlter.ToArmor",
      "damageAlter.ToHealth",
      "damageAlter.ToStun",
      "damageAlter.ToWound",
      "damageAlter.RandomWound",
      "damageAlter.ToMorale",
      "damageAlter.ToEnergy",
      "damageAlter.ToTime",
      "damageAlter.ToMana",
      "damageAlter.ToItem",
      "damageAlter.ToTile",
      "damageAlter.FixRadius",
      "damageAlter.FireThreshold",
      "damageAlter.SmokeThreshold",
      "damageAlter.*",
      "meleeAlter.*",
    ],
  },
  {
    label: "Carrying",
    icon: "🎒",
    fields: [
      "weight",
      "size",
      "invSize",
      "invWidth",
      "invHeight",
      "twoHanded",
      "blockBothHands",
      "fixedWeapon",
      "builtIn",
      "isConsumable",
      "supportedInventorySections",
      "allowInv",
    ],
  },
  {
    label: "Protection",
    icon: "🛡",
    fields: [
      "frontArmor",
      "sideArmor",
      "rearArmor",
      "underArmor",
      "armor",
      "armor.*",
      "psiDefence.*",
      "meleeDodge",
      "meleeDodge.*",
      "meleeDodge*",
      "loftempsSet",
      "overKill",
      "*Immune",
      "shieldCapacity",
      "shieldRecharge",
      "shieldBleedThrough",
    ],
  },
  {
    label: "Unit stats",
    icon: "📊",
    fields: ["stats.*", "tags.*"],
  },
  {
    label: "Vision & stealth",
    icon: "👁",
    fields: [
      "visibilityAtDay",
      "visibilityAtDark",
      "camouflageAtDay",
      "camouflageAtDark",
      "antiCamouflageAtDay",
      "antiCamouflageAtDark",
      "heatVision",
      "psiVision",
      "personalLight",
      "*Camouflage*",
      "*Vision*",
    ],
  },
  {
    label: "Movement",
    icon: "🏃",
    fields: [
      "movementType",
      "forcedTorso",
      "moveCost.*",
      "turnCost",
      "turnBeforeFirstStep",
      "allowsMoving",
      "allowsRunning",
      "allowsKneeling",
      "allowsStrafing",
      "allowedIn",
      "forbiddenIn",
      "startingConditions",
    ],
  },
  {
    label: "Craft performance",
    icon: "🚀",
    fields: [
      "speedMax",
      "accel",
      "damageMax",
      "fuelMax",
      "refuelRate",
      "refuelItem",
      "repairRate",
      "maxAltitude",
      "spacecraft",
      "allowLanding",
      "hitBonus",
      "avoidBonus",
      "soldiers",
      "vehicles",
      "pilots",
      "weapons",
      "maxLargeUnits",
      "weaponTypes",
      "weaponStrings",
      "allWeaponTypes",
      "fixedWeapons",
      "useAllStartTiles",
    ],
  },
  {
    label: "Base facility",
    icon: "🏗",
    fields: [
      "buildCost",
      "buildTime",
      "monthlyCost",
      "refundValue",
      "removalTime",
      "maxAllowedPerBase",
      "canBeBuiltOver",
      "buildOverFacilities",
      "leavesBehindOnSell",
      "destroyedFacility",
      "provideBaseFunc",
      "storage",
      "storageTiles",
      "workshops",
      "labs",
      "psiLabs",
      "trainingRooms",
      "personnel",
      "aliens",
      "prisonType",
      "defense",
      "hitRatio",
      "missileAttraction",
      "mapName",
      "mind",
      "mindPower",
      "manaRecoveryPerDay",
      "*Recovery",
      "sickBay*",
    ],
  },
  {
    label: "Detection",
    icon: "📡",
    fields: ["radarRange", "radarChance", "sightRange", "hyper", "undetectable", "mind"],
  },
  {
    label: "Cost & recovery",
    icon: "💰",
    fields: [
      "costBuy",
      "costSell",
      "costRent",
      "costUnprime",
      "monthlySalary",
      "monthlyMaintenance",
      "transferTime",
      "recoveryTime",
      "recover",
      "recoveryPoints",
      "loot",
      "attraction",
      "score",
      "cost",
      "time",
      "requiredItems.*",
      "producedItems.*",
    ],
  },
  {
    // Pointers at other articles rather than numbers about this one.
    label: "Related entries",
    icon: "🔗",
    fields: [
      "categories",
      "commendations",
      "armors",
      "users",
      "units",
      "ufos",
      "manufacture",
      "manufacture.*",
      "spawnedBy",
      "spawnedBy.*",
      "heldBy",
      "heldBy.*",
      "storeItem",
      "builtInWeapons",
      "specialWeapon",
      "selfDestructItem",
      "liveAlien",
      "zombieUnit",
      "spawnUnit",
    ],
  },
];

/** Section for anything no STAT_SECTIONS entry claims. Always last. */
export const STAT_SECTION_OTHER = { label: "Other", icon: "☰" };
