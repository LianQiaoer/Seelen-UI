<script lang="ts">
  import { lpState, matches, nameFromPath, type LaunchpadApp } from "./state.svelte.ts";
  import Tile from "./components/Tile.svelte";

  let gridEl: HTMLElement | null = $state(null);
  let searchEl: HTMLInputElement | null = $state(null);
  let cols = $state(5);
  let rows = $state(3);

  const visible = $derived(lpState.apps.filter((a) => matches(a, lpState.query.trim())));
  const slots = $derived<(LaunchpadApp | null)[]>(
    lpState.editing && !lpState.query.trim() ? [...visible, null] : visible,
  );
  const perPage = $derived(Math.max(1, cols * rows));
  const pageCount = $derived(Math.max(1, Math.ceil(slots.length / perPage)));
  const pages = $derived(
    Array.from({ length: pageCount }, (_, i) => slots.slice(i * perPage, (i + 1) * perPage)),
  );

  $effect(() => {
    if (lpState.page > pageCount - 1) lpState.page = pageCount - 1;
    if (lpState.page < 0) lpState.page = 0;
  });

  $effect(() => {
    void lpState.focusNonce;
    if (lpState.focusNonce > 0) {
      setTimeout(() => searchEl?.focus(), 50);
    }
  });

  $effect(() => {
    const el = gridEl;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth || 0;
      const h = el.clientHeight || 0;
      if (w > 0 && h > 0) {
        cols = Math.max(1, Math.floor((w + 10) / 118));
        rows = Math.max(1, Math.floor((h + 14) / 146));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);

    let wheelLockUntil = 0;
    let dragStartX: number | null = null;
    let suppressNextClick = false;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const now = Date.now();
      if (now < wheelLockUntil || pageCount <= 1) return;
      if (Math.abs(ev.deltaY) < 4) return;
      wheelLockUntil = now + 420;
      lpState.goToPage(lpState.page + (ev.deltaY > 0 ? 1 : -1), pageCount);
    };
    const onPointerDown = (ev: PointerEvent) => {
      dragStartX = ev.clientX;
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (dragStartX === null) return;
      const dx = ev.clientX - dragStartX;
      dragStartX = null;
      if (Math.abs(dx) > 60 && pageCount > 1) {
        suppressNextClick = true;
        setTimeout(() => (suppressNextClick = false), 120);
        lpState.goToPage(lpState.page + (dx < 0 ? 1 : -1), pageCount);
      }
    };
    const onClickCapture = (ev: MouseEvent) => {
      if (suppressNextClick) {
        ev.stopPropagation();
        ev.preventDefault();
        suppressNextClick = false;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("click", onClickCapture, true);
    };
  });

  function onBackdropClick(ev: MouseEvent) {
    if (lpState.editor) return;
    const tg = ev.target as HTMLElement;
    if (
      tg.classList.contains("lp-backdrop") ||
      tg.classList.contains("lp-grid") ||
      tg.classList.contains("lp-pages") ||
      tg.classList.contains("lp-page")
    ) {
      lpState.closeWithAnimation();
    }
  }

  function onRootContextMenu(ev: MouseEvent) {
    ev.preventDefault();
    const tileEl = (ev.target as HTMLElement).closest?.("[data-lp-item]") as HTMLElement | null;
    const item = tileEl ? lpState.apps.find((a) => a.id === tileEl.dataset.lpItem) : undefined;
    if (item) {
      const mw = 156;
      const mh = 96;
      lpState.openMenu(
        Math.max(4, Math.min(ev.clientX, window.innerWidth - mw - 4)),
        Math.max(4, Math.min(ev.clientY, window.innerHeight - mh - 4)),
        item,
      );
    } else {
      lpState.hideMenu();
    }
  }

  function onDocPointerDown(ev: PointerEvent) {
    if (lpState.menu && !(ev.target as HTMLElement).closest?.(".lp-menu")) {
      lpState.hideMenu();
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      if (lpState.menu) lpState.hideMenu();
      else if (lpState.editor) lpState.closeEditor();
      else lpState.closeWithAnimation();
      return;
    }
    if (document.activeElement === searchEl) return;
    if (ev.key === "ArrowRight") lpState.goToPage(lpState.page + 1, pageCount);
    else if (ev.key === "ArrowLeft") lpState.goToPage(lpState.page - 1, pageCount);
  }

  function onSearchEnter(ev: KeyboardEvent) {
    if (ev.key === "Enter") {
      const first = visible[0];
      if (first && !lpState.editing) lpState.launch(first);
    }
  }

</script>

<svelte:window onkeydown={onKeyDown} onpointerdown={onDocPointerDown} />

