# How CENTCOM and the tech tree work, and why you can trust them

This document explains every number in the CENTCOM damage table: where it comes
from, what OXCE rule produces it, and what it deliberately does not know.

It assumes you know nothing about the calculator. It does assume you have played
some X-COM. Every mechanic described here is traced to the engine's own source
or to the mod's ruleset files — nothing in the table is a made-up weighting, and
the two places where a genuine judgement call exists are called out explicitly
and exposed as controls you can change.

**The one-sentence version:** the table answers *"how much of this soldier's
time units does it cost to put this specific enemy down, right now, with this
weapon"* — and it answers it by simulating the fight shot by shot rather than
dividing averages.

---

## Table of contents

1. [Why averages were thrown out](#1-why-averages-were-thrown-out)
2. [The damage pipeline, step by step](#2-the-damage-pipeline-step-by-step)
3. [Accuracy is not a hit chance](#3-accuracy-is-not-a-hit-chance)
4. [Sight, engagement range, and the approach cost](#4-sight-engagement-range-and-the-approach-cost)
5. [The simulation](#5-the-simulation)
6. [The Score](#6-the-score)
7. [Every column, and its tooltip](#7-every-column-and-its-tooltip)
8. [The expanded detail row](#8-the-expanded-detail-row)
9. [The controls on the left](#9-the-controls-on-the-left)
10. [Where the enemy's numbers come from](#10-where-the-enemys-numbers-come-from)
11. [What this does NOT model](#11-what-this-does-not-model)
12. [The tech tree viewer](#12-the-tech-tree-viewer)
13. [How to check any of this yourself](#13-how-to-check-any-of-this-yourself)

---

## 1. Why averages were thrown out

The obvious way to build this table is `attacks = enemy HP / average damage`.
That method is wrong, and it is wrong in ways that reverse the answer.

Two real examples that this calculator originally got backwards:

- A **Good Lookin' Rock** does 0–68 damage, mean 31. Against a 30 HP Academy
  Nurse the average says "one hit". In practice it one-shots her about half the
  time, because the damage is a roll across a wide range, and a rock that rolls
  12 does not care what the average was.
- A **Machete** ranked *above* a **Cutlass** that hits twice as hard, because
  the Machete's mean scraped over the HP line more cheaply. The Cutlass is
  obviously the better weapon and the arithmetic said otherwise.

Averages hide variance, and variance is most of what separates a reliable weapon
from a lucky one. So the table does not divide averages. It carries the full
**probability distribution** of accumulated damage forward attack by attack, and
asks "at which attack number is this enemy down four times out of five?"

Everything else in this document follows from that decision.

---

## 2. The damage pipeline, step by step

This is `BattleUnit::damage()` and `RuleDamageType` from the OXCE source,
reproduced in order. Getting any step out of order changes every number in the
table.

```
power   = weapon (or ammo) power + damageBonus(attacker's stats)
rolled  = RandomType spread applied to power              <- "primary damage"
rolled *= armour.damageModifier[damageType]               <- RESISTANCE, FIRST
armour -= rolled * ToArmorPre                             <- banked, see below
damage  = rolled - armour(side) * ArmorEffectiveness      <- THEN armour
health += damage * ToHealth                               <- To* take the
stun   += damage * ToStun                                    POST-armour damage
armour -= damage * ToArmor                                <- also banked
```

### 2.1 Three things that are commonly believed backwards

**Resistance multiplies BEFORE armour is subtracted.** A 120% resistance does
not add 20% to the final wound — it adds 20% to the roll, and then armour comes
off that. This matters enormously against armoured targets: 120% resistance
against 20 armour is far better than 100% resistance against 16 armour, even
though a naive reading makes them look similar.

Also, and this trips people up constantly: **a resistance above 100% means the
target takes MORE damage.** 120% is a weakness, not a defence. 0% is immunity.

**Every `To*` factor is taken from the damage that survived armour**, not from
the power and not from the roll. A weapon with `ToStun: 0.5` against a target
whose armour eats most of the roll transfers half of *what got through*, which
can be nearly nothing.

**Armour damage does not help the hit that caused it.** The OXCE reference text
says `ToArmorPre` is "applied to the unit's armor before armor is considered",
which reads as though it softens the same hit. The source settles it —
`BattleUnit::damage` accumulates both armour terms into a single `toArmor` total
and only applies it at the very end:

```cpp
std::get<toArmor>(args.data) += type->getArmorPreFinalDamage(damage);
if (type->ArmorEffectiveness > 0.0f) damage -= getArmor(side) * ...;
std::get<toArmor>(args.data) += type->getArmorFinalDamage(damage);
setValueMax(_currentArmor[side], -std::get<toArmor>(args.data), 0, _maxArmor[side]);
```

So the subtraction uses the armour as it stood when the hit landed, and the
**next** hit on that facing is the one that benefits. This is precisely why
attacks-to-kill has to be simulated shot by shot instead of divided out — the
target gets softer as you work on it, and each attack faces a different armour
value.

### 2.2 The damage roll (`RandomType`)

`power` is never the damage. A spread is applied first, and which spread depends
on the damage type's `RandomType`:

| RandomType | Name | Spread |
|---|---|---|
| 0 | DRT_DEFAULT | resolves per damage type; treated as STANDARD |
| 1 | DRT_UFO | 0–200% of power |
| 2 | DRT_TFTD | 50–150% |
| 3 | DRT_FLAT | exactly power, no roll |
| 4 | DRT_FIRE | a flat window independent of power (`fireDamageRange`, default 5–10) |
| 5 | DRT_NONE | always 0 |
| 6 | DRT_UFO_WITH_TWO_DICE | triangular, two dice — peaks at the middle |
| 7 | DRT_EASY | 50–200% |
| 8 | DRT_STANDARD | `100 ± damageRange`, default 0–200% |
| 9 | DRT_EXPLOSION | `100 ± explosiveDamageRange`, default 50–150% |

The widths are **read from the mod**, not hardcoded: `damageRange`,
`explosiveDamageRange` and `fireDamageRange` are top-level ruleset keys that any
mod may override. XPiratez leaves all three alone, so nothing changes for it —
but a different mod would be reported correctly without a code change.

This is why the **Damage** column shows a range and not a single number. A
DRT_STANDARD weapon with power 61 rolls 31–92 before anything else happens.

### 2.3 The armour degradation numbers, and the "1 damage did nothing" puzzle

Armour loss per hit is:

```
armour lost = round(damage_that_got_through × ToArmor)      ToArmor defaults to 0.1
```

The rounding is not cosmetic — it is the whole behaviour:

| damage through | × 0.1 | rounded | armour lost |
|---|---|---|---|
| 1 | 0.1 | 0 | **none** |
| 4 | 0.4 | 0 | **none** |
| 5 | 0.5 | 1 | 1 |
| 35 | 3.5 | 4 | 4 |

So there *appears* to be a threshold at 5 damage, but there is no threshold rule
anywhere in the engine — that is simply where a 10% cut first rounds up to 1.
It is deterministic given the damage (`RandomArmor` defaults to false), so the
variation you observe in play is the damage roll swinging, not a separate armour
roll.

Worth knowing: **incendiary, daze/stun and choking all set `ToArmor: 0.0`** and
never scratch armour at any damage. If a weapon of one of those types seems to
be doing nothing to plating, that is correct and permanent.

`ToArmorPre` defaults to 0.0, so for most damage types it contributes nothing —
but when a weapon does set it, that armour damage lands **even on a hit that
could not penetrate**. A weapon that does zero damage to a tank can still be the
right thing to fire at it, because it is opening the tank up for the next gal.

### 2.4 Integer arithmetic

The engine does this in integers throughout, and the calculator matches it. Not
a rounding nicety — it changes displayed numbers. `BattleUnit::getFiringAccuracy`
is:

```cpp
result = item->getRules()->getAccuracyMultiplier(attack)
       * item->getRules()->getAccuracySnap() / 100;
if (kneeled) result = result * getKneelBonus(mod) / 100;
...
return result * modifier / 100;
```

and `RuleStatBonus::getBonus` returns an `int`. A Boarding Gun in the hands of a
70-Firing gal is `0.65 × 70 + 35 = 80.5` → **80**, not 80.5. Floating-point
maths here would report percentages the game never shows you.

The same applies to TU costs. `tuPerAttack` is:

```
raw  = flatTime ? cost.time : (cost.time × soldier's max TU) / 100
cost = max(1, floor(raw))
```

A cost that is not flagged `flatRate` is a **percentage of the firer's own TU
bar**, truncated, and never below 1 — you cannot fire part of a shot. This is
why the same weapon costs different TU for different soldiers.

---

## 3. Accuracy is not a hit chance

This is the single most important thing in the table, and it is the thing most
tools get wrong.

### 3.1 What the engine actually does

**For a projectile, OXCE never rolls against your accuracy.** There is no
`if (random < accuracy) hit;` anywhere in the firing path. Instead,
`Projectile::applyAccuracy` uses accuracy to decide how far the *aim point*
drifts, and scales that drift by distance:

```cpp
int deviation = RNG::generate(0, 100) - (accuracy * 100);
if (deviation >= 0) deviation += 50;   // the "miss cloud"
else                deviation += 10;   // accuracy >= 109 becomes 1
deviation = std::max(1, zShift * deviation / 200);   // range ratio
target->x += RNG::generate(0, deviation) - deviation / 2;
target->y += RNG::generate(0, deviation) - deviation / 2;
target->z += RNG::generate(0, deviation / 2) / 2 - deviation / 8;
```

Two consequences fall straight out, and both are large:

1. **Every roll below your accuracy takes the `+= 10` branch.** After the
   `max(1, ...)` floor that is a deviation of one voxel — a dead-on hit, at any
   range whatsoever. So the accuracy on the firing panel is a **floor** on how
   often you connect, never an estimate of it.
2. **The remaining rolls land in a box that grows linearly with distance.**
   Close in, that box is still smaller than the enemy, so most of those rolls
   hit too. Far out it is many times the enemy's width and most of them miss.

### 3.2 The `zShift` range ratio, including the weird part

`zShift` is the distance in **voxels** (a tile is 16 voxels across, 24 tall),
computed with a deliberate asymmetry that the engine author flagged in a comment
as "The Commandment":

```cpp
if (xDist / 2 <= yDist) xyShift = xDist / 4 + yDist;   // non-uniform
else                    xyShift = (xDist + yDist) / 2; // uniform part

if (xyShift <= zDist) zShift = xyShift / 2 + zDist;
else                  zShift = xyShift + zDist / 2;
```

This is not a rounding detail. **A shot straight along an axis spreads about
half as much as the same shot on the diagonal.** At 10 tiles, an axial shot has
`zShift` 80 and a diagonal one has 141.

Because nobody gets to choose which way the enemy is standing, the calculator
**averages over the firing direction** — everything reduces by symmetry to the
first 45 degrees, and it samples the midpoints of eight equal slices. The
function is smooth across them, so eight is plenty.

OXCE has an option, `oxceUniformShootingSpread`, that replaces the non-uniform
branch with a plain average. It is a *user* option, so it is only knowable here
if a mod pins it via `fixedUserOptions`. XPiratez does not, and the engine
default is off, so the asymmetric branch is what you get.

### 3.3 Turning that into a Hit%

For each of the engine's **101 outer rolls** (`RNG::generate(0, 100)`) the
calculator computes the exact deviation, then asks: does the displaced aim point
still fall inside the enemy's silhouette?

- **Horizontally.** Both `x` and `y` are displaced, but only the component
  *across* your line of sight can cause a miss — the component *along* it just
  slides the aim point nearer or further along a ray that still passes through
  the target. That across-component has the same variance as a single axis
  whatever the firing angle, so one axis is the correct thing to test. The
  displacement is `RNG::generate(0, d) - d/2`, counted over its `d+1` discrete
  outcomes rather than integrated, because at the small deviations that matter
  most (d of 1 to 6, the close-range case) the off-by-one in `d / 2` is a large
  part of the answer.
- **Vertically.** `RNG::generate(0, d/2) / 2 - d/8` spans about a quarter of the
  horizontal spread. Units are tall, so this rarely decides anything — but at
  extreme range it does, and it is computed.

The target's silhouette comes from the ruleset, not a guess:

- **Half-width**: 5 voxels for a 1×1 unit — its LOFT is a blob inside the
  16-voxel tile, roughly 10 voxels across at the torso, not the whole tile. A
  2×2 unit is one extra tile wide, which adds 16 voxels of width and so 8 to the
  half, giving 13.
- **Half-height**: the unit's `standHeight` from the ruleset, halved, because
  the aim point sits at centre of mass. Falls back to 22 (the usual human value)
  when a unit does not state one.

The result is capped at **99%** — never 100%, because the LOFT has gaps and no
cover is modelled.

### 3.4 What this produces

For a normal 1×1 target:

```
panel Acc   1 tile  3 tiles 5 tiles 10 tiles 15 tiles 20 tiles
    20%        99%     81%     59%     40%      33%      29%
    40%        99%     90%     72%     56%      51%      47%
    60%        99%     96%     84%     72%      68%      65%
    80%        99%     99%     93%     86%      84%      83%
```

A 60% gun really lands **96%** of its shots at three tiles and **65%** at
twenty. Treating the panel figure as a flat 60% at every range under-rated every
gun in the game at exactly the ranges fights actually happen at — which is why
rifles always felt better in play than the old table suggested.

The crossover, where distance finally beats accuracy and Hit% dips below Acc, is
around **42 tiles** for a 60% weapon — past normal view distance. Within 20
tiles and up to 90% accuracy, Hit% is *never* below Acc.

### 3.5 Melee and thrown are different, and are left alone

**A melee attack really is a flat `RNG::percent(accuracy)` roll.** There is no
deviation, no geometry, no range term. So for melee the panel figure *is* the
hit probability, and the Hit% column deliberately shows the same number as Acc
(clamped to 100). This is not an oversight — it is the correct answer, and it is
why melee did not get the same boost guns did.

**Thrown attacks keep the panel figure too.** The throw arc has its own accuracy
handling, and a grenade that lands one tile off still detonates next to the
target, so neither the deviation model nor a flat probability describes it well.
Leaving it unchanged is the conservative choice, and it is flagged rather than
hidden.

### 3.6 Range falloff and the UFO Extender option

Before any of the above, accuracy takes a range penalty. Which limit applies is
the *entire* effect of the `battleUFOExtenderAccuracy` option, and the popular
summary of it is wrong in both directions — it is **not** cosmetic, and turning
it **off does not remove range falloff**:

| | snap | auto | aimed |
|---|---|---|---|
| **on** | `snapRange` (default 15) | `autoRange` (default 7) | `aimRange` (default 200) |
| **off** | `aimRange` | `aimRange` | `aimRange` |

Off means every mode is judged against the **aimed** range. For a weapon that
never states one that is 200 tiles and so no falloff in practice — but for a
weapon with a short `aimRange` it is a real penalty on every mode. 260 XPiratez
items state an `aimRange`.

The penalty itself is `dropoff × (distance − upperLimit)` subtracted from
accuracy, or `dropoff × (lowerLimit − distance)` when you are standing too
close. **`minRange` is not gated by the option at all** — standing on top of the
enemy costs you the same either way.

XPiratez pins this option **ON** through `fixedUserOptions`
(`Piratez_Globals.rul:9106`), and OXCE honours that over your own `options.cfg`.
So for this mod the ON column is the only reality, and the checkbox in the panel
is disabled and labelled as forced.

### 3.7 Shotgun pellets

Pellet scatter is its own mechanic, from `ProjectileFlyBState`. `shotgunSpread`
comes off the **ammo**, `shotgunChoke` off the **weapon**, and the two behaviours
differ:

- **behaviour 1** (what XPiratez uses on 83 items):
  `precision = (1 − spread/100) × (choke/100)`, one value for every pellet, and
  they cluster around where the *first* pellet actually hit rather than around
  the original aim point.
- **behaviour 0** (vanilla, one item in XPiratez): pellet *i* gets
  `accuracy/100 − i × 5 × spread/100`, which at the default spread of 100 is
  zero for every pellet after the first.

The defaults matter more than they look: an unset `shotgunSpread` means **full
scatter, not none**. Reading a missing value as zero would claim every pellet
lands when the engine would throw them everywhere.

The **Pellets** control lets you pick "By spread" (the calculation above), "All
hit", or "First only". It is labelled as an assumption because OXCE traces every
pellet through voxels against the target's actual model — that is a simulation
this tool cannot run, so it gives you the bracket instead of pretending.

---

## 4. Sight, engagement range, and the approach cost

This decides *where* the fight happens, and everything about range flows from it.

### 4.1 The rule

CENTCOM is a **pre-mission planning** view — "what do I bring to wreck this
enemy" — not a per-encounter calculator. So there is one **Range cutoff**
standing for the distance a fight opens at, and one rule off it:

```
APPR = max(0, cutoff - this mode's reach) x TU per tile      melee reach = 0
```

- A mode that reaches the cutoff **or further pays nothing**. You can already
  act from where the fight starts, and that is also the safer place to be.
- A shorter mode is charged for the tiles it has to close. That is TU and
  exposure both.
- **Melee reaches nothing**, so it walks the whole cutoff.

Charged **once**, before the first attack, never per attack.

At the default cutoff of 16 with Walk 4:

| weapon / mode | reach | APPR |
|---|---|---|
| RCF Carbine, snap | 18 | **–** |
| Blackmarch Pistol, snap | 15 | **4** |
| Sawed-Off, snap | 4 | **48** |
| Throwing Axes | 7 | **36** |
| any melee | 0 | **64** |

**Why 16.** Measured across all **1096** ranged attack modes in the mod with a
range above 3: the median reach is **18** and the mean is **18.6** once the
200-tile default is capped at 30. So 16 leaves most guns free and charges only
the genuinely short-ranged. Nothing in the mod states a range between 50 and
199 — a weapon either states a real one (max 49) or inherits 200 — so the cutoff
is not cutting through a continuum.

### 4.2 Sight pulls the cutoff in

You cannot start a fight further away than you can see the enemy. So when sight
is shorter than the Range box, **sight becomes the cutoff**:

```
cutoff = min(Range box, sight)
```

Applied to **every** mode, not just melee. That is what keeps it fair — see the
squad sight note in §4.5.

This is what makes darkness and camouflage rewrite the whole table. Against a
Smuggler Catgirl at night the cutoff collapses from 16 to 5, and a Cutlass goes
from 64 TU of approach to **20**.

### 4.3 Sight, ported from the engine

The local install ships `OpenXcomEx.exe` and data only — no C++ — so this came
from `MeridianOXC/OpenXcom`, branch `oxce-plus`,
`src/Savegame/BattleUnit.cpp:4593`:

```cpp
int BattleUnit::getMaxViewDistance(int baseVisibility, int nerf, int buff) const
{
    int result = baseVisibility;
    if (nerf > 0)  result = nerf;    // fixed distance nerf
    else           result += nerf;   // relative distance nerf
    if (result < 1) result = 1;      // can't go under melee distance
    result += buff;                  // relative distance buff
    if (result > baseVisibility) result = baseVisibility;  // don't overbuff
    return result;
}
```

`nerf` is the **target's** camouflage, `buff` the **viewer's** anti-camouflage
(`:4616` and `:4633`). Bases come from `:184-189`:

```cpp
_maxViewDistanceAtDark = armor.visibilityAtDark ? armor.visibilityAtDark : 9;
_maxViewDistanceAtDay  = armor.visibilityAtDay  ? armor.visibilityAtDay  : maxViewDistance;
```

XPiratez sets `maxViewDistance: 40`. A soldier sees **40 tiles by day**, **9 by
night**, unless her armour says otherwise.

Four behaviours are not obvious and all four change answers:

1. **A positive camouflage is a hard cap, not a subtraction.** `result = nerf`
   throws the base away, so `camouflageAtDark: 5` means "seen only from five
   tiles" however good your night vision is.
2. **A negative camouflage subtracts** instead. Both signs make the target
   harder to see; different mechanisms.
3. **Anti-camouflage can never exceed your own base sight.** It only claws back
   what camouflage took.
4. **The floor is 1** — "can't go under melee distance". Perfect concealment is
   still spotted next to you.

**Worked example, and the one to check the tool against.** A TOPLESS gal
(`visibilityAtDark: 13`, `antiCamouflageAtDark: 1`) against a Smuggler Catgirl
(`SMUGGLER_ARMOR_P2`, `camouflageAtDark: 5`):

```
13  your armour's night vision
 5  enemy camouflage 5 is a HARD CAP - it replaces your vision outright
 6  your anti-camouflage +1
 =  6 tiles
```

The Engagement panel shows exactly that working under the enemy's stats when you
click **why**, along with every visibility value on both armours — including the
ones that change nothing, marked "not modelled", so nothing looks silently
folded in.

**`heatVision` is NOT night vision.** Its engine binding is
`getVisibilityThroughSmoke` (`BattleUnit.cpp:6771`) — smoke penetration. 470
items carry it and none of them help you see in the dark. Same for `psiVision`
(through walls) and `personalLight` (lighting your own surroundings, which makes
nearby targets count as lit): reported, not modelled.

The mod leans on these heavily — `visibilityAtDark` 1004 uses (values 1–30),
`visibilityAtDay` 177, `camouflageAtDay` 186, `camouflageAtDark` 213,
`antiCamouflageAtDay` 257, `antiCamouflageAtDark` 251.

### 4.4 The three knobs

**Range (tiles), default 16** — the cutoff. Where a fight opens.

**Walk (TU/tile), default 4** — an engine fact, the flat-floor move cost. This
install runs `Lower move cost player only`:

```
unit.MoveCost.setBaseTimePercent 75;
```

applied to `FACTION_PLAYER` only, making it **3 TU/tile** for your units.

**Free (tiles), default 0** — tiles of closing charged as free. The argument for
it is real (nobody plays a perfect spacing game) but it is an assumption, so it
is off unless you ask for it. Setting Walk or Free to 0 turns the approach cost
off entirely.

### 4.5 Squad sight, and why the cutoff moves for everyone

From `Projectile.cpp:401`:

```cpp
int noLOSAccuracyPenalty = weapon->getRules()->getNoLOSAccuracyPenalty(_mod);
if (noLOSAccuracyPenalty != -1) {
    if (targetUnit) hasLOS = _save->getTileEngine()->visible(bu, t);
    if (!hasLOS) accuracy = accuracy * noLOSAccuracyPenalty / 100;
}
```

**The shot is never refused.** You can fire at anything a squadmate has spotted,
at full range, whether or not you can see it — you just pay an accuracy penalty.
XPiratez's global is **50%**; per-item overrides run 100 (six items, no penalty
at all), 82, 77, 75 on fourteen, 67 on six, 66, 65, and one at **0** which
cannot be fired blind at all.

So a gun is **not** range-limited by its holder's eyes, and charging only melee
for the dark would be wrong. Moving the cutoff for every mode keeps the
comparison honest — and relative ordering is what this table is for. The
**Squad sight** checkbox applies that penalty when you want to plan for it.

### 4.6 Where it is still biased, on purpose

- **Against melee.** A gun sometimes has to move too — line of sight, cover,
  into its own maximum range. None of that is modelled.
- **For melee.** You usually close on a previous turn and arrive with a full TU
  bar, and once adjacent the next enemy costs no approach at all.
- **Terrain.** Stairs, rubble, water and slopes change the real per-tile cost.
- **Squad sight positioning.** Getting a spotter into place is not free either.

---

## 5. The simulation

This is what produces the **Attacks** number, and everything downstream of it.

### 5.1 The method

Rather than dividing HP by average damage, the calculator carries a probability
distribution of *accumulated damage* forward, one attack at a time.

- The target's health pool is divided into a grid of **64 buckets**. Everything
  is tracked as "probability that accumulated damage has reached bucket *i*".
- For each attack: the damage distribution for the armour **as it currently
  stands** is convolved onto the accumulated distribution.
- A **miss is a wasted attack**, not reduced damage. The two branches are mixed
  explicitly: `next[i] = cur[i] × (1 − hitRate) + landed[i] × hitRate`.
- After the attack, armour is reduced by the expected armour loss (scaled by
  hit rate, because a miss strips nothing), and the **next** attack faces the
  new, lower armour. This is the shot-by-shot degradation from §2.1.
- The loop stops at the first attack number where the probability of the target
  being down reaches the **confidence level, 80%**.

The damage distribution itself is built to at most 201 buckets, and random `To*`
terms (`RandomStun`, `RandomWound`) are expanded over 8 samples. Those caps
exist for speed: this runs across a couple of thousand firing modes every time
you change any control, and a naive implementation was far too slow.

### 5.2 Why 80%, and what it means

"Attacks 2" does not mean "two attacks on average". It means **two attacks put
this enemy down four times out of five**.

That is a deliberate choice, and it is the honest one for a planning tool. An
average tells you what happens across a hundred fights; you are about to fight
one, and the tail is what gets a gal killed. Anchoring on the average is exactly
what made a Machete outrank a Cutlass.

### 5.3 The worked example everybody asks about

**G.O.**: 40 HP, front armour 8 (10 effective after `ArmorEffectiveness`).
**Cutlass**: power 61 → roll 31–92 → after armour **21–82**. Acc and Hit% 74%.
The table reads `Per attack 42.9` and `Attacks 2`, and people reasonably ask how
an average of 42.9 against 40 HP takes two swings.

Here is the whole arithmetic:

- One swing **lands 74%** of the time.
- When it lands it deals 21–82, uniform. To drop a 40 HP target it needs ≥40,
  which is `(82 − 40) / (82 − 21)` = **69% of hits**.
- So one swing drops it `0.74 × 0.69` ≈ **51%** of the time.
- Two swings: 55% chance both land (and two hits total at least 42, always
  fatal), plus a 38% chance exactly one lands × 69% = 26%. Total ≈ **81%**.

51% is below the 80% bar; 81% clears it. **So "2" is correct**, and it is
correct for exactly the reason averages were abandoned. No single swing ever
deals 42.9 damage — that number is a mean across attempts, with the 26% miss
chance already folded in (`51.5 × 0.74 = 42.9`).

### 5.4 The 100-attack ceiling

Past 100 attacks the weapon is not killing the target, and saying so is more use
than a number. A pistol-bash against 32 armour works out to 1026 swings and 9234
TU — both arithmetically correct and both useless, and the precision is fake
anyway, because nearly every roll of that attack fails to beat the armour at all
and the expected damage it is divided by is a rounding artefact.

---

## 6. The Score

The leftmost column, 0–100. The whole formula is one line:

```
score = 100 / (1 + tuToKill / soldier's max TU)
```

where `tuToKill = APPR + attacks × TU per attack`.

**50 means exactly one full turn** of this soldier's time units to put this
enemy down. Above 50 is faster than a turn, below is slower.

| score | meaning |
|---|---|
| 80 | a quarter of a turn |
| 67 | half a turn |
| **50** | **one full turn** |
| 33 | two turns |
| 17 | five turns |
| 0 | never gets there |

### 6.1 Why it is anchored to the soldier, not to the best weapon

Anchoring to something real rather than to the top of the list is what lets the
number answer *"is this worth using at all"*. A relative score can only ever say
which of your options is least bad — the best of a terrible set would still read
as 100. Anchored to the TU bar, a bad set reads badly, which is information.

### 6.2 What the score has in it

Only one thing: **time units to put the target down**, including the walk for
melee. There are no invented weights, no "damage points × accuracy factor", no
tuning constants. Everything that makes one weapon score above another is
already explained in sections 2 to 5.

The colour bands are just the anchor read back: green above 50 (inside a turn),
amber 25–50 (one to three turns), red below (worse than that).

---

## 7. Every column, and its tooltip

The main table, left to right. Tooltip text is reproduced verbatim.

### Score
> The verdict, 0-100. 50 means one full turn of this soldier's TU to drop this
> enemy, so above 50 is faster than a turn and 0 means it never gets there.
> Counts a miss as a wasted shot rather than as reduced damage, which is why an
> accurate weapon can outscore a cheaper inaccurate one.

See §6.

### Weapon
The item name. A weapon with several usable firing modes shows the best one on
the main row and the rest as sub-rows when you expand it. A count like `×3`
after the name is how many you own in the selected save.

### Size
> Inventory footprint, width x height - what it costs you in pack space

The product of `invWidth × invHeight`. Sorting on it answers "what can I
actually carry".

### Mode
Which firing mode this row is: Snap, Aimed, Auto, Melee or Throw. Custom mode
names from the mod's `confSnap.name` and friends are shown as the mod names
them, which is why some rows read "Release Parrot" rather than "Snap".

### Damage
The **post-armour, post-resistance** damage range, with the target's resistance
to this damage type in brackets. `21–82 (100%)` means: after resistance and
after armour, a hit deals somewhere between 21 and 82.

The resistance tooltip:
> The target's resistance to this damage type, already applied to the range
> beside it. Over 100% means it takes MORE than face value; 0% means immune.

For a multi-projectile attack a `×N` suffix appears, with `→n` showing how many
are assumed to land.

### Range
> Effective range of this mode. With range falloff on, accuracy drops by the
> weapon's dropoff per tile past it; with falloff off, the aimed range governs
> every mode instead and this number is greyed.

See §3.6.

### Acc
> The most effective mode is not always the accurate one - this is why

The figure the game's firing panel shows, computed exactly as
`BattleUnit::getFiringAccuracy` does, in integers (§2.4), including kneeling,
one-handed and no-line-of-sight modifiers and the range falloff.

**This is not a hit chance.** See §3.

### Hit%
> How often this attack actually connects, which for guns is NOT the Acc figure.
> The engine never rolls against accuracy for a shot - it uses accuracy to decide
> how far the aim point drifts, and that drift grows with range. Every roll under
> your accuracy drifts by a single voxel, a dead-on hit, so Acc is a FLOOR on how
> often you connect rather than an estimate. Close in the drift is smaller than
> the enemy and nearly everything lands; far out it is many times their width.
> Melee and thrown attacks show the same number as Acc, because melee really is a
> straight percentage roll. No cover or terrain is modelled.

See §3.

### Per attack
> Average health damage per attack ATTEMPT - after armour, and with misses
> averaged in, so it is not what a hit does. No single attack ever deals exactly
> this. That is why it can sit above the target's HP and still need two attacks:
> see the Damage range beside it and the Attacks tooltip.

Relabelled **Stun/attack** when the Goal is Capture. See §5.3 for the worked
example of why this number is not the whole story.

### APPR
> TU to walk one tile, and the tiles are (Range cutoff - this mode's reach).
> Reach the cutoff or better and it is nothing; fall short and you pay for
> closing the gap, which is TU and exposure both. Melee reaches nothing, so it
> walks the whole cutoff. Charged ONCE before the first attack, not per attack.
> 4 TU a tile is the engine default on a flat floor; this install's Lower move
> cost player only mod scales player units to 75%, so 3. Set it to 0 to turn the
> whole thing off.

`–` for anything that already reaches the cutoff, which is most guns. See §4.

### Attacks
> Whole attacks expected to take down the target 4 times out of 5, simulated
> shot by shot: misses cost a whole attack, damage is rolled from its real
> spread rather than averaged, and the armour degrades as it goes. The Score is
> built from exactly this number.

The verb changes with the Goal ("kill" / "knock out" / "take down"). See §5.

### TU to drop
> The total the Score is built from: every attack, PLUS the APPR walk for a
> melee mode. Charged once, so it is approach + attacks x cost, not the walk
> repeated per swing.

Relabelled **TU to kill** or **TU to stun** with the Goal.

### Turns
> That TU as a fraction of this soldier's bar, so below 1 it is also what she
> has left afterwards - 0.27 means a quarter of the bar spent and she can still
> move. Hover a row for the whole-turn count, which is the tactical one: you
> cannot carry TU between turns or fire part of a shot.

Two true answers are kept because they answer different questions. The fraction
tells you what you have left; the whole-turn count is the tactical reality,
since TU do not carry between turns. The whole-turn count is derived from the TU
total rather than from attacks-per-turn, so it accounts for a first turn partly
spent walking.

### The enemy view

Switching to **One weapon vs enemies** swaps the Weapon/Size columns for
**Enemy**, **Armour** (the value on the facing you selected) and **HP**.
Everything else means the same thing.

---

## 8. The expanded detail row

Clicking any row expands a per-mode breakdown with the intermediate steps, so
you can check the arithmetic of §2 by eye:

| column | meaning |
|---|---|
| **Power** | after `damageBonus` from the attacker's stats, before any roll |
| **Roll** | the `RandomType` spread applied to power — the raw damage range |
| **After armour** | the same range after resistance and after armour |
| **Bounces** | > Shots that HIT and still did nothing - the roll came in at or below the armour, so no damage got through. Misses are not counted here; that is the Acc column. Worth watching because a healthy average can hide a weapon most of whose shots bounce off. |
| **Shots** | projectiles fired per attack |
| **Land** | > Projectiles assumed to land on the target |
| **Acc**, **Hit%**, **TU**, **Per attack** | as above |
| **Armour↓** | > Armour stripped per attack: ToArmorPre off the roll plus ToArmor off what got through |
| **Attacks**, **Turns** | as above |

Below the table a line states the damage type, the effective armour after
`ArmorEffectiveness`, and that resistance is applied before armour — the three
inputs that most often surprise people.

**Bounces is the one to watch.** A weapon can show a healthy average while most
of its shots do literally nothing, because the roll came in under the armour.
That is invisible in an average and obvious in this column.

`Armour↓` lives here rather than in the main table: it is armour **destroyed**,
not a subtraction from your damage (that is already inside "After armour"), and
next to the damage columns it was consistently misread as "45 minus 5.4".

---

## 9. The controls on the left

### Campaign

Reads a real `.sav`. From it the calculator takes:

- **Research completed** and **items held**, for the availability filter.
- **Your actual soldiers**, with their real current stats, plus transformation
  bonuses and commendation bonuses on top, and the armour each is wearing.
- **Campaign difficulty**, which changes enemy numbers — see §10.2.

The **⭯** button:
> Rescan for saved games and re-read the selected one. Saves are never cached,
> so this picks up a game you just saved - no page reload needed.

You can also **drop a `.sav` anywhere on the panel** or use "Open a .sav…".

The three availability chips:

| chip | tooltip |
|---|---|
| **Off** | Every weapon in the mod |
| **In stores** | Only weapons held at a base or already loaded on a craft in the chosen save |
| **Owned or can get** | Held, plus anything this campaign's research lets you buy or manufacture. Base facilities are not checked, so a build you have no workshop for still counts. |

Default is **Off** with no save loaded and **Owned or can get** once one is —
and a chip you click yourself sticks.

### Soldier

Either the crew from the save (stats read-only, with a "copy to manual" button)
or profiles you type in. Shown stats **include the armour's bonuses**, and the
`+10`-style modifiers to the left of each box show what the armour contributes.
Armour is limited to what that soldier type can actually wear, and to what the
availability filter allows.

### Engagement

- **Day / Night** — swings a soldier's sight from 40 tiles to 9 (§4.3).
- **Spots this enemy at N** — shown under the enemy's stats, with the full
  arithmetic behind a **why** toggle, and every visibility value on both
  armours listed including the ones that do not apply.
- **Range** — the cutoff a fight opens at, and what every approach is measured
  against (§4.1). Sight overrides it when sight is shorter.
- **Walk (TU/tile)** and **Free (tiles)** — see §4.4.
- **Squad sight** — fire at something only a squadmate can see, at the weapon's
  `noLOSAccuracyPenalty` (§4.5).
- **Hitting** — which facing you hit: Front, Side, Rear or Under. Armour differs
  per facing and it is usually a large difference.
- **Kneeling**, **One-handed**, **No line of sight** — the three accuracy
  modifiers, each read from the item first and the mod global second.
- **Range falloff** — the UFO Extender option (§3.6), disabled and labelled when
  the mod forces it.
- **Goal**:
  > Take down: health runs out OR stun exceeds the health that is left - the two
  > add, which is why a rifle with ToStun can drop a target that the health
  > damage alone would not. Kill outright: health damage only. Capture: stun
  > only, for taking one alive.
- **Pellets**:
  > Shotguns only. Whether scattered pellets are assumed to land. OXCE traces
  > each pellet through voxels against the target's model, so this is an
  > assumption rather than a calculation.

### Mission

Filters the enemy list to what can actually appear in a chosen mission, and
shows a breakdown in the right panel:

> Troop rows for this deployment: how many, and how many start outside the craft
> or building

> Share of this group placed away from the craft or building, rather than inside
> it

### Filters

Weapon name search (comma-separate several to line them up side by side),
weapon-type dropdown reading the **mod's own** category tags, damage-type
dropdown, hands filter, and clickable resistance chips on the enemy:

> Click a resistance to show only weapons of that type

---

## 10. Where the enemy's numbers come from

### 10.1 Armour is per facing

Front, Side, Rear and Under are usually very different. A Govt Agent has 25
front and 5 rear. The **Hitting** control picks which one the whole table is
computed against, and it is one of the biggest levers in the tool.

`ArmorEffectiveness` from the weapon's damage type scales how much of that
armour actually applies — a weapon with `ArmorEffectiveness: 0.75` faces 75% of
the stated value. The detail row states the effective number.

### 10.2 Campaign difficulty changes the enemy

From `Mod.cpp`'s own table, applied to **hostile units only** (`BattleUnit`'s
constructor: `if (_originalFaction == FACTION_HOSTILE) adjustStats(...)`):

| difficulty | aim × | armour × | stat growth |
|---|---|---|---|
| 0 Beginner | 0.5 | **0.5** | none |
| 1 Experienced | 1.0 | 1.0 | +1% |
| 2 Veteran | 1.0 | 1.0 | +2% |
| 3 Genius | 1.0 | 1.0 | +3% |
| 4 Superhuman | 1.0 | 1.0 | +4% |

Small at most difficulties, but real, and free to apply once a save tells us
which one you are playing. **With no save loaded the adjustment is neutral**
(×1, no growth) — *not* Beginner. Defaulting to 0 would quietly halve every
enemy's armour, which is a bug this calculator shipped once and now has five
test suites guarding against.

### 10.3 A unit drops when health damage + stun damage ≥ starting health

This is one pool, not two. It is why the **Take down** goal can succeed where
health damage alone never would, and it is the answer to the classic "how did a
35 HP Govt Agent die to 27 damage?" — the random stun component crossed the
remaining health. With `ToStun: 0.5` and a random stun roll, a 27-damage hit
takes down a 35 HP target about two times in five. Which is exactly the "it died
twice and then it didn't" experience.

### 10.4 Energy shields

`ARMOR_ENERGY_SHIELD_*` tags are **reported but not modelled**. If a target has
one the panel says so with a warning. Treat those rows as optimistic.

---

## 11. What this does NOT model

Stated plainly, because a tool that hides its limits is worse than one that has
them.

**Not modelled at all:**

- **Cover and intervening terrain.** No walls, no crates, no partial exposure.
  This is the biggest single gap and it always flatters ranged weapons.
- **The target's real LOFT voxel model.** Hit% uses a rectangular silhouette
  approximation of it (§3.3), not a voxel trace.
- **Reaction fire.** In particular, the shots you eat while closing.
- **Kneeling targets**, and the fact that a shot deviating past a unit can still
  clip it on the way.
- **Energy and stamina.** Movement costs energy too; running out is real and
  invisible here.
- **Ammo capacity and reload cost.** A weapon that drops the target in two shots
  but holds one is not distinguished from one that holds twelve.
- **Weight and encumbrance.**
- **Energy shields** (reported, §10.4).
- **Base facilities** in the "Owned or can get" filter — a manufacture you have
  no workshop for still counts as obtainable.
- **Whether you can reach the target at all** — flying enemies, water, walls.
- **Morale, panic, and everything psionic.**

**Modelled as an assumption you can change:**

- Shotgun pellet landing (the **Pellets** control).
- The approach cost (**Range**, **Walk** and **Free**, §4.4).

**Modelled as a fixed judgement call:**

- The **80% confidence** level behind Attacks (§5.2).

---

## 12. The tech tree viewer

A separate tab (**TECH**), built on the same save the damage table uses.

### 12.1 Why it is columns and not a graph

4612 research topics. A node-and-edge picture of that is a hairball, and it
answers a question nobody asks. Every existing viewer — the in-game one and
XPedia's own article pages — shares one defect: **clicking a prerequisite
navigates you away from what you were looking at**, so you cannot compare
diverging paths or back up to the parent.

So this is a **Miller-column browser**. Each click opens a column to the right
and every ancestor stays on screen; clicking a row in an earlier column
truncates back to it and branches from there. The trail you walked is always
visible and always re-branchable. The **▤** button opens the full XPedia article
in a popup over the top rather than navigating, for the same reason.

### 12.2 The gate that actually decides the list

Judging availability on `dependencies` alone gave **1812** "available now"
against a real save — a wall, not a list. The reason:

- **1754** of those carry `needItem`, which in OXCE means you must be holding an
  item with the **same id as the topic**.
- The save's stores held only **24** of them.

With the item gate applied the honest answer is **77**. That is the difference
between a usable screen and an unusable one, so `needItem` is modelled rather
than footnoted, and it gets its own status — **needs an item** is not the same
as *blocked*, because the research is already clear and you just have to go find
one.

Availability is therefore:

```
done        discovered in the save
inProgress  in the save's own project list
blocked     a dependency is unmet, and nothing discovered force-unlocks it
needsItem   research is clear, but you do not hold the item it wants
available   everything above is satisfied
```

`dependencies` and `unlocks` are **different mechanisms**. `dependencies` is the
normal gate — all must be discovered. `unlocks` is a bypass: researching the
lister makes the listed topic available whether or not its own dependencies are
met. A topic reachable only that way looks permanently blocked if you read
`dependencies` alone, so both are consulted.

### 12.3 Days, which the save makes exact

Each in-progress project in the save carries the cost this campaign **actually
rolled** — not the ruleset's base, which is only ever an estimate:

```yaml
research:
  - project: STR_CAMOUFLAGE
    assigned: 0
    spent: 2
    cost: 21
```

So remaining work is exact for anything started, and the ruleset figure is used
only for what you have not begun. Brainers = free `scientists` across all bases
plus everyone already `assigned`. Days = remaining / brainers, rounded up. With
no brainers it shows **—** rather than dividing by zero.

### 12.4 The Impact sort

The to-do list sorts five ways; four are obvious. **Impact** is:

```
value = topics that become available the moment this is done
      + things it lets you build, buy, or receive
score = value / days
```

"Topics unblocked" is a fact, not a weighting: a blocked topic whose **only**
unmet dependency is X becomes available when X lands. One pass over the ruleset
counts those per topic, so sorting stays cheap however long the list gets.

It is a ratio, so there is nothing to tune and nothing to argue with — a cheap
topic that frees six others beats an expensive one that frees two, and both beat
a dead end.

### 12.5 What it refuses to guess at

Availability is not a clean DAG and this mod uses every awkward corner. These
are surfaced on the topic in words rather than folded into the status:

- `requiresBaseFunc` (398 on research, 1524 on manufacture) — gated on
  facilities, not research at all
- `disables` (163) — researching one thing can *remove* another
- `getOneFreeProtected` (102) — conditional free grants
- one-shot topics

A "can I research this" that ignored those would be confidently wrong, which is
worse than not answering.

---

## 13. How to check any of this yourself

None of the above asks you to take anything on faith.

- **The detail row** shows Power → Roll → After armour, so you can follow §2
  step by step for any weapon against any enemy.
- **Every tooltip** in the table names the mechanic it comes from.
- **The mod is readable.** Everything about a weapon is in
  `user/mods/Piratez/Ruleset/*.rul`. Search for the item's `type:` and compare.
- **The calculator is covered by 795 automated checks across 26 suites**, all
  passing. They are not smoke tests — they encode the specific things that were
  once wrong: that resistance multiplies before armour, that integer truncation
  matches the engine, that a Cutlass outranks a Machete, that an Ax outranks a
  Good Lookin' Rock, that Beginner difficulty does not get applied when no save
  is loaded, that a miss costs a whole attack, that the approach is charged
  exactly once, that turning it off reproduces the old numbers exactly, that a
  positive camouflage caps sight outright, and that a research dependency cycle
  terminates instead of hanging.
- **Cross-check against the game.** The single best test is the one that found
  the accuracy bug in the first place: play, watch what actually happens, and if
  the table disagrees with the battlescape, the table is wrong. Every major
  correction in this tool's history came from someone noticing exactly that.

---

## Change history

- **2026-09-13 (later)** — Approach reworked onto a single Range cutoff (§4.1):
  a mode reaching it pays nothing, a shorter one pays to close, melee walks the
  lot. Sight ported from the engine and used to pull the cutoff in (§4.2-4.3).
  Day/Night toggle. Squad sight confirmed to exist and the checkbox renamed for
  it (§4.5). "Exclude demo" filter for the seven wall-breaking `STR_CRUSH`
  modes, which are ranged-with-range-1 and were ranking far above their worth.
  Fixed a latent bug where `kneelBonusGlobal` / `oneHandedPenaltyGlobal` /
  `noLOSAccuracyPenaltyGlobal` were looked up under their bare item-field names
  and so always fell back to hardcoded defaults.

- **2026-09-13** — Melee approach cost (§4). Table cleanup: Resist folded into
  Damage, Armour↓ moved to the detail row, APPR added, Per attack's tooltip
  corrected to say it includes misses.
- **2026-09-12** — Hit% replaced accuracy-as-hit-probability (§3). Campaign
  difficulty (§10.2). Bounces tooltip. Availability defaults.
- Earlier — distribution-based simulation replacing averages (§1, §5), armour
  degradation (§2.3), integer arithmetic throughout (§2.4), mode-level filtering,
  save-driven weapons/armour/soldiers, mission→enemy resolution.
