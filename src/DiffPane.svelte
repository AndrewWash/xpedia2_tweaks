<script>
  /**
   * The third pane: a stat-by-stat summary of what actually differs between the
   * compare panes. Rows come from compareDiff.ts, which diffs the ruleset objects
   * directly, so this is real data rather than a scrape of the rendered articles.
   *
   * Identical rows are hidden by default - the whole point is to answer "what is
   * different", and most fields on two items of the same kind are not.
   */
  import { Tr } from "./Components";
  import { rul } from "./Ruleset";
  import { createEventDispatcher } from "svelte";

  /**@type {import("./compareDiff").Diff}*/
  export let diff;
  export let showSame = false;
  export let highlight = true;
  export let collapsed = false;

  const dispatch = createEventDispatcher();

  $: cols = diff ? diff.cols : [];
  $: pair = cols.length == 2;
  $: rows = diff ? (showSame ? diff.rows : diff.rows.filter((r) => r.differs)) : [];

  function num(v) {
    if (v == null) return "‒";
    const n = +v;
    if (!isFinite(n)) return "" + v;
    return Math.round(n * 10000) / 10000 + "";
  }

  function delta(row) {
    if (row.delta == null || row.delta == 0) return "";
    const sign = row.delta > 0 ? "+" : "";
    let s = sign + num(row.delta);
    if (row.pct != null && Math.abs(row.pct) < 100000)
      s += " (" + sign + Math.round(row.pct) + "%)";
    return s;
  }

  /** Green when the right-hand column is the better one, red when it is worse. */
  function deltaClass(row) {
    if (!row.dir || row.delta == null || row.delta == 0) return "diff-neutral";
    return row.delta * row.dir > 0 ? "diff-better" : "diff-worse";
  }

  function cellClass(row, i) {
    if (!row.differs) return "";
    if (row.best == i) return "diff-better";
    if (row.worst == i) return "diff-worse";
    return "";
  }

  function asList(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }
</script>

<div class="diff-pane" class:diff-collapsed={collapsed}>
  <div class="diff-header">
    <button
      class="diff-toggle"
      title={collapsed ? "Expand" : "Collapse"}
      on:click={() => dispatch("collapse")}
    >
      {collapsed ? "▲" : "▼"}
    </button>
    <strong>Δ&nbsp;<Tr s="Differences" /></strong>

    {#if diff && diff.ready}
      <span class="diff-count">
        {diff.differing}/{diff.rows.length}
      </span>
    {/if}

    <span class="stretcher" />

    {#if diff && diff.ready && !collapsed}
      <label class="diff-opt">
        <input type="checkbox" bind:checked={showSame} />
        <Tr s="Show identical" />
      </label>
      <label class="diff-opt">
        <input
          type="checkbox"
          checked={highlight}
          on:change={(e) => dispatch("highlight", e.target.checked)}
        />
        <Tr s="Highlight in panes" />
      </label>
    {/if}
  </div>

  {#if !collapsed}
    <div class="diff-body">
      {#if !diff || !diff.ready}
        <div class="compare-empty">
          {#if diff && diff.unknown.length}
            <Tr s="No comparable stats for" />
            {diff.unknown.map((id) => rul.tr(id)).join(", ")}
          {:else}
            <Tr s="Pick something in two panes to see a difference summary" />
          {/if}
        </div>
      {:else}
        {#if !diff.kindsMatch}
          <div class="diff-notice">
            <Tr s="Different kinds" /> ({diff.kinds.join(" / ")}) &mdash;
            <Tr s="showing only the fields they share" />
          </div>
        {/if}

        <table class="diff-table">
          <thead>
            <tr>
              <td class="diff-key-col"><Tr s="Stat" /></td>
              {#each cols as col}
                <td>{col ? col.title : "‒"}</td>
              {/each}
              {#if pair}<td class="diff-delta-col">Δ</td>{/if}
            </tr>
          </thead>

          {#if diff.attacks}
            {#each diff.attacks as group}
              <tbody>
                <tr class="diff-group">
                  <td colspan={cols.length + (pair ? 2 : 1)}>
                    ⚔ {rul.tr(group.label)}
                  </td>
                </tr>
                {#each group.rows as row}
                  <tr class:diff-same={!row.differs}>
                    <td class="diff-key-col"><Tr s={row.key} /></td>
                    {#each row.values as v, i}
                      <td class={cellClass(row, i)}>
                        {#if !group.present[i]}
                          <span class="diff-absent">‒</span>
                        {:else if row.kind == "number"}
                          <em class="num">{num(v)}</em>
                        {:else if v == null}
                          ‒
                        {:else}
                          <Tr s={"" + v} simple={true} />
                        {/if}
                      </td>
                    {/each}
                    {#if pair}
                      <td class={"diff-delta-col " + deltaClass(row)}>
                        {delta(row)}
                      </td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            {/each}
          {/if}

          <tbody>
            {#if diff.attacks && rows.length}
              <tr class="diff-group">
                <td colspan={cols.length + (pair ? 2 : 1)}>
                  ☰ <Tr s="Stats" />
                </td>
              </tr>
            {/if}
            {#each rows as row}
              <tr class:diff-same={!row.differs}>
                <td class="diff-key-col"><Tr s={row.key} /></td>
                {#each row.values as v, i}
                  <td class={cellClass(row, i)}>
                    {#if v == null}
                      <span class="diff-absent">‒</span>
                    {:else if row.kind == "number"}
                      <em class="num">{num(v)}</em>
                    {:else if row.kind == "bool"}
                      <span style="color:{v ? 'lime' : 'red'}">{v ? "✔" : "✘"}</span>
                    {:else if row.kind == "list"}
                      <span class="diff-list">
                        {#each asList(v) as item, j}
                          {#if j > 0}<span class="list-divider">&nbsp;·&nbsp;</span>{/if}
                          <span class:diff-unique={row.uniques[i] && row.uniques[i].has(item)}>
                            <Tr s={"" + item} simple={true} />
                          </span>
                        {/each}
                      </span>
                    {:else}
                      <Tr s={"" + v} simple={true} />
                    {/if}
                  </td>
                {/each}
                {#if pair}
                  <td class={"diff-delta-col " + deltaClass(row)}>{delta(row)}</td>
                {/if}
              </tr>
            {/each}
            {#if !rows.length}
              <tr>
                <td colspan={cols.length + (pair ? 2 : 1)} class="compare-empty">
                  <Tr s="No differences" />
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</div>