<div
  id="lp-root"
  class:lp-opening={lpState.opening}
  class:lp-closing={lpState.closing}
  class:lp-editing={lpState.editing}
  class:lp-dragging={lpState.dragHover}
  oncontextmenu={onRootContextMenu}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lp-backdrop" onclick={onBackdropClick}>
    <header class="lp-header">
      <div class="lp-search-wrap">
        <input
          id="lp-search"
          type="text"
          placeholder="搜索应用"
          autocomplete="off"
          spellcheck="false"
          bind:this={searchEl}
          bind:value={lpState.query}
          oninput={() => (lpState.page = 0)}
          onkeydown={onSearchEnter}
        />
      </div>
      <div class="lp-actions">
        <button class="lp-btn" type="button" onclick={() => lpState.pickFiles()}>添加应用</button>
        <button
          class="lp-btn"
          class:lp-active={lpState.editing}
          type="button"
          onclick={() => (lpState.editing = !lpState.editing)}
        >
          {lpState.editing ? "完成" : "编辑"}
        </button>
        <button
          class="lp-btn lp-btn-icon"
          type="button"
          title="关闭"
          onclick={() => lpState.closeWithAnimation()}>✕</button
        >
      </div>
    </header>

    <main id="lp-grid" class="lp-grid" bind:this={gridEl}>
      <div class="lp-pages" style="transform: translateX(-{lpState.page * 100}%)">
        {#each pages as pageItems, pi (pi)}
          <div class="lp-page" style="grid-template-columns: repeat({cols}, 1fr)">
            {#each pageItems as item, ii (item ? item.id : "lp-add-" + ii)}
              {#if item}
                <Tile {item} />
              {:else}
                <button
                  class="lp-tile lp-add-tile"
                  type="button"
                  title="手动添加应用"
                  onclick={() => lpState.openEditor(null)}
                >
                  <span class="lp-tile-icon">+</span>
                  <span class="lp-tile-name">添加</span>
                </button>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
    </main>

    <div class="lp-dots" style="display: {pageCount > 1 ? 'flex' : 'none'}">
      {#each pages as _, pi (pi)}
        <button
          type="button"
          class="lp-dot"
          class:lp-dot-active={pi === lpState.page}
          title="第 {pi + 1} 页"
          onclick={() => lpState.goToPage(pi, pageCount)}
        ></button>
      {/each}
    </div>

    {#if lpState.apps.length === 0}
      <p class="lp-empty">还没有应用。把 exe 或快捷方式（.lnk）拖进来，或点击右上角「添加应用」选择文件。</p>
    {/if}

    {#if lpState.editor}
      {@const ed = lpState.editor}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="lp-editor"
        onclick={(e) => {
          if (e.target === e.currentTarget) lpState.closeEditor();
        }}
      >
        <div class="lp-editor-card">
          <h2>{ed.id ? "编辑应用" : "添加应用"}</h2>
          <label class="lp-field">
            <span>显示名称</span>
            <input type="text" placeholder="例如：微信" autocomplete="off" bind:value={ed.name} />
          </label>
          <label class="lp-field">
            <span>程序路径（exe 或 .lnk 快捷方式）</span>
            <input
              type="text"
              placeholder="例如：C:\Program Files\Tencent\WeChat\WeChat.exe"
              autocomplete="off"
              spellcheck="false"
              bind:value={ed.path}
              onblur={() => {
                if (!ed.name.trim() && ed.path.trim()) ed.name = nameFromPath(ed.path.trim());
              }}
            />
          </label>
          <label class="lp-field">
            <span>启动参数（可选）</span>
            <input
              type="text"
              placeholder="例如：--profile &quot;Work&quot;"
              autocomplete="off"
              spellcheck="false"
              bind:value={ed.args}
            />
          </label>
          <label class="lp-field">
            <span>工作目录（可选）</span>
            <input
              type="text"
              placeholder="留空则使用程序所在目录"
              autocomplete="off"
              spellcheck="false"
              bind:value={ed.workdir}
            />
          </label>
          <label class="lp-field">
            <span>图标图片地址（可选，http/https 或 data:）</span>
            <input
              type="text"
              placeholder="留空则自动读取程序图标"
              autocomplete="off"
              spellcheck="false"
              bind:value={ed.icon}
            />
          </label>
          <label class="lp-check">
            <input type="checkbox" bind:checked={ed.elevated} />
            <span>以管理员身份运行</span>
          </label>
          <div class="lp-editor-actions">
            {#if ed.id}
              <button
                class="lp-btn lp-btn-danger"
                type="button"
                onclick={() => lpState.deleteEditorItem()}>删除</button
              >
            {/if}
            <span class="lp-spacer"></span>
            <button class="lp-btn" type="button" onclick={() => lpState.closeEditor()}>取消</button>
            <button class="lp-btn lp-btn-primary" type="button" onclick={() => lpState.saveEditor()}
              >保存</button
            >
          </div>
        </div>
      </div>
    {/if}

    {#if lpState.toastVisible}
      <div class="lp-toast">{lpState.toastMsg}</div>
    {/if}
  </div>

  {#if lpState.menu}
    {@const menu = lpState.menu}
    <div class="lp-menu" style="left: {menu.x}px; top: {menu.y}px">
      <button
        type="button"
        onclick={() => {
          lpState.openEditor(menu.item);
          lpState.hideMenu();
        }}>编辑</button
      >
      <button
        type="button"
        onclick={() => {
          lpState.removeApp(menu.item);
          lpState.hideMenu();
        }}>移除</button
      >
    </div>
  {/if}

</div>
