/**
 * The Bookmarks section of the Library: the bookmarks tree, with search,
 * filters, the native context menu and drag and drop.
 */

import {
  BOOKMARKS_SECTION_ID,
  LIT_URL,
  PLACES_CONTEXT_ID,
  STRINGS,
  formatUrl,
} from "./LibraryTweaksShared.mjs";
import { BookmarksDragAndDrop } from "./BookmarksDragAndDrop.mjs";
import { BookmarksPlacesView } from "./BookmarksPlacesView.mjs";
import { BookmarksQuery } from "./BookmarksQuery.mjs";
import { WorkspaceBookmarks, folderStore } from "./BookmarksData.mjs";

const SEARCH_SECTION_URL =
  "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const { html, repeat } = ChromeUtils.importESModule(LIT_URL, {
  global: "current",
});
const { PAGE_SIZE, ZenLibrarySearchSection } = ChromeUtils.importESModule(
  SEARCH_SECTION_URL,
  { global: "current" }
);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils:
    "resource://gre/modules/PlacesUtils.sys.mjs",
});

// Zen fires these when workspaces are added, removed, renamed or changed.
// The first comes before its cache is updated, the second after.
const WORKSPACE_EVENTS = ["ZenWorkspaceDataChanged", "ZenWorkspacesUIUpdate"];

export class ZenLibraryBookmarksSection extends ZenLibrarySearchSection {
  static id = BOOKMARKS_SECTION_ID;
  static label = "library-bookmarks-section-title";

