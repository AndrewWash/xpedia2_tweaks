<script>
  import { Link, divider, LinksList, Value } from "./Components";
  import { rul } from "./Ruleset";

  export let items;
  export let cols = 0;
  export let vertical = false;
  export let numberTable = false;
  export let depth = 2;
  export let sorted;
  let sorter;

  /**
   * Whether to alphabetise, when the caller has not said.
   *
   * This used to be `items.length > 9`, which is exactly backwards. Length says
   * nothing about whether a list's ORDER carries meaning, so the rule sorted the
   * long lists - where order is most likely to be load-bearing, and where it did
   * real damage to alienRaces.members - while leaving short ones in raw ruleset
   * order, which is no order at all. Callers that know the field now say so; see
   * POSITIONAL_FIELDS in Value.svelte. Anything reaching here unlabelled is a
   * set, so alphabetical is the useful answer.
   */
  if(sorted == null){
    sorted = true;
  }

  $: {
    if (items instanceof Set) {
      items = [...items];
    }
    sorter = sorted?a=>rul.sortStrings(a):a=>a;
  }
</script>

{#if items == null}
  {rul.tr("NULL")}
{:else if depth == 0}
  ...
{:else if cols}
  <div class="cols" style={`columns:${cols};`}>
    {#each items as field, i}
      <div><Link href={field} /></div>
    {/each}
  </div>
{:else if numberTable}
  <table class="number-table">
    {#each Object.keys(items).sort() as field, i}
      <tr>
        <td>
          <Link href={field} />
        </td>
        <td>
          <em><Link href={items[field]} /></em>
        </td>
      </tr>
    {/each}
  </table>
{:else if (Object.values(items) || []).some((a) => typeof a == "object")}
  {#each Object.keys(items) as subfield, j}
    <div class={j > 0 && "top-border"}>
      {#if !Array.isArray(items)}
          <Value val={subfield} depth={depth-1}/> :
      {/if}
      <div class="sublist">
        <Value val={items[subfield]} depth={depth-1}/>
      </div>
    </div>
  {/each}
{:else if items.length == null}
  <span class="links-list">
    {#each sorter(Object.keys(items)) as field, i}
    {@html divider(i, { vertical, cols })}‏‏‎<Value val={items[field]}  depth={depth-1}/>&nbsp;‎<Link href={field} />
    {/each}
  </span>
{:else if items.map}
  <span class="links-list">
    {#each sorter(items.map((i) => i?.type || i)) as item, i}
      {#if Array.isArray(item)}
        <div class="sublist">
          <LinksList items={item} depth={depth-1}/>
        </div>
      {:else}
        {@html divider(i, { vertical, cols })}<Link href={item} />
      {/if}
    {/each}
  </span>
{:else}
  {@debug items}
{/if}
