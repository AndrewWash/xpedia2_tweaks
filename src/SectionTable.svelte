<script>
  "use strict";
  import {
    Link,
    LinksPage,
    Value,
    LinksList,
    tr,
    Tr,
    invisible,
    divider,
    rul,
  } from "./Components";
  import { onMount } from "svelte";
  import PaginatedList from "./PaginatedList.svelte";
  import { allFieldValuesOf } from "./util";

  /**@type {any[]}*/ export let entries;
  /**@type {any[]}*/ export let fields;
  /**@type {any[]}*/ export let extraFields = [];
  /**@type {{[key:string]:any[]}}*/ export let filters = {};
  /**@type {any[]}*/ let shownFields;

  export let aId;
  let aIdLoaded;

  let filtersSelected = {};
  let sorted;
  let sortField;
  let filterId = "";
  let sortDescending = false;

  /**
   * Rows ticked for comparison. A section table is where the question "which of
   * these thirty items is best" actually starts, so picking two here and hitting
   * Compare is the shortest path to an answer. Writing the hash is enough - App
   * picks it up through onhashchange.
   */
  const MAX_COMPARE = 4;
  let compareSel = [];

  function toggleCompare(id) {
    if (compareSel.includes(id)) compareSel = compareSel.filter((c) => c != id);
    else if (compareSel.length < MAX_COMPARE) compareSel = [...compareSel, id];
  }

  function goCompareSelected() {
    let ids = [...compareSel];
    while (ids.length < 2) ids.push("");
    window.location.hash = "##COMPARE::" + ids.join("::");
  }

  onMount(() => {});

  function sortBy(field) {
    if (field) {
      if (field != sortField) {
        sortField = field;
        sortDescending = field == "id" ? false : true;
      } else {
        sortDescending = !sortDescending;
      }
    }
    if (shownFields.includes(field)) {
      resort();
    }
  }

  function resort() {
    sorted = [...entries];
    for (let k in filtersSelected) {
      if (filtersSelected[k] != null)
        sorted = sorted.filter((a) => {
          if (filtersSelected[k] == "any") return true;
          let v = a.sortField(k, filtersSelected[k]);
          return (
            v === true ||
            v == filtersSelected[k] ||
            (Array.isArray(v) && v.includes(filtersSelected[k]))
          );
        });
    }
    if (filterId?.length > 0) {
      sorted = sorted.filter((a) =>
        a.sortField("id").toLowerCase().match(filterId)
      );
    }

    let nullValue = sortDescending ? Number.MIN_VALUE : Number.MAX_VALUE;

    sorted = sorted.sort((a, b) =>
      (a.sortField(sortField) ?? nullValue) >
        (b.sortField(sortField) ?? nullValue) ==
      sortDescending
        ? -1
        : 1
    );
  }

  function toggleField(field) {
    if (shownFields.includes(field)) {
      shownFields.splice(shownFields.indexOf(field), 1);
    } else {
      shownFields = [...shownFields, field];
    }
    shownFields = [...shownFields];
  }

  function toggleFilter(field) {
    if (field == filter) {
      filter = null;
    } else {
      filter = field;
    }
    resort();
  }

  function moveField(field, after) {
    let fi = shownFields.indexOf(field);
    if (fi == -1) return;
    shownFields.splice(fi, 1);
    let ai = shownFields.indexOf(after);
    if (ai == fi) ai++;
    if (ai == -1) ai = 0;
    shownFields.splice(ai, 0, field);
    shownFields = [...shownFields];
  }

  $: {
    extraFields = extraFields.filter((item) => !fields.includes(item));
    sorted = sorted || [...entries];
    if (aIdLoaded == null || aIdLoaded != aId) loadFields();
    localStorage["xpediaColumnOrder" + aId] = JSON.stringify({
      allFields: shownFields,
      filtersSelected,
      sortField,
      sortDescending,
    });
    
    for (let i in filters) {
      let autoAt = filters[i].indexOf("auto");
      if (autoAt != -1) {
        let s = allFieldValuesOf(entries, i);
        if(s.length>0)
          filters[i].splice(autoAt, 1, ...s.sort());
      }
    }

  }

  function loadFields() {
    shownFields = ["id", ...fields];
    let saved = localStorage["xpediaColumnOrder" + aId];
    if (saved) {
      try {
        let parsed = JSON.parse(saved);
        if (parsed.allFields) {
          shownFields = parsed.allFields;
          filtersSelected = parsed.filtersSelected;
          sortField = parsed.sortField;
          sortDescending = parsed.sortDescending;
        }
      } catch {}
      aIdLoaded = aId;
    }
    resort();
  }
</script>

<p class="extra-fields">
  {#each [...fields, ...extraFields] as field, i}
    {@html divider(i)}
    <span
      class={"clickable " + (shownFields.includes(field) ? "on" : "off")}
      on:click={() => toggleField(field)}><Tr s={field} /></span
    >
  {/each}
</p>

<p>
  {#each Object.entries(filters) as [filter, options]}
    <Tr s={filter} />:
    <select
      on:change={(event) => {
        filtersSelected[filter] = event.target.value;
        resort();
      }}
    >
      {#each options as option, i}
        <option selected={filtersSelected[filter] == option} value={option}
          ><Tr s={option} /></option
        >
      {/each}
    </select>
  {/each}
  <input
    bind:value={filterId}
    on:keyup={resort}
    type="text"
    placeholder={tr("Filter...")}
  />
</p>

{#if compareSel.length}
  <p class="compare-bar">
    <span>⇄ <Tr s="Compare" />:</span>
    {#each compareSel as id, i}
      {@html divider(i)}
      <span class="compare-chip" on:click={() => toggleCompare(id)}
        >{@html rul.tr(id)} ✕</span
      >
    {/each}
    <button
      class="compare-go"
      disabled={compareSel.length < 2}
      on:click={goCompareSelected}><Tr s="Compare" /></button
    >
    <button class="compare-go" on:click={() => (compareSel = [])}
      ><Tr s="Clear" /></button
    >
  </p>
{/if}

<PaginatedList items={sorted} let:paginatedItems>
  <table class="section-table">
    <thead>
      <td class="st-compare-col" title="Tick rows to compare">⇄</td>
      {#each shownFields as field}
        <td
          id={"thead " + field}
          draggable="true"
          on:dragstart={(e) => e.dataTransfer.setData("field", field)}
          on:drop={(e) => moveField(e.dataTransfer.getData("field"), field)}
          on:dragover={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          on:click={() => sortBy(field)}
        >
          <span class="sort-order-arrow">
            {@html invisible("▼")}
          </span>
          <Tr s={field} />
          <span class="sort-order-arrow">
            {@html sortField != field
              ? invisible("▼")
              : sortDescending
              ? "▼"
              : "▲"}
          </span>
        </td>
      {/each}
    </thead>
    <tbody>
      {#each paginatedItems as entry}
        <!-- svelte-ignore component-name-lowercase -->
        <tr>
          <td class="st-compare-col">
            <input
              type="checkbox"
              checked={compareSel.includes(entry.id)}
              disabled={!compareSel.includes(entry.id) &&
                compareSel.length >= MAX_COMPARE}
              on:change={() => toggleCompare(entry.id)}
            />
          </td>
          {#each shownFields as field}
            <td class="st-{field}"
              ><Value nobr={20} key={field} val={entry.sortField(field, true)} /></td
            >
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</PaginatedList>