  static render(library) {
    return html`
      <zen-library-bookmarks-section
        class="zen-library-section"
        data-section="bookmarks"
        .library=${library}
      ></zen-library-bookmarks-section>
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
  // Marks the latest read of each folder, so a slow older read cannot
  // overwrite a newer one.
  #childrenReads = new Map();
  #limit = PAGE_SIZE;
  #exhausted = false;
  #searchGeneration = 0;
  #flatGeneration = 0;
  #filterObserver = null;
  #workspaceSignature = "";
  // Every tag in use, read from the bookmarks' metadata.
  #tags = [];
  #placesView = null;
  #contextRow = null;
  #menuOpen = false;
  #drag = new BookmarksDragAndDrop(this);

  constructor() {
    super();
    this.roots = null;
    this.results = null;
    // Every bookmark of the filtered workspace, while one is picked.
    this.flat = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#query = new BookmarksQuery();
    this.#query.observeBookmarks(changes =>
      this.#onBookmarksChanged(changes)
    );
    // The native context menu finds its view on an ancestor of the row.
    this.#placesView = new BookmarksPlacesView();
    this.#placesView.onCutChanged = () => this.requestUpdate();
    this._placesView = this.#placesView;
    this.#drag.attach();
    const menu = document.getElementById(PLACES_CONTEXT_ID);
    menu?.addEventListener("popuphidden", this.#onMenuHidden);
    menu?.addEventListener("command", this.#onMenuCommand);
    // Open folders come back from the XUL store along with the roots.
    this.#fetchRoots();
    this.#onTagsChanged();
    for (const type of WORKSPACE_EVENTS) {
      window.addEventListener(type, this.#onWorkspacesChanged);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const type of WORKSPACE_EVENTS) {
      window.removeEventListener(type, this.#onWorkspacesChanged);
    }
    this.#filterObserver?.disconnect();
    this.#filterObserver = null;
    const menu = document.getElementById(PLACES_CONTEXT_ID);
    menu?.removeEventListener("popuphidden", this.#onMenuHidden);
    menu?.removeEventListener("command", this.#onMenuCommand);
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

  get searchPlaceholderL10nId() {
    return "library-bookmarks-search-placeholder";
  }

  get filterTitleL10nId() {
    return "library-bookmarks-filter-title";
  }

  // Filters

  get filterGroups() {
    const groups = [];
    const workspaces = WorkspaceBookmarks.getWorkspaces();
    // With a single workspace there is nothing to tell apart.
    if (workspaces.length >= 2) {
      groups.push({
        id: "workspace",
        titleL10nId: "library-bookmarks-filter-workspace",
        exclusive: true,
        options: workspaces.map(({ uuid, name }) => ({
          id: uuid,
          label: name,
        })),
      });
    }
    const tags = this.#tags;
    if (tags.length) {
      // Not exclusive: picking several shows the bookmarks with all.
      groups.push({
        id: "tags",
        titleL10nId: "library-bookmarks-filter-tags",
        options: tags.map(tag => ({ id: tag, label: tag })),
      });
    }
    return groups;
  }

  /**
   * @returns {string|null} The uuid picked in the workspace filter
   */
  #activeWorkspace() {
    const workspace = WorkspaceBookmarks.getWorkspaces().find(({ uuid }) =>
      this.isFilterActive("workspace", uuid)
    );
    return workspace?.uuid ?? null;
  }

  /**
   * @returns {{workspace: string|null, tags: string[]}|null} What the
   *   filter panel has picked, or null while nothing is picked
   */
  #filters() {
    const workspace = this.#activeWorkspace();
    const tags = [...this.activeFilters]
      .filter(key => key.startsWith("tags:"))
      .map(key => key.slice("tags:".length));
    return workspace || tags.length ? { workspace, tags } : null;
  }

  updated(changedProperties) {
    // Before the base class, which sizes the filter panel to its text.
    this.#applyStrings();
    super.updated(changedProperties);
    this.#syncFolderIcons();
    this.#watchFilterPanel();
    this.#sizeFilterPanel();
    this.#drag.playDropAnimation();
  }

  /**
   * The base class only sizes the filter panel when it opens, but its
   * options change while it is open when workspaces come and go, or wrap
   * onto another line. The size is kept in step with the content itself
   * rather than with when we happen to render.
   */
  #sizeFilterPanel = () => {
    const panel = this.querySelector(".zen-library-filter-panel-inner");
    if (this.filtersOpen && panel) {
      this.style.setProperty(
        "--zen-library-filter-height",
        `${panel.scrollHeight + 8}px`
      );
    }
  };

  #watchFilterPanel() {
    this.#filterObserver ??= new ResizeObserver(this.#sizeFilterPanel);
    this.#filterObserver.disconnect();
    const panel = this.querySelector(".zen-library-filter-panel-inner");
    if (!this.filtersOpen || !panel) {
      return;
    }
    this.#filterObserver.observe(panel);
    for (const group of panel.children) {
      this.#filterObserver.observe(group);
    }
  }

  /**
   * Redraws the filter options, and drops a pick whose workspace is gone.
   */
  #onWorkspacesChanged = () => {
    const workspaces = WorkspaceBookmarks.getWorkspaces();
    // These events also fire when merely switching workspace.
    const signature = JSON.stringify(
      workspaces.map(({ uuid, name }) => [uuid, name])
    );
    if (signature === this.#workspaceSignature) {
      return;
    }
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
    if (!this.filterGroups.length) {
      // The panel is gone, and an open one would leave the search inert.
      this.filtersOpen = false;
    }
    this.requestUpdate();
    if (dropped) {
      this.onFiltersChanged();
    }
  };

  /**
   * Reads the tags in use, redraws the tag options, and drops a picked
   * tag that no bookmark carries anymore.
   */
  async #onTagsChanged() {
    const query = this.#query;
    try {
      const meta = await query.getMeta();
      if (query !== this.#query) {
        return;
      }
      const tags = new Set();
      for (const { tags: own } of meta.values()) {
        for (const tag of own) {
          tags.add(tag);
        }
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
    if (!this.filterGroups.length) {
      // The panel is gone, and an open one would leave the search inert.
      this.filtersOpen = false;
    }
    this.requestUpdate();
    if (dropped) {
      this.onFiltersChanged();
    }
  }

  /**
   * Fills in the text of the ids from STRINGS, which Fluent has no
   * message for.
   */
  #applyStrings() {
    for (const element of this.querySelectorAll("[data-l10n-id]")) {
      const text = STRINGS[element.getAttribute("data-l10n-id")];
      if (text === undefined) {
        continue;
      }
      if (element.localName === "input") {
        element.placeholder = text;
      } else if (element.textContent !== text) {
        element.textContent = text;
      }
    }
  }

  // Reading bookmarks

  onSearchChanged() {
    this.#limit = PAGE_SIZE;
    this.#exhausted = false;
    if (this.searchQuery) {
      this.#fetchResults();
    } else {
      // Cancels a search that is still being read.
      this.#searchGeneration++;
      this.results = null;
    }
  }

  onFiltersChanged() {
    this.#limit = PAGE_SIZE;
    this.#exhausted = false;
    this.flat = null;
    this.#refreshFiltered();
  }

  /**
   * Rereads the lists that depend on the filters. Picking a workspace or
   * a tag replaces the folder tree with a flat list of the bookmarks that
   * pass.
   */
  #refreshFiltered() {
    if (this.#filters()) {
      this.#fetchFlat();
    } else {
      // Cancels a read that is still going.
      this.#flatGeneration++;
    }
    if (this.searchQuery) {
      this.#fetchResults();
    }
  }

  onListScrolledToEnd() {
    if (!this.searchQuery || !this.results || this.#exhausted) {
      return;
    }
    this.#limit += PAGE_SIZE;
    this.#fetchResults();
  }

  async #fetchRoots() {
    const query = this.#query;
    try {
      const roots = await query.getRoots();
      await this.#openStoredFolders(query, roots);
      if (query === this.#query) {
        this.roots = roots;
      }
    } catch (ex) {
      console.error("Failed to read the bookmark roots", ex);
    }
  }

  /**
   * Reads a folder, along with every folder inside it that was left open.
   *
   * @param {BookmarksQuery} query
   * @param {string} folderGuid
   * @returns {Promise<Bookmark[]>}
   */
  async #readFolder(query, folderGuid) {
    const children = await query.getChildren(folderGuid);
    await this.#openStoredFolders(query, children);
    return children;
  }

  /**
   * Opens the folders that were left open last time, like the native tree
   * does once it has built a level. Their contents are read before
   * anything is shown, so they appear open instead of animating open.
   *
   * @param {BookmarksQuery} query
   * @param {Bookmark[]} nodes
   */
  async #openStoredFolders(query, nodes) {
    const open = nodes.filter(
      node => node.type === "folder" && folderStore.isOpen(node.guid)
    );
    await Promise.all(
      open.map(async folder => {
        this.#expanded.add(folder.guid);
        if (this.#children.has(folder.guid)) {
          return;
        }
        const children = await this.#readFolder(query, folder.guid);
        if (query === this.#query) {
          this.#children.set(folder.guid, children);
        }
      })
    );
  }

  async #fetchChildren(folderGuid) {
    const query = this.#query;
    const read = {};
    this.#childrenReads.set(folderGuid, read);
    try {
      const children = await this.#readFolder(query, folderGuid);
      if (
        query === this.#query &&
        this.#childrenReads.get(folderGuid) === read
      ) {
        this.#children.set(folderGuid, children);
        this.requestUpdate();
      }
    } catch (ex) {
      console.error("Failed to read a bookmark folder", ex);
    }
  }

  async #fetchFlat() {
    const generation = ++this.#flatGeneration;
    const query = this.#query;
    try {
      const flat = await query.getFlat({ filters: this.#filters() });
      if (generation === this.#flatGeneration && query === this.#query) {
        this.flat = flat;
      }
    } catch (ex) {
      console.error("Failed to read workspace bookmarks", ex);
    }
  }

  async #fetchResults() {
    const generation = ++this.#searchGeneration;
    const query = this.#query;
    try {
      const results = await query.search(this.searchQuery, {
        limit: this.#limit,
        filters: this.#filters(),
      });
      if (generation !== this.#searchGeneration || query !== this.#query) {
        return;
      }
      this.#exhausted = results.length < this.#limit;
      this.results = results;
    } catch (ex) {
      console.error("Failed to search bookmarks", ex);
    }
  }

  /**
   * Refreshes only what is on screen: the folders that changed and are
   * already loaded, and the search results or filtered list while those
   * are shown.
   *
   * @param {{folderGuids: Set<string>, metaChanged?: boolean}} changes
   */
  #onBookmarksChanged({ folderGuids, metaChanged }) {
    if (metaChanged) {
      this.#onTagsChanged();
    }
    for (const guid of folderGuids) {
      if (this.#children.has(guid)) {
        this.#fetchChildren(guid);
      }
    }
    if (folderGuids.has(lazy.PlacesUtils.bookmarks.mobileGuid)) {
      this.#fetchRoots();
    }
    this.#refreshFiltered();
  }

  // Folders

  /**
   * Folders load their contents the first time they are opened, and
   * their state is remembered across sessions.
   *
   * @param {string} folderGuid
   */
  toggleFolder(folderGuid) {
    const open = !this.#expanded.has(folderGuid);
    if (open) {
      this.#expanded.add(folderGuid);
      if (!this.#children.has(folderGuid)) {
        this.#fetchChildren(folderGuid);
      }
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

  /**
   * Gives every folder row the native Zen folder icon and keeps its
   * open or closed state in step with the row. The artwork comes from the
   * folder element itself, so it always matches the sidebar.
   */
  #syncFolderIcons() {
    const rawIcon = customElements.get("zen-folder")?.rawIcon;
    if (!rawIcon) {
      return;
    }
    const { bookmarks } = lazy.PlacesUtils;
    const SPECIAL_FOLDER_ICONS = {
      [bookmarks.toolbarGuid]:
        "chrome://browser/skin/zen-icons/selectable/star-1.svg",
      [bookmarks.menuGuid]:
        "chrome://browser/skin/zen-icons/selectable/inbox.svg",
      [bookmarks.unfiledGuid]:
        "chrome://browser/skin/zen-icons/selectable/bookmark.svg",
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
      const guid = folderEl.querySelector(".zen-library-folder-row")
        ?.libraryItem?.guid;
      const svgImage = svg.querySelector(".icon image");
      if (svgImage) {
        svgImage.setAttribute("href", SPECIAL_FOLDER_ICONS[guid] ?? "");
      }
    }
  }

  // Opening

  /**
   * Plain clicks open a tab and close the Library. Ctrl/Cmd or middle
   * click opens a background tab and keeps it open, and Shift opens a
   * window. Keyboard activation has no event modifiers worth honoring
   * beyond those, so it takes the same path.
   *
   * @param {Bookmark} bookmark
   * @param {MouseEvent|KeyboardEvent} event
   */
  #openBookmark(bookmark, event) {
    const background =
      event.getModifierState("Accel") || event.button === 1;
    const where = event.shiftKey && !background ? "window" : "tab";
    const open = () =>
      window.openTrustedLinkIn(bookmark.url, where, {
        inBackground: background,
      });
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

  // What the drag and drop controller asks of its section

  /**
   * @returns {object|null} The Places view that backs the rows
   */
  get placesView() {
    return this.#placesView;
  }

  /**
   * @returns {Set<string>} The guids of the open folders. Changing it does
   *   not save anything, unlike `toggleFolder`.
   */
  get openFolders() {
    return this.#expanded;
  }

  /**
   * @returns {boolean} Whether rows can be dropped on. A search or filtered
   *   list is not a folder tree, and has no places to move things to.
   */
  get acceptsDrops() {
    return !this.searchQuery && !this.#filters();
  }

  /**
   * @param {string} guid - A folder or bookmark shown in the tree
   * @returns {string|null} The folder it sits in
   */
  parentOf(guid) {
    for (const list of [this.roots ?? [], ...this.#children.values()]) {
      const found = list.find(item => item.guid === guid);
      if (found) {
        return found.parentGuid;
      }
    }
    return null;
  }

  // Context menu

  /**
   * Opens the native Places context menu for a row. The menu finds the
   * view from the row, builds itself from the selection of that view and
   * runs its commands through the view's controller, exactly as it does
   * for the sidebar.
   *
   * @param {MouseEvent} event
   * @param {Bookmark} item - The row that was right clicked
   * @param {Element|null} [anchor] - The "more" button to open the menu
   *   under, or null to open it at the pointer
   */
  #onContextMenu(event, item, anchor = null) {
    const menu = document.getElementById(PLACES_CONTEXT_ID);
    const view = this.#placesView;
    if (!menu || !view) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    let node = null;
    try {
      node = view.select(item);
    } catch (ex) {
      console.error("Failed to find the Places node", ex);
    }
    const controller = view.controller;
    if (!node || !controller) {
      return;
    }

    // Native and Zen menu code read the node off the trigger element.
    const row = event.currentTarget.closest(".zen-library-row");
    row._placesNode = node;
    if (event.target !== row) {
      event.target._placesNode = node;
    }

    this.#contextRow?.removeAttribute("context-active");
    row.setAttribute("context-active", "");
    this.#contextRow = row;
    this.#menuOpen = true;
    if (anchor) {
      menu.openPopup(anchor, "after_end", 0, 4, false, false, event);
    } else {
      menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
    }
  }

  #releaseMenu() {
    this.#contextRow?.removeAttribute("context-active");
    this.#contextRow = null;
    this.#menuOpen = false;
  }

  /**
   * The menu hides before the chosen command runs, so the row stays
   * marked and selected until that has happened.
   *
   * @param {Event} event
   */
  #onMenuHidden = event => {
    if (event.target !== event.currentTarget || !this.#menuOpen) {
      return;
    }
    setTimeout(() => {
      this.#releaseMenu();
      // Cut rows dim, and are restored once pasted.
      this.requestUpdate();
    }, 0);
  };

  /**
   * Commands that open a bookmark in front of the Library close it, the
   * same as a plain click on a row does.
   *
   * @param {Event} event
   */
  #onMenuCommand = event => {
    if (!this.#menuOpen) {
      return;
    }
    const command = event.target.getAttribute?.("command");
    const inBackground = Services.prefs.getBoolPref(
      "browser.tabs.loadBookmarksInBackground",
      false
    );
    const opensInFront =
      command === "placesCmd_open" ||
      command === "placesCmd_open:window" ||
      command === "placesCmd_open:privatewindow" ||
      (command === "placesCmd_open:tab" && !inBackground);
    if (opensInFront) {
      // After the command itself, which needs the section alive.
      setTimeout(() => this.library?.constructor.toggle(), 0);
    }
  };

  // Rendering

  #renderBookmark(bookmark) {
    return html`
      <div
        class="zen-library-row"
        role="link"
        tabindex="0"
        draggable="true"
        .libraryItem=${bookmark}
        ?cutting=${this.#placesView?.isCut(bookmark)}
        ?landing=${this.#drag.landingGuid === bookmark.guid}
        @click=${event => this.#openBookmark(bookmark, event)}
        @contextmenu=${event => this.#onContextMenu(event, bookmark)}
        @keydown=${event => this.#onBookmarkKeyDown(event, bookmark)}
        @mousedown=${event => {
          // Stops middle click from starting autoscroll.
          if (event.button === 1) {
            event.preventDefault();
          }
        }}
        @auxclick=${event => {
          if (event.button === 1) {
            event.preventDefault();
            this.#openBookmark(bookmark, event);
          }
        }}
        @dragstart=${event => this.#drag.start(event, bookmark)}
      >
        <img
          class="zen-library-row-icon"
          src="page-icon:${bookmark.url}"
          alt=""
        />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title"
            >${bookmark.title || bookmark.url}</span
          >
          <span class="zen-library-row-subtitle"
            >${formatUrl(bookmark.url)}</span
          >
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1"
            data-l10n-id="library-downloads-more-button"
            @click=${event => {
              event.stopPropagation();
              this.#onContextMenu(event, bookmark, event.currentTarget);
            }}
            @auxclick=${event => event.stopPropagation()}
          >
            <img
              class="toolbarbutton-icon"
              src="chrome://global/skin/icons/more.svg"
              alt=""
            />
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
        <div
          class="zen-library-row zen-library-folder-row"
          role="button"
          tabindex="0"
          aria-expanded=${open}
          draggable=${this.#drag.isDraggable(folder) ? "true" : "false"}
          .libraryItem=${folder}
          ?cutting=${this.#placesView?.isCut(folder)}
          ?landing=${this.#drag.landingGuid === folder.guid}
          @contextmenu=${event => this.#onContextMenu(event, folder)}
          @dragstart=${event => this.#drag.start(event, folder)}
          @click=${() => this.toggleFolder(folder.guid)}
          @keydown=${event => this.#onFolderKeyDown(event, folder.guid)}
        >
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
    return repeat(
      nodes,
      node => node.guid,
      node => {
        switch (node.type) {
          case "folder":
            return this.#renderFolder(node);
          case "separator":
            return html`<div
              class="zen-library-row zen-library-separator"
              role="separator"
              draggable="true"
              .libraryItem=${node}
              ?cutting=${this.#placesView?.isCut(node)}
              ?landing=${this.#drag.landingGuid === node.guid}
              @contextmenu=${event => this.#onContextMenu(event, node)}
              @dragstart=${event => this.#drag.start(event, node)}
            ></div>`;
          default:
            return this.#renderBookmark(node);
        }
      }
    );
  }

  #renderEmpty() {
    return html`
      <div class="zen-library-empty">
        ${STRINGS["library-bookmarks-empty"]}
      </div>
    `;
  }

  renderItems() {
    let nodes = this.roots;
    if (this.searchQuery) {
      nodes = this.results;
    } else if (this.#filters()) {
      nodes = this.flat;
    }
    if (!nodes) {
      return null;
    }
    if (!nodes.length) {
      return this.#renderEmpty();
    }
    return html`
      <div class="zen-library-group">${this.#renderNodes(nodes)}</div>
    `;
  }
}

customElements.define(
  "zen-library-bookmarks-section",
  ZenLibraryBookmarksSection
);
