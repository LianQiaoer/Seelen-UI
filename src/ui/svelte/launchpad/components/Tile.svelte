<script lang="ts">
  import {
    getIconManager,
    lpState,
    nameFromPath,
    requestIconExtractionOnce,
    tileColor,
    type LaunchpadApp,
  } from "../state.svelte.ts";

  let { item }: { item: LaunchpadApp } = $props();

  const label = $derived((item.name || nameFromPath(item.path) || "?").trim());
  let iconSrc = $state<string | null>(null);

  $effect(() => {
    // re-run when the item or the icon packs change
    void item.path;
    void item.icon;
    void lpState.iconVersion;
    let cancelled = false;
    iconSrc = item.icon?.trim() ? item.icon.trim() : null;
    if (!iconSrc) {
      (async () => {
        const mgr = await getIconManager();
        if (!mgr || cancelled) return;
        const tryGet = (): boolean => {
          try {
            const icon = mgr.getIcon({ path: item.path, umid: null });
            const src = icon && (icon.base || icon.dark || icon.light);
            if (src) {
              iconSrc = src;
              return true;
            }
          } catch {
            /* ignore */
          }
          return false;
        };
        if (tryGet()) return;
        requestIconExtractionOnce(item.path);
        for (const ms of [600, 1500, 3000]) {
          await new Promise((r) => setTimeout(r, ms));
          if (cancelled || iconSrc) return;
          if (tryGet()) return;
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  });
</script>

<button
  type="button"
  class="lp-tile"
  data-lp-item={item.id}
  title={item.path + (item.args ? " " + item.args : "")}
  onclick={() => (lpState.editing ? lpState.openEditor(item) : lpState.launch(item))}
>
  <div
    class="lp-tile-icon"
    style="background: {iconSrc ? 'rgba(255,255,255,0.08)' : tileColor(label)}"
  >
    {#if iconSrc}
      <img src={iconSrc} alt="" onerror={() => (iconSrc = null)} />
    {:else}
      {label ? label.charAt(0).toUpperCase() : "?"}
    {/if}
  </div>
  <div class="lp-tile-name">{label}</div>
  <span
    class="lp-tile-badge"
    role="button"
    tabindex="-1"
    title="编辑"
    onclick={(e) => {
      e.stopPropagation();
      lpState.openEditor(item);
    }}>✎</span
  >
</button>
