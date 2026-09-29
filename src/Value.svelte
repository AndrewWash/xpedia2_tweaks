<script>
  import { rul } from "./Ruleset";
  import { Link, LinksList, Tr, Img  } from "./Components";
  
  export let val;
  export let obs = null;
  export let depth = 2;
  export let simple = false;
  export let nobr = 30;
  export let icon = null;
  export let key = null;
  export let capital = false;

  // A reactive block here only ever called rul.obsSprite() so it could log the
  // result; the markup below awaits the same call for real. Dropping the log
  // drops the duplicate call with it.

  /**
   * Fields whose ORDER is data, so they must never be alphabetised.
   *
   * `members` is the one that matters most: a deployment's `alienRank: N` is a
   * 0-based INDEX into this list, not a rank id, so sorting it breaks the only
   * link between the article and what actually spawns. XPiratez makes that
   * invisible too - four different zombie units all display as "Zombie", so a
   * sorted list gives the reader no way to tell which index is which.
   *
   * `mapDataSets` is the same shape of problem one level lower: tile numbers in
   * a map block are offsets into these sets concatenated in order, so reordering
   * them describes a different map.
   *
   * Everything else that reaches LinksList is a set built by backLink() in
   * ruleset parse order, which is not an order anyone can use.
   */
  const POSITIONAL_FIELDS = new Set([
    "members",
    "membersRandom",
    "mapDataSets",
    "compatibleAmmo",
    "weaponTypes",
    "allWeaponTypes",
    "itemSets",
    "data",
  ]);
</script>

{#if depth == 0}
...
{:else if val == null}
‒
{:else if obs}
  {#await rul.obsSprite(obs,val) then data}
    <img src={data} alt={val} style="max-width:320px"/>
  {/await}
{:else if ["marker", "markerCrash", "markerLand"].includes(key)}          
    {#if rul.globeMarkers}
      <Img src={rul.globeMarkers[val]} style="transform: scale(2  );"/>
    {:else}
      {val}
    {/if}    
{:else if Array.isArray(val)}
  <LinksList items={val} vertical={false} sorted={!POSITIONAL_FIELDS.has(key)} />
{:else if val instanceof Object}
  <LinksList items={val} sorted={!POSITIONAL_FIELDS.has(key)}/>
{:else if val===true || val ===false}
  <span style="color:{val?'lime':'red'}"><Tr s={val.toString()}/></span>
{:else if !isNaN(+val)}
  <em class="num">{val.toLocaleString('ru-RU', {maximumFractionDigits: 4}).replace(",",".")}</em>
{:else if rul.article(val) && !simple}
  <Link href={val} {icon}/>
{:else if rul.hasSprite(val)}
  <Img src={val} style="max-width:320px"/>
{:else}
  <Tr s={val} {simple} {nobr} {icon} {capital}/>  
{/if}