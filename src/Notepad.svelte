<script>
  /**
   * A floating scratchpad that survives reloads.
   *
   * Deliberately dumb: text, a position, and a collapsed flag, all in
   * localStorage. No formatting, no sync, no per-page notes - one pad that
   * follows you around, because the thing it is for is jotting "check the
   * Sawed-Off against armoured stuff" while you are three columns deep in the
   * tech tree and do not want to lose your place.
   *
   * Rendered from App so it floats above every view.
   */
  import { onMount } from "svelte";

  const PREF = "xpediaNotepad";

  let open = false;
  let collapsed = false;
  let text = "";
  let x = 80;
  let y = 80;
  let w = 320;
  let h = 240;
  let loaded = false;

  onMount(() => {
    try {
      const s = JSON.parse(localStorage[PREF] || "{}");
      if (s && typeof s == "object") {
        open = !!s.open;
        collapsed = !!s.collapsed;
        text = typeof s.text == "string" ? s.text : "";
        if (+s.x >= 0) x = +s.x;
        if (+s.y >= 0) y = +s.y;
        if (+s.w > 120) w = +s.w;
        if (+s.h > 80) h = +s.h;
      }
    } catch (e) {
      // A corrupt pad is not worth breaking the page over.
    }
    loaded = true;
    clampIntoView();
  });

  /** A pad remembered off-screen (smaller window since) would be unreachable. */
  function clampIntoView() {
    const maxX = Math.max(0, window.innerWidth - 60);
    const maxY = Math.max(0, window.innerHeight - 40);
    if (x > maxX) x = maxX;
    if (y > maxY) y = maxY;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
  }

  function persist() {
    if (!loaded) return;
    try {
      localStorage[PREF] = JSON.stringify({ open, collapsed, text, x, y, w, h });
    } catch (e) {
      // no-op
    }
  }

  $: if (loaded) {
    // Touching every field so any change is written.
    open, collapsed, text, x, y, w, h;
    persist();
  }

  let dragging = false;
  let offX = 0;
  let offY = 0;

  function startDrag(e) {
    // Left button only, and never from the buttons in the title bar.
    if (e.button !== 0) return;
    dragging = true;
    offX = e.clientX - x;
    offY = e.clientY - y;
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", endDrag);
  }

  function onDrag(e) {
    if (!dragging) return;
    x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - offX));
    y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offY));
  }

  function endDrag() {
    dragging = false;
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", endDrag);
  }
</script>

<button
  class="navbar-button"
  id="notepad-button"
  title={open ? "Hide the notepad" : "Open a floating notepad - it follows you between views and survives reloads"}
  on:click={() => {
    open = !open;
    if (open) collapsed = false;
    clampIntoView();
  }}>✎</button
>

{#if open}
  <div class="notepad" class:notepad-collapsed={collapsed} style="left:{x}px; top:{y}px;">
    <div class="notepad-bar" on:pointerdown={startDrag}>
      <span class="notepad-title">Notes{#if text.trim() && collapsed}&nbsp;·&nbsp;{text.trim().split("\n")[0].slice(0, 24)}{/if}</span>
      <button
        class="notepad-btn"
        title={collapsed ? "Expand" : "Collapse to the title bar"}
        on:click|stopPropagation={() => (collapsed = !collapsed)}>{collapsed ? "▢" : "—"}</button
      >
      <button class="notepad-btn" title="Close" on:click|stopPropagation={() => (open = false)}>✕</button>
    </div>
    {#if !collapsed}
      <textarea
        class="notepad-text"
        style="width:{w}px; height:{h}px;"
        placeholder="Research order, things to try, what to bring…"
        bind:value={text}
      />
    {/if}
  </div>
{/if}
