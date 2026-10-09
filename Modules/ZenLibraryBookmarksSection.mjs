import { BOOKMARKS_SECTION_ID, LIT_URL, PLACES_CONTEXT_ID, STRINGS, formatUrl } from "./ZenLibraryTweaksShared.mjs";
import { BookmarksDragAndDrop, BookmarksPlacesView } from "./ZenLibraryBookmarksIntegration.mjs";
import { LINK_ACTIONS, openInGlance } from "./ZenLibraryTweaksShared.mjs";
import { BookmarksQuery, WorkspaceBookmarks, folderStore } from "./ZenLibraryBookmarksData.mjs";

const SEARCH_SECTION_URL = "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
const { html, repeat } = ChromeUtils.importESModule(LIT_URL, { global: "current" });
const { PAGE_SIZE, ZenLibrarySearchSection } = ChromeUtils.importESModule(SEARCH_SECTION_URL, { global: "current" });

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, { PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs" });

const WORKSPACE_EVENTS = ["ZenWorkspaceDataChanged", "ZenWorkspacesUIUpdate"];

export class ZenLibraryBookmarksSection extends ZenLibrarySearchSection {
  static id = BOOKMARKS_SECTION_ID;
  static label = "library-bookmarks-section-title";

  static render(library) {
    return html`
      <zen-library-bookmarks-section class="zen-library-section" data-section="bookmarks" .library=${library}></zen-library-bookmarks-section>
    `;
  }

  static properties = {
    roots: { state: true },
    results: { state: true },
    flat: { state: true },
  };

  #query = null;
  #expanded = new Set();
  #children = new Map();
  #childrenReads = new Map();
  #limit = PAGE_SIZE;
  #exhausted = false;
  #searchGeneration = 0;
  #flatGeneration = 0;
  #filterObserver = null;
  #workspaceSignature = "";
  #tags = [];
  #placesView = null;
  #contextRow = null;
  #contextItem = null;
  #menuOpen = false;
  #linkItems = [];
  #linkTarget = null;
  #drag = new BookmarksDragAndDrop(this);

  constructor() {
    super();
    this.roots = null;
    this.results = null;
    this.flat = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#query = new BookmarksQuery();
    this.#query.observeBookmarks(changes => this.#onBookmarksChanged(changes));
    
    this.#placesView = new BookmarksPlacesView();
    this.#placesView.onCutChanged = () => this.requestUpdate();
    this._placesView = this.#placesView;
    this.#drag.attach();
    
    const menu = document.getElementById(PLACES_CONTEXT_ID);
    menu?.addEventListener("popuphidden", this.#onMenuHidden);
    menu?.addEventListener("command", this.#onMenuCommand);
    menu?.addEventListener("popupshowing", this.#onMenuShowing);
    this.#addLinkItems(menu);
    
    this.#fetchRoots();
    this.#onTagsChanged();
    
    for (const type of WORKSPACE_EVENTS) window.addEventListener(type, this.#onWorkspacesChanged);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const type of WORKSPACE_EVENTS) window.removeEventListener(type, this.#onWorkspacesChanged);
    
    this.#filterObserver?.disconnect();
    this.#filterObserver = null;
    
    const menu = document.getElementById(PLACES_CONTEXT_ID);
    menu?.removeEventListener("popuphidden", this.#onMenuHidden);
    menu?.removeEventListener("command", this.#onMenuCommand);
    menu?.removeEventListener("popupshowing", this.#onMenuShowing);
    
    for (const item of this.#linkItems) item.remove();
    this.#linkItems = [];
    this.#linkTarget = null;
    
    this.#drag.detach();
    this.#releaseMenu();
    this.#placesView?.close();
    this.#placesView = null;
    this._placesView = null;
    
    this.#query?.close();
    this.#query = null;
    this.#children.clear();
    this.#childrenReads.clear();
  }

  get searchPlaceholderL10nId() { return "library-bookmarks-search-placeholder"; }
  get filterTitleL10nId() { return "library-bookmarks-filter-title"; }

  get filterGroups() {
    const groups = [];
    const workspaces = WorkspaceBookmarks.getWorkspaces();
    if (workspaces.length >= 2) {
      groups.push({
        id: "workspace", titleL10nId: "library-bookmarks-filter-workspace",
        exclusive: true, options: workspaces.map(({ uuid, name }) => ({ id: uuid, label: name })),
      });
    }
    const tags = this.#tags;
    if (tags.length) {
      groups.push({
        id: "tags", titleL10nId: "library-bookmarks-filter-tags",
        options: tags.map(tag => ({ id: tag, label: tag })),
      });
    }
    return groups;
  }

  #activeWorkspace() {
    const workspace = WorkspaceBookmarks.getWorkspaces().find(({ uuid }) => this.isFilterActive("workspace", uuid));
    return workspace?.uuid ?? null;
  }

  #filters() {
    const workspace = this.#activeWorkspace();
    const tags = [...this.activeFilters].filter(key => key.startsWith("tags:")).map(key => key.slice("tags:".length));
    return workspace || tags.length ? { workspace, tags } : null;
  }

  updated(changedProperties) {
    this.#applyStrings();
    super.updated(changedProperties);
    this.#syncFolderIcons();
    this.#watchFilterPanel();
    this.#sizeFilterPanel();
    this.#drag.playDropAnimation();
  }

  #sizeFilterPanel = () => {
    const panel = this.querySelector(".zen-library-filter-panel-inner");
    if (this.filtersOpen && panel) this.style.setProperty("--zen-library-filter-height", `${panel.scrollHeight + 8}px`);
  };

  #watchFilterPanel() {
    this.#filterObserver ??= new ResizeObserver(this.#sizeFilterPanel);
    this.#filterObserver.disconnect();
    
    const panel = this.querySelector(".zen-library-filter-panel-inner");
    if (!this.filtersOpen || !panel) return;
    
    this.#filterObserver.observe(panel);
    for (const group of panel.children) this.#filterObserver.observe(group);
  }

  #onWorkspacesChanged = () => {
    const workspaces = WorkspaceBookmarks.getWorkspaces();
    const signature = JSON.stringify(workspaces.map(({ uuid, name }) => [uuid, name]));
    if (signature === this.#workspaceSignature) return;
    
    this.#workspaceSignature = signature;
    const known = new Set(workspaces.map(({ uuid }) => uuid));
    let dropped = false;
    
    for (const key of this.activeFilters) {
      const [group, uuid] = key.split(":");
      if (group === "workspace" && !known.has(uuid)) {
        this.activeFilters.delete(key);
        dropped = true;
      }
    }
    
    if (!this.filterGroups.length) this.filtersOpen = false;
    this.requestUpdate();
    if (dropped) this.onFiltersChanged();
  };

  async #onTagsChanged() {
    const query = this.#query;
    try {
      const meta = await query.getMeta();
      if (query !== this.#query) return;
      
      const tags = new Set();
      for (const { tags: own } of meta.values()) {
        for (const tag of own) tags.add(tag);
      }
      this.#tags = [...tags].sort((a, b) => a.localeCompare(b));
    } catch (ex) {
      console.error("Failed to read the tags", ex);
      return;
    }
    
    let dropped = false;
    for (const key of this.activeFilters) {
      if (key.startsWith("tags:") && !this.#tags.includes(key.slice(5))) {
        this.activeFilters.delete(key);
        dropped = true;
      }
    }
    
    if (!this.filterGroups.length) this.filtersOpen = false;
    this.requestUpdate();
    if (dropped) this.onFiltersChanged();
  }

  #applyStrings() {
    for (const element of this.querySelectorAll("[data-l10n-id]")) {
      const text = STRINGS[element.getAttribute("data-l10n-id")];
      if (text === undefined) continue;
      if (element.localName === "input") element.placeholder = text;
      else if (element.textContent !== text) element.textContent = text;
    }
  }

  onSearchChanged() {
    this.#limit = PAGE_SIZE;
    this.#exhausted = false;
    if (this.searchQuery) this.#fetchResults();
    else { this.#searchGeneration++; this.results = null; }
  }

  onFiltersChanged() {
    this.#limit = PAGE_SIZE;
    this.#exhausted = false;
    this.flat = null;
    this.#refreshFiltered();
  }

  #refreshFiltered() {
    if (this.#filters()) this.#fetchFlat();
    else this.#flatGeneration++;
    if (this.searchQuery) this.#fetchResults();
  }

  onListScrolledToEnd() {
    if (!this.searchQuery || !this.results || this.#exhausted) return;
    this.#limit += PAGE_SIZE;
    this.#fetchResults();
  }

  async #fetchRoots() {
    const query = this.#query;
    try {
      const roots = await query.getRoots();
      await this.#openStoredFolders(query, roots);
      if (query === this.#query) this.roots = roots;
    } catch (ex) { console.error("Failed to read the bookmark roots", ex); }
  }

  async #readFolder(query, folderGuid) {
    const children = await query.getChildren(folderGuid);
    await this.#openStoredFolders(query, children);
    return children;
  }

  async #openStoredFolders(query, nodes) {
    const open = nodes.filter(node => node.type === "folder" && folderStore.isOpen(node.guid));
    await Promise.all(
      open.map(async folder => {
        this.#expanded.add(folder.guid);
        if (this.#children.has(folder.guid)) return;
        const children = await this.#readFolder(query, folder.guid);
        if (query === this.#query) this.#children.set(folder.guid, children);
      })
    );
  }

  async #fetchChildren(folderGuid) {
    const query = this.#query;
    const read = {};
    this.#childrenReads.set(folderGuid, read);
    try {
      const children = await this.#readFolder(query, folderGuid);
      if (query === this.#query && this.#childrenReads.get(folderGuid) === read) {
        this.#children.set(folderGuid, children);
        this.requestUpdate();
      }
    } catch (ex) { console.error("Failed to read a bookmark folder", ex); }
  }

  async #fetchFlat() {
    const generation = ++this.#flatGeneration;
    const query = this.#query;
    try {
      const flat = await query.getFlat({ filters: this.#filters() });
      if (generation === this.#flatGeneration && query === this.#query) this.flat = flat;
    } catch (ex) { console.error("Failed to read workspace bookmarks", ex); }
  }

  async #fetchResults() {
    const generation = ++this.#searchGeneration;
    const query = this.#query;
    try {
      const results = await query.search(this.searchQuery, { limit: this.#limit, filters: this.#filters() });
      if (generation !== this.#searchGeneration || query !== this.#query) return;
      this.#exhausted = results.length < this.#limit;
      this.results = results;
    } catch (ex) { console.error("Failed to search bookmarks", ex); }
  }

  #onBookmarksChanged({ folderGuids, metaChanged }) {
    if (metaChanged) this.#onTagsChanged();
    for (const guid of folderGuids) {
      if (this.#children.has(guid)) this.#fetchChildren(guid);
    }
    if (folderGuids.has(lazy.PlacesUtils.bookmarks.mobileGuid)) this.#fetchRoots();
    this.#refreshFiltered();
  }

  toggleFolder(folderGuid) {
    const open = !this.#expanded.has(folderGuid);
    if (open) {
      this.#expanded.add(folderGuid);
      if (!this.#children.has(folderGuid)) this.#fetchChildren(folderGuid);
    } else {
      this.#expanded.delete(folderGuid);
    }
    folderStore.setOpen(folderGuid, open);
    this.requestUpdate();
  }

  #onFolderKeyDown(event, folderGuid) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.toggleFolder(folderGuid);
    }
  }

  #syncFolderIcons() {
    const rawIcon = customElements.get("zen-folder")?.rawIcon;
    if (!rawIcon) return;
    const { bookmarks } = lazy.PlacesUtils;
    const SPECIAL_FOLDER_ICONS = {
      [bookmarks.toolbarGuid]: "chrome://browser/skin/zen-icons/selectable/star-1.svg",
      [bookmarks.menuGuid]: "chrome://browser/skin/zen-icons/selectable/inbox.svg",
      [bookmarks.unfiledGuid]: "chrome://browser/skin/zen-icons/selectable/bookmark.svg",
    };
    for (const icon of this.querySelectorAll(".zen-library-folder-icon")) {
      let svg = icon.firstElementChild;
      if (!svg) {
        svg = rawIcon.cloneNode(true);
        icon.append(svg);
      }
      const folderEl = icon.closest(".zen-library-folder");
      const open = folderEl.hasAttribute("open");
      svg.setAttribute("state", open ? "open" : "close");
      
      const guid = folderEl.querySelector(".zen-library-folder-row")?.libraryItem?.guid;
      const svgImage = svg.querySelector(".icon image");
      if (svgImage) svgImage.setAttribute("href", SPECIAL_FOLDER_ICONS[guid] ?? "");
    }
  }

  #openBookmark(bookmark, event) {
    if (event.altKey && event.button !== 1) {
      openInGlance(bookmark.url, event.currentTarget);
      return;
    }
    const background = event.getModifierState("Accel") || event.button === 1;
    const where = event.shiftKey && !background ? "window" : "tab";
    const open = () => window.openTrustedLinkIn(bookmark.url, where, { inBackground: background });
    
    if (background) {
      this.library.keepOpenWhile(open);
      return;
    }
    open();
    this.library.constructor.toggle();
  }

  #onBookmarkKeyDown(event, bookmark) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.#openBookmark(bookmark, event);
    }
  }

  get placesView() { return this.#placesView; }
  get openFolders() { return this.#expanded; }
  get acceptsDrops() { return !this.searchQuery && !this.#filters(); }

  parentOf(guid) {
    for (const list of [this.roots ?? [], ...this.#children.values()]) {
      const found = list.find(item => item.guid === guid);
      if (found) return found.parentGuid;
    }
    return null;
  }

  #onContextMenu(event, item, anchor = null) {
    const menu = document.getElementById(PLACES_CONTEXT_ID);
    const view = this.#placesView;
    if (!menu || !view) return;
    
    event.preventDefault();
    event.stopPropagation();

    let node = null;
    try { node = view.select(item); } catch (ex) { console.error("Failed to find Places node", ex); }
    const controller = view.controller;
    if (!node || !controller) return;

    const row = event.currentTarget.closest(".zen-library-row");
    row._placesNode = node;
    if (event.target !== row) event.target._placesNode = node;

    this.#contextRow?.removeAttribute("context-active");
    row.setAttribute("context-active", "");
    this.#contextRow = row;
    this.#contextItem = item;
    this.#menuOpen = true;
    
    if (anchor) menu.openPopup(anchor, "after_end", 0, 4, false, false, event);
    else menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
  }

  #addLinkItems(menu) {
    if (!menu) return;
    this.#linkItems = LINK_ACTIONS.map(action => {
      const item = document.createXULElement("menuitem");
      item.className = "zen-library-link-item";
      item.setAttribute("label", action.label);
      item.hidden = true;
      item.addEventListener("command", () => {
        if (this.#linkTarget) action.run(this.#linkTarget.url, this.#linkTarget.row);
      });
      return item;
    });
    
    const anchor = document.getElementById("placesContext_open:newtab");
    if (anchor) anchor.after(...this.#linkItems);
    else menu.prepend(...this.#linkItems);
  }

  #onMenuShowing = event => {
    if (event.target !== event.currentTarget) return;
    const url = this.#menuOpen ? this.#contextItem?.url : null;
    this.#linkTarget = url ? { url, row: this.#contextRow } : null;
    for (const item of this.#linkItems) item.hidden = !url;
  };

  #releaseMenu() {
    this.#contextRow?.removeAttribute("context-active");
    this.#contextRow = null;
    this.#contextItem = null;
    this.#menuOpen = false;
  }

  #onMenuHidden = event => {
    if (event.target !== event.currentTarget || !this.#menuOpen) return;
    setTimeout(() => {
      this.#releaseMenu();
      this.requestUpdate();
    }, 0);
  };

  #onMenuCommand = event => {
    if (!this.#menuOpen) return;
    const command = event.target.getAttribute?.("command");
    const inBackground = Services.prefs.getBoolPref("browser.tabs.loadBookmarksInBackground", false);
    const opensInFront = command === "placesCmd_open" || command === "placesCmd_open:window" || 
                         command === "placesCmd_open:privatewindow" || (command === "placesCmd_open:tab" && !inBackground);
    
    if (opensInFront) setTimeout(() => this.library?.constructor.toggle(), 0);
  };

  #renderBookmark(bookmark) {
    return html`
      <div class="zen-library-row" role="link" tabindex="0" draggable="true"
        .libraryItem=${bookmark} ?cutting=${this.#placesView?.isCut(bookmark)}
        ?landing=${this.#drag.landingGuid === bookmark.guid}
        @click=${event => this.#openBookmark(bookmark, event)}
        @contextmenu=${event => this.#onContextMenu(event, bookmark)}
        @keydown=${event => this.#onBookmarkKeyDown(event, bookmark)}
        @mousedown=${event => { if (event.button === 1) event.preventDefault(); }}
        @auxclick=${event => { if (event.button === 1) { event.preventDefault(); this.#openBookmark(bookmark, event); } }}
        @dragstart=${event => this.#drag.start(event, bookmark)}>
        <img class="zen-library-row-icon" src="page-icon:${bookmark.url}" alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${bookmark.title || bookmark.url}</span>
          <span class="zen-library-row-subtitle">${formatUrl(bookmark.url)}</span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton class="toolbarbutton-1" data-l10n-id="library-downloads-more-button"
            @click=${event => { event.stopPropagation(); this.#onContextMenu(event, bookmark, event.currentTarget); }}
            @auxclick=${event => event.stopPropagation()}>
            <img class="toolbarbutton-icon" src="chrome://global/skin/icons/more.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  #renderFolder(folder) {
    const open = this.#expanded.has(folder.guid);
    const children = this.#children.get(folder.guid);
    return html`
      <div class="zen-library-folder" ?open=${open}>
        <div class="zen-library-row zen-library-folder-row" role="button" tabindex="0"
          aria-expanded=${open} draggable=${this.#drag.isDraggable(folder) ? "true" : "false"}
          .libraryItem=${folder} ?cutting=${this.#placesView?.isCut(folder)}
          ?landing=${this.#drag.landingGuid === folder.guid}
          @contextmenu=${event => this.#onContextMenu(event, folder)}
          @dragstart=${event => this.#drag.start(event, folder)}
          @click=${() => this.toggleFolder(folder.guid)}
          @keydown=${event => this.#onFolderKeyDown(event, folder.guid)}>
          <span class="zen-library-folder-icon"></span>
          <div class="zen-library-row-text">
            <span class="zen-library-row-title">${folder.title}</span>
          </div>
        </div>
        <div class="zen-library-folder-children" ?inert=${!open}>
          <div class="zen-library-folder-items">
            ${children ? this.#renderNodes(children) : null}
          </div>
        </div>
      </div>
    `;
  }

  #renderNodes(nodes) {
    return repeat(nodes, node => node.guid, node => {
      switch (node.type) {
        case "folder": return this.#renderFolder(node);
        case "separator":
          return html`<div class="zen-library-row zen-library-separator" role="separator" draggable="true"
            .libraryItem=${node} ?cutting=${this.#placesView?.isCut(node)}
            ?landing=${this.#drag.landingGuid === node.guid}
            @contextmenu=${event => this.#onContextMenu(event, node)}
            @dragstart=${event => this.#drag.start(event, node)}></div>`;
        default: return this.#renderBookmark(node);
      }
    });
  }

  #renderEmpty() {
    return html`<div class="zen-library-empty">${STRINGS["library-bookmarks-empty"]}</div>`;
  }

  renderItems() {
    let nodes = this.roots;
    if (this.searchQuery) nodes = this.results;
    else if (this.#filters()) nodes = this.flat;
    
    if (!nodes) return null;
    if (!nodes.length) return this.#renderEmpty();
    return html`<div class="zen-library-group">${this.#renderNodes(nodes)}</div>`;
  }
}

customElements.define("zen-library-bookmarks-section", ZenLibraryBookmarksSection);