// ==UserScript==
// @name            LibraryTweaks
// @description     Tweaks for the Zen Library
// @version         v1.0
// @author          JustAdumbPrsn
// @include         main
// ==/UserScript==

/**
 * Adds sections to the native Zen Library without copying or patching any of
 * its code. Each entry of `SECTIONS` is added to every Library as it is
 * created, so it behaves like the native ones. Styling is in LibraryTweaks.css.
 *
 * Right clicking a row opens the Places context menu of the Ctrl+B sidebar.
 * `BookmarksPlacesView` lets the native PlacesController drive it, so every
 * command is the native one.
 */

(() => {
  "use strict";

  if (window.gLibraryTweaks) {
    return;
  }

  const LOG_PREFIX = "[LibraryTweaks]";
  const LIBRARY_ELEMENT = "zen-library";
  const LAST_TAB_PREF = "zen.library.last-tab";
  const LIT_URL = "chrome://global/content/vendor/lit.all.mjs";
  const SEARCH_SECTION_URL =
    "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
  const PLACES_CONTEXT_ID = "placesContext";
  const PLACES_CONTROLLER_URL =
    "chrome://browser/content/places/controller.js";
  // The bookmarks sidebar (Ctrl+B) keeps which folders are open under its own
  // document. Reading and writing the same entries makes the Library and the
  // sidebar show one arrangement, kept across restarts like the sidebar's.
  const BOOKMARKS_SIDEBAR_URI =
    "chrome://browser/content/places/bookmarksSidebar.xhtml";
  // What Ctrl+B and the Bookmarks menu ask the sidebar controller to toggle.
  const BOOKMARKS_SIDEBAR_COMMAND = "viewBookmarksSidebar";
  const LIBRARY_ENABLED_PREF = "zen.library.enabled";
  const BOOKMARKS_SECTION_ID = "bookmarks";
  const HISTORY_SECTION_URL =
    "moz-src:///zen/library/sections/ZenLibraryHistorySection.mjs";
  // Session store tells this when the closed tabs or windows lists change.
  const CLOSED_OBJECTS_TOPIC = "sessionstore-closed-objects-changed";
  // What the native recently closed menu reads to decide whose tabs it lists.
  const CLOSED_FROM_ALL_WINDOWS_PREF =
    "browser.sessionstore.closedTabsFromAllWindows";
  const CLOSED_FROM_CLOSED_WINDOWS_PREF =
    "browser.sessionstore.closedTabsFromClosedWindows";
  // How long a drag has to rest on a closed folder before it opens, like the
  // native tree.
  const DRAG_OPEN_DELAY_MS = 600;
  // The tab strip's thresholds, which the rows follow so that dropping feels
  // the same in both.
  const FOLDER_DRAGOVER_PREF = "zen.tabs.folder-dragover-threshold-percent";
  const MOVE_OVER_PREF = "browser.tabs.dragDrop.moveOverThresholdPercent";

  const lazy = {};

  // Loaded into the window global, like the native sections do, so that the
  // classes are shared with Zen rather than duplicated.
  ChromeUtils.defineLazyGetter(lazy, "lit", () =>
    ChromeUtils.importESModule(LIT_URL, { global: "current" })
  );
  ChromeUtils.defineLazyGetter(lazy, "searchSection", () =>
    ChromeUtils.importESModule(SEARCH_SECTION_URL, { global: "current" })
  );
  ChromeUtils.defineLazyGetter(lazy, "historySection", () =>
    ChromeUtils.importESModule(HISTORY_SECTION_URL, { global: "current" })
  );
  // The service Zen's tab drag and drop uses to shape the drag image: its
  // opacity, and on macOS where it lands once dropped.
  ChromeUtils.defineLazyGetter(lazy, "zenDnD", () => {
    try {
      return Cc["@mozilla.org/zen/drag-and-drop;1"].getService(
        Ci.nsIZenDragAndDrop
      );
    } catch (ex) {
      // Without it the OS draws its own translucent drag image.
      console.warn(LOG_PREFIX, "Zen's drag and drop service is missing", ex);
      return null;
    }
  });
  ChromeUtils.defineESModuleGetters(lazy, {
    PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
    PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    SessionWindowUI:
      "moz-src:///browser/components/sessionstore/SessionWindowUI.sys.mjs",
  });

  // Bookmarks backend

  // Only the events that change what a row shows or where it sits, plus the
  // two that change the tags and keywords the filter and search read.
  // Timestamps and guid changes are left out until a view needs them.
  const BOOKMARK_EVENTS = [
    "bookmark-added",
    "bookmark-removed",
    "bookmark-moved",
    "bookmark-title-changed",
    "bookmark-url-changed",
    "bookmark-tags-changed",
    "bookmark-keyword-changed",
  ];
  const META_EVENTS = new Set([
    "bookmark-tags-changed",
    "bookmark-keyword-changed",
  ]);
  const OBSERVER_DEBOUNCE_MS = 100;
  // Zen notifies this when bookmark to workspace assignments change.
  const WORKSPACE_BOOKMARKS_TOPIC = "workspace-bookmarks-updated";

  /**
   * @typedef {object} Bookmark
   * @property {string} guid
   * @property {string} parentGuid - Empty for the Places root
   * @property {number} index - Position inside the parent folder
   * @property {"bookmark"|"folder"|"separator"} type
   * @property {string} title
   * @property {string} url - Empty for folders and separators
   * @property {Date} dateAdded
   * @property {Date} lastModified
   * @property {number} childCount - Direct children, for folders only
   */

  /**
   * @param {number} type - A PlacesUtils.bookmarks.TYPE_* constant
   * @returns {"bookmark"|"folder"|"separator"} The readable name of the type
   */
  function bookmarkKind(type) {
    const { bookmarks } = lazy.PlacesUtils;
    switch (type) {
      case bookmarks.TYPE_FOLDER:
        return "folder";
      case bookmarks.TYPE_SEPARATOR:
        return "separator";
      default:
        return "bookmark";
    }
  }

  /**
   * Converts a Places bookmark item to the plain object the Library works
   * with, which carries the url as a string like a History visit does.
   *
   * @param {object} item - An item from PlacesUtils.bookmarks
   * @returns {Bookmark} The converted bookmark
   */
  function toBookmark(item) {
    return {
      guid: item.guid,
      parentGuid: item.parentGuid ?? "",
      index: item.index,
      type: bookmarkKind(item.type),
      // Root folders are stored under a plain name, not the localized one.
      title: lazy.PlacesUtils.bookmarks.getLocalizedTitle(item) || "",
      url: item.url?.href ?? "",
      dateAdded: item.dateAdded,
      lastModified: item.lastModified,
      childCount: item.childCount ?? 0,
    };
  }

  /**
   * Zen lets a bookmark be assigned to any number of workspaces. A bookmark is
   * hidden from a workspace only when it is assigned to other workspaces and
   * not to that one, so an unassigned bookmark shows everywhere. This is the
   * same rule as `gZenWorkspaces.isBookmarkInAnotherWorkspace`, which can only
   * answer for the active workspace.
   *
   * The assignments live in Zen's own storage, not in Places. If Zen's
   * workspace globals are not reachable, `getWorkspaces` is empty and the
   * Library simply offers no workspace filter.
   */
  const WorkspaceBookmarks = {
    /**
     * @returns {{uuid: string, name: string}[]} The workspaces to filter by
     */
    getWorkspaces() {
      if (!window.gZenWorkspaces || !window.ZenWorkspaceBookmarksStorage) {
        return [];
      }
      return window.gZenWorkspaces
        .getWorkspaces()
        .map(({ uuid, name }) => ({ uuid, name }));
    },

    /**
     * Reads every assignment at once, which is how Zen's own bookmark menus
     * read them.
     *
     * @returns {Promise<Map<string, Set<string>>>} The workspace uuids of
     *   each assigned bookmark, by bookmark guid
     */
    async getAssignments() {
      const assignments = new Map();
      try {
        const byWorkspace =
          await window.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace();
        for (const [uuid, guids] of Object.entries(byWorkspace)) {
          for (const guid of guids) {
            if (!assignments.has(guid)) {
              assignments.set(guid, new Set());
            }
            assignments.get(guid).add(uuid);
          }
        }
      } catch (ex) {
        console.error(LOG_PREFIX, "Failed to read bookmark workspaces", ex);
      }
      return assignments;
    },

    /**
     * @param {Set<string>|undefined} assigned - Workspaces of a bookmark
     * @param {string} uuid - The workspace being viewed
     * @returns {boolean} Whether the bookmark belongs in that workspace
     */
    isShownIn(assigned, uuid) {
      return !assigned?.size || assigned.has(uuid);
    },
  };

  /**
   * Tags and keywords belong to a url, not to a bookmark: two bookmarks of the
   * same page share them, and a keyword opens exactly one url. They are read
   * the way Places stores them, in one pass each, into a map by url.
   */
  const BookmarkMeta = {
    /**
     * @returns {Promise<Map<string, {tags: string[], keyword: string|null}>>}
     */
    async load() {
      const meta = new Map();
      const entry = url => {
        let found = meta.get(url);
        if (!found) {
          meta.set(url, (found = { tags: [], keyword: null }));
        }
        return found;
      };
      try {
        const db = await lazy.PlacesUtils.promiseDBConnection();
        // A tag is a folder under a hidden root, holding one bookmark per url.
        const tagRows = await db.executeCached(
          `SELECT t.title AS tag, h.url AS url
             FROM moz_bookmarks b
             JOIN moz_bookmarks t ON t.id = b.parent
             JOIN moz_bookmarks r ON r.id = t.parent
             JOIN moz_places h ON h.id = b.fk
            WHERE r.guid = :tagsGuid`,
          { tagsGuid: lazy.PlacesUtils.bookmarks.tagsGuid }
        );
        for (const row of tagRows) {
          entry(row.getResultByName("url")).tags.push(
            row.getResultByName("tag")
          );
        }
        const keywordRows = await db.executeCached(
          `SELECT k.keyword AS keyword, h.url AS url
             FROM moz_keywords k
             JOIN moz_places h ON h.id = k.place_id`
        );
        for (const row of keywordRows) {
          entry(row.getResultByName("url")).keyword =
            row.getResultByName("keyword");
        }
      } catch (ex) {
        console.error(LOG_PREFIX, "Failed to read tags and keywords", ex);
      }
      return meta;
    },
  };

  /**
   * Which folders are open is remembered the way the native bookmarks tree
   * remembers it: in the XUL store, keyed by the obfuscated place: url of the
   * folder, under the document of the bookmarks sidebar so that the two share
   * their state.
   */
  const folderStore = {
    id: guid =>
      lazy.PlacesUIUtils.obfuscateUrlForXulStore(`place:parent=${guid}`),

    isOpen(guid) {
      return (
        Services.xulStore.getValue(
          BOOKMARKS_SIDEBAR_URI,
          this.id(guid),
          "open"
        ) === "true"
      );
    },

    setOpen(guid, open) {
      if (open) {
        Services.xulStore.setValue(
          BOOKMARKS_SIDEBAR_URI,
          this.id(guid),
          "open",
          "true"
        );
      } else {
        Services.xulStore.removeValue(
          BOOKMARKS_SIDEBAR_URI,
          this.id(guid),
          "open"
        );
      }
    },
  };

  // Places integration

  /**
   * @returns {Function|null} The native PlacesController class, which the
   *   sidebar and the toolbar use to run the commands of the context menu
   */
  function getPlacesControllerClass() {
    if (typeof PlacesController === "undefined") {
      try {
        Services.scriptloader.loadSubScript(PLACES_CONTROLLER_URL, window);
      } catch (ex) {
        console.error(LOG_PREFIX, "Failed to load PlacesController", ex);
      }
    }
    return typeof PlacesController === "undefined" ? null : PlacesController;
  }

  /**
   * @returns {object|null} The native PlacesControllerDragHelper, which
   *   decides what may be dropped where and performs the drop
   */
  function getPlacesDragHelper() {
    getPlacesControllerClass();
    return typeof PlacesControllerDragHelper === "undefined"
      ? null
      : PlacesControllerDragHelper;
  }

  /**
   * A place in a folder, as the native commands and drops describe one.
   *
   * @param {string} guid - The folder
   * @param {number} index - The position in it
   * @returns {object}
   */
  function makeInsertionPoint(guid, index) {
    return {
      guid,
      index,
      isTag: false,
      tagName: null,
      orientation: Ci.nsITreeView.DROP_ON,
      getIndex: async () => index,
    };
  }

  /**
   * Lets the native Places context menu and PlacesController work on the
   * Library rows. They only ever talk to a "view", which the sidebar tree and
   * the bookmark menus implement, so this implements that same contract
   * (the one of PlacesViewBase) for a Library row:
   *
   * - `PlacesUIUtils.placesContextShowing` finds the view from the node that
   *   was right clicked and calls `buildContextMenu`, which has the
   *   controller show only the items that apply to the selection.
   * - Commands are routed by `PlacesUIUtils.getControllerForCommand`, which
   *   asks the view with the open menu for its `controllers`.
   *
   * A row is a plain object here, so it is looked up as the real
   * nsINavHistoryResultNode of its parent folder, which is what the native
   * commands expect. Those folder results are live, and are released by
   * `close`.
   */
  class BookmarksPlacesView {
    #results = new Map();
    #node = null;
    #index = 0;
    #controller = null;
    #cutting = new Set();

    // Called when a row is cut or pasted, so that it can be drawn again.
    onCutChanged = null;

    // Set while the context menu is up, which is when the commands of the
    // window are routed to this view.
    _contextMenuShown = false;

    // Read by the controller and the context menu.
    isContextMenu = true;
    flatList = false;
    singleClickOpens = true;

    get ownerWindow() {
      return window;
    }

    get ownerDocument() {
      return document;
    }

    get controller() {
      if (!this.#controller) {
        const Controller = getPlacesControllerClass();
        this.#controller = Controller ? new Controller(this) : null;
      }
      return this.#controller;
    }

    get selectedNode() {
      return this.#node;
    }

    get selectedNodes() {
      return this.#node ? [this.#node] : [];
    }

    /**
     * What `PlacesUIUtils.getControllerForCommand` asks the view with an open
     * context menu for. The sidebar and the menus hand out the controllers
     * of their element, this hands out the one controller.
     */
    get controllers() {
      return {
        getControllerForCommand: command => {
          const controller = this.controller;
          return controller?.supportsCommand(command) ? controller : null;
        },
      };
    }

    /**
     * The selection as the ranges the controller removes, which for a
     * single item view is the one item.
     */
    get removableSelectionRanges() {
      return this.#node ? [this.selectedNodes] : [];
    }

    get hasSelection() {
      return !!this.#node;
    }

    get draggableSelection() {
      return this.selectedNodes;
    }

    /**
     * The result of the selected row. A drop from another window has no
     * selection, and the native drop still wants a result to batch on.
     */
    get result() {
      if (this.#node) {
        return this.#node.parentResult ?? null;
      }
      const guid = lazy.PlacesUtils.bookmarks.menuGuid;
      if (!this.#results.has(guid)) {
        const result = lazy.PlacesUtils.getFolderContents(guid);
        if (result) {
          this.#results.set(guid, result);
        }
      }
      return this.#results.get(guid) ?? null;
    }

    /**
     * Paste and New Folder land inside a selected folder, and right after
     * any other item, like they do in the sidebar.
     *
     * @returns {object|null}
     */
    get insertionPoint() {
      const node = this.#node;
      if (!node) {
        return null;
      }
      const { bookmarks } = lazy.PlacesUtils;
      const inside = lazy.PlacesUtils.nodeIsFolderOrShortcut(node);
      const guid = inside ? node.bookmarkGuid : node.parent?.bookmarkGuid;
      const index = inside ? bookmarks.DEFAULT_INDEX : this.#index + 1;
      return makeInsertionPoint(guid, index);
    }

    /**
     * Called by `PlacesUIUtils.placesContextShowing`. The controller hides
     * every item that does not apply to the selected row, and the commands
     * are brought up to date for it.
     *
     * @param {Element} popup - The Places context menu
     * @returns {boolean} Whether the menu should be shown
     */
    buildContextMenu(popup) {
      this._contextMenuShown = true;
      window.updateCommands?.("places");
      return this.controller.buildContextMenu(popup);
    }

    /**
     * Called when the menu hides. The chosen command runs around the same
     * time, so the view stays the target of commands a moment longer.
     */
    destroyContextMenu() {
      setTimeout(() => {
        this._contextMenuShown = false;
      }, 0);
    }

    // The Library draws its own selection, so there is nothing to move.
    selectItems() {}
    selectAll() {}
    selectPlaceURI() {}
    focus() {}

    /**
     * Makes a row the selection of the view.
     *
     * @param {Bookmark} item - The row that was right clicked
     * @returns {object|null} Its Places node, if it still exists
     */
    select({ guid, parentGuid, index }) {
      this.#node = this.#find(parentGuid, guid);
      this.#index = index ?? 0;
      return this.#node;
    }

    /**
     * Called by the controller when Cut picks a row up, and again when it is
     * pasted or the cut is given up. This is the same call it makes on the
     * sidebar tree, which dims and restores its rows from it.
     *
     * @param {object} node - The Places node
     * @param {boolean} cutting - Whether the row is now cut
     */
    toggleCutNode(node, cutting) {
      const { bookmarkGuid } = node;
      if (this.#cutting.has(bookmarkGuid) === !!cutting) {
        return;
      }
      if (cutting) {
        this.#cutting.add(bookmarkGuid);
      } else {
        this.#cutting.delete(bookmarkGuid);
      }
      this.onCutChanged?.();
    }

    /**
     * @param {Bookmark} item
     * @returns {boolean} Whether the row is cut and not pasted yet
     */
    isCut({ guid }) {
      return this.#cutting.has(guid);
    }

    #find(parentGuid, guid) {
      let result = this.#results.get(parentGuid);
      if (!result) {
        result = lazy.PlacesUtils.getFolderContents(parentGuid);
        if (!result) {
          return null;
        }
        this.#results.set(parentGuid, result);
      }
      const { root } = result;
      for (let i = 0; i < root.childCount; i++) {
        const child = root.getChild(i);
        if (child.bookmarkGuid === guid) {
          return child;
        }
      }
      return null;
    }

    /**
     * The live Places node of a folder, which is what the native drop checks
     * compare a dragged folder with.
     *
     * @param {string} guid - The folder
     * @returns {object|null} Its result root, if the folder still exists
     */
    folderNode(guid) {
      let result = this.#results.get(guid);
      if (!result) {
        result = lazy.PlacesUtils.getFolderContents(guid);
        if (!result) {
          return null;
        }
        this.#results.set(guid, result);
      }
      return result.root;
    }

    /**
     * Releases the folder results, which observe Places while they are open.
     */
    close() {
      for (const result of this.#results.values()) {
        try {
          result.root.containerOpen = false;
        } catch (ex) {
          // Already closed by Places.
        }
      }
      this.#results.clear();
      this.#cutting.clear();
      this.#node = null;
      this.#controller = null;
    }
  }

  /**
   * Reads and watches bookmarks for the Library. This is the counterpart of
   * the PlacesQuery that the History section uses, which has no bookmarks
   * equivalent. Folders are read one at a time, because Places cannot hand
   * out the whole tree (`fetchTree` is not implemented).
   *
   * Nothing is registered until `observeBookmarks` is called, and `close`
   * releases it again, so an unused query costs nothing.
   */
  class BookmarksQuery {
    #callback = null;
    #folderGuids = new Set();
    #debounce = null;
    // Read on first use, and again after Zen reports a change.
    #assignments = null;
    // Tags and keywords by url, read on first use and after they change.
    #meta = null;
    #metaChanged = false;

    /**
     * Starts reporting bookmark changes. Changes that arrive close together
     * are reported once, so an import does not cause a refresh per bookmark.
     *
     * @param {function({folderGuids: Set<string>,
     *   workspaceBookmarks: boolean, metaChanged: boolean}): void} callback -
     *   Called with the guids of the folders whose contents changed, with
     *   `workspaceBookmarks` set when the workspace assignments changed, or
     *   with `metaChanged` set when tags or keywords changed
     */
    observeBookmarks(callback) {
      if (!this.#callback) {
        lazy.PlacesUtils.observers.addListener(
          BOOKMARK_EVENTS,
          this.#onEvents
        );
        Services.obs.addObserver(
          this.#onWorkspaceBookmarks,
          WORKSPACE_BOOKMARKS_TOPIC
        );
      }
      this.#callback = callback;
    }

    /**
     * Stops observing and drops anything still waiting to be reported.
     */
    close() {
      if (this.#callback) {
        lazy.PlacesUtils.observers.removeListener(
          BOOKMARK_EVENTS,
          this.#onEvents
        );
        Services.obs.removeObserver(
          this.#onWorkspaceBookmarks,
          WORKSPACE_BOOKMARKS_TOPIC
        );
      }
      this.#callback = null;
      clearTimeout(this.#debounce);
      this.#debounce = null;
      this.#folderGuids = new Set();
      this.#assignments = null;
      this.#meta = null;
      this.#metaChanged = false;
    }

    /**
     * @returns {Promise<Map<string, {tags: string[], keyword: string|null}>>}
     *   The tags and keyword of each bookmarked url
     */
    getMeta() {
      return (this.#meta ??= BookmarkMeta.load());
    }

    #onWorkspaceBookmarks = () => {
      this.#assignments = null;
      this.#callback?.({ folderGuids: new Set(), workspaceBookmarks: true });
    };

    /**
     * Places lists changes in batches. The first one starts a short timer and
     * the rest join it, so the callback never waits longer than the delay.
     *
     * @param {object[]} events - The Places bookmark events
     */
    #onEvents = events => {
      for (const event of events) {
        if (META_EVENTS.has(event.type)) {
          // Dropped right away, so a read before the report is not stale.
          this.#meta = null;
          this.#metaChanged = true;
          continue;
        }
        // Tags are bookmarks under a hidden root, not ones the user sees.
        if (event.isTagging) {
          continue;
        }
        for (const guid of [event.parentGuid, event.oldParentGuid]) {
          if (guid) {
            this.#folderGuids.add(guid);
          }
        }
      }
      if ((!this.#folderGuids.size && !this.#metaChanged) || this.#debounce) {
        return;
      }
      this.#debounce = setTimeout(() => {
        this.#debounce = null;
        const folderGuids = this.#folderGuids;
        const metaChanged = this.#metaChanged;
        this.#folderGuids = new Set();
        this.#metaChanged = false;
        this.#callback?.({
          folderGuids,
          workspaceBookmarks: false,
          metaChanged,
        });
      }, OBSERVER_DEBOUNCE_MS);
    };

    /**
     * Keeps the bookmarks that pass the filters: they belong in the workspace,
     * and carry every picked tag. Folders and separators have neither and
     * always stay.
     *
     * @param {Bookmark[]} items
     * @param {{workspace: string|null, tags: string[]}|null} filters - The
     *   workspace uuid and tags to require, or null to keep everything
     * @returns {Promise<Bookmark[]>}
     */
    async #inFilters(items, filters) {
      if (!filters) {
        return items;
      }
      const { workspace, tags } = filters;
      if (workspace) {
        this.#assignments ??= WorkspaceBookmarks.getAssignments();
      }
      const [assignments, meta] = await Promise.all([
        workspace ? this.#assignments : null,
        tags.length ? this.getMeta() : null,
      ]);
      return items.filter(item => {
        if (item.type !== "bookmark") {
          return true;
        }
        if (
          assignments &&
          !WorkspaceBookmarks.isShownIn(assignments.get(item.guid), workspace)
        ) {
          return false;
        }
        if (meta) {
          const own = meta.get(item.url)?.tags;
          return !!own && tags.every(tag => own.includes(tag));
        }
        return true;
      });
    }

    /**
     * Gets the top level folders, which hold all other bookmarks.
     *
     * @returns {Promise<Bookmark[]>} The roots, in the order Places lists them
     */
    async getRoots() {
      const { bookmarks } = lazy.PlacesUtils;
      const roots = await Promise.all(
        bookmarks.userContentRoots.map(guid =>
          bookmarks.fetch(guid, null, { concurrent: true })
        )
      );
      // Mobile Bookmarks stays hidden until something is synced into it.
      return roots
        .filter(
          root =>
            root && (root.guid !== bookmarks.mobileGuid || root.childCount)
        )
        .map(toBookmark);
    }

    /**
     * Gets what a folder contains, separators included.
     *
     * @param {string} folderGuid - The folder to read
     * @param {{filters?: object|null}} [options] - The filters the bookmarks
     *   must pass, as `#inFilters` takes them
     * @returns {Promise<Bookmark[]>} The children in folder order
     */
    async getChildren(folderGuid, { filters = null } = {}) {
      const children = [];
      // Without a callback, fetch resolves to the first child only.
      await lazy.PlacesUtils.bookmarks.fetch(
        { parentGuid: folderGuid },
        child => children.push(toBookmark(child)),
        { concurrent: true }
      );
      return this.#inFilters(children, filters);
    }

    /**
     * Gets every bookmark that passes the filters, with the folders
     * flattened away. They come in the order a fully opened tree would list
     * them.
     *
     * @param {{filters: object}} options - The filters the bookmarks must pass
     * @returns {Promise<Bookmark[]>}
     */
    async getFlat({ filters }) {
      const flatten = async folderGuid => {
        const children = await this.getChildren(folderGuid, { filters });
        const parts = await Promise.all(
          children.map(child => {
            if (child.type === "folder") {
              return flatten(child.guid);
            }
            return child.type === "bookmark" ? [child] : [];
          })
        );
        return parts.flat();
      };
      const roots = await this.getRoots();
      const parts = await Promise.all(roots.map(root => flatten(root.guid)));
      return parts.flat();
    }

    /**
     * Gets the most recently added bookmarks. Folders and separators are not
     * included.
     *
     * @param {number} [limit] - The most to return
     * @returns {Promise<Bookmark[]>} The bookmarks, newest first
     */
    async getRecent(limit = lazy.searchSection.PAGE_SIZE) {
      const items = await lazy.PlacesUtils.bookmarks.getRecent(limit);
      return items.map(toBookmark);
    }

    /**
     * Searches bookmark titles, urls and tags, like the Library bar does, and
     * keywords, like the address bar does: a bookmark whose keyword is the
     * first word typed comes first. Only bookmarks are returned, since folders
     * and separators have nothing to open.
     *
     * @param {string} query - The text to look for
     * @param {{limit?: number, filters?: object|null}} [options] - The most
     *   to return, and the filters the bookmarks must pass
     * @returns {Promise<Bookmark[]>} The matches, keyword first and then the
     *   most recently changed
     */
    async search(
      query,
      { limit = lazy.searchSection.PAGE_SIZE, filters = null } = {}
    ) {
      if (!query) {
        return [];
      }
      const { bookmarks } = lazy.PlacesUtils;
      const text = query.toLowerCase();
      const keyword = text.split(/\s+/)[0];
      const meta = await this.getMeta();
      const keywordUrls = [];
      const tagUrls = [];
      for (const [url, { tags, keyword: own }] of meta) {
        if (own === keyword) {
          keywordUrls.push(url);
        } else if (tags.some(tag => tag.toLowerCase().includes(text))) {
          tagUrls.push(url);
        }
      }
      const withUrls = urls =>
        Promise.all(urls.map(url => bookmarks.search({ url }).catch(() => [])));
      const [found, byKeyword, byTag] = await Promise.all([
        bookmarks.search(query),
        withUrls(keywordUrls),
        withUrls(tagUrls),
      ]);
      // Places has no way to limit or order a search, so it is done here.
      const rest = [...found, ...byTag.flat()].sort(
        (a, b) => b.lastModified - a.lastModified
      );
      const seen = new Set();
      const sorted = [];
      for (const item of [...byKeyword.flat(), ...rest]) {
        if (item.type === bookmarks.TYPE_BOOKMARK && !seen.has(item.guid)) {
          seen.add(item.guid);
          sorted.push(toBookmark(item));
        }
      }
      // Filtering can drop matches, so keep reading until the page is full.
      const matches = [];
      for (let i = 0; i < sorted.length && matches.length < limit; i += limit) {
        matches.push(
          ...(await this.#inFilters(sorted.slice(i, i + limit), filters))
        );
      }
      return matches.slice(0, limit);
    }
  }

  /**
   * English text for the ids used by this mod. A userChrome script cannot
   * register a Fluent resource, so the text is applied directly instead.
   * Ids the native Library already translates, like its filter button, are
   * left to Fluent.
   */
  const STRINGS = {
    "library-bookmarks-section-title": "Bookmarks",
    "library-bookmarks-search-placeholder": "Search bookmarks",
    "library-bookmarks-empty": "No bookmarks to show",
    "library-bookmarks-filter-title": "Filter bookmarks",
    "library-bookmarks-filter-workspace": "Workspace",
    "library-bookmarks-filter-tags": "Tags",
    "library-history-closed-tabs": "Recently closed tabs",
    "library-history-clear": "Clear recent history\u2026",
    "library-history-closed-tabs-empty": "No recently closed tabs",
    "library-history-back": "Back to history",
  };

  /**
   * @param {string} url
   * @returns {string} The url without its scheme, "www." and trailing slash
   */
  function formatUrl(url) {
    return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  }

  // Zen fires these when workspaces are added, removed, renamed or changed.
  // The first comes before its cache is updated, the second after.
  const WORKSPACE_EVENTS = ["ZenWorkspaceDataChanged", "ZenWorkspacesUIUpdate"];

  let bookmarksSection = null;

  // Bookmarks section

  /**
   * Creates the Bookmarks section class the first time it is needed, since
   * its base class is only worth loading once the Library exists.
   *
   * @returns {Function} The section class
   */
  function getBookmarksSection() {
    if (bookmarksSection) {
      return bookmarksSection;
    }

    const { html, repeat } = lazy.lit;
    const { PAGE_SIZE, ZenLibrarySearchSection } = lazy.searchSection;

    class ZenLibraryBookmarksSection extends ZenLibrarySearchSection {
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
      #dropRow = null;
      #dropKey = null;
      #indicator = null;
      #indicatorOrigin = null;
      #dropBackground = null;
      #dropBackgroundOrigin = null;
      #dragOpenGuid = null;
      #dragOpenTimer = null;
      #dragItem = null;
      #dragSize = null;
      #dragImage = null;
      #hapticReady = false;
      #landingWanted = false;
      #landingGuid = null;

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
        for (const [type, listener] of this.#dropListeners) {
          this.addEventListener(type, listener);
        }
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
        for (const [type, listener] of this.#dropListeners) {
          this.removeEventListener(type, listener);
        }
        this.#endDrag();
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
          console.error(LOG_PREFIX, "Failed to read the tags", ex);
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
          console.error(LOG_PREFIX, "Failed to read the bookmark roots", ex);
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
          console.error(LOG_PREFIX, "Failed to read a bookmark folder", ex);
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
          console.error(LOG_PREFIX, "Failed to read workspace bookmarks", ex);
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
          console.error(LOG_PREFIX, "Failed to search bookmarks", ex);
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
      #toggleFolder(folderGuid) {
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
          this.#toggleFolder(folderGuid);
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

      // Drag and drop

      /**
       * Rows drag with the data the native tree gives them, so they can be
       * dropped onto the toolbar, the sidebar, content, the tab strip or
       * another app, and reordered here. Top level folders are the Places
       * roots and stay where they are.
       *
       * @param {DragEvent} event
       * @param {Bookmark} item
       */
      #onDragStart(event, item) {
        event.stopPropagation();
        const view = this.#placesView;
        const { dataTransfer } = event;

        let node = null;
        try {
          node = view?.select(item);
        } catch (ex) {
          console.error(LOG_PREFIX, "Failed to find the Places node", ex);
        }
        const controller = view?.controller;
        if (node && controller) {
          // Read by setDataTransfer, which decides on copying from it.
          dataTransfer.effectAllowed = "copyMove";
          controller.setDataTransfer(event);
        } else if (item.type === "bookmark") {
          const title = item.title || item.url;
          dataTransfer.setData("text/x-moz-url", `${item.url}\n${title}`);
          dataTransfer.setData("text/uri-list", item.url);
          dataTransfer.setData("text/plain", item.url);
          dataTransfer.effectAllowed = "copyLink";
        } else {
          event.preventDefault();
          return;
        }
        this.#beginDrag(event, item);
      }

      /**
       * Gives the drag what Zen gives a dragged tab: an image of the row at
       * full strength, a tap of haptic feedback, and on macOS a drag image
       * that slides onto the dropped row instead of vanishing.
       *
       * @param {DragEvent} event
       * @param {Bookmark} item
       */
      #beginDrag(event, item) {
        // A drag that never reported its end must not leak into this one.
        this.#endDrag();
        const source = event.currentTarget;
        const rect = source.getBoundingClientRect();
        this.#dragItem = item;
        this.#dragSize = { width: rect.width, height: rect.height };

        lazy.zenDnD?.onDragStart(1);
        this.#landingWanted =
          typeof AppConstants !== "undefined" &&
          AppConstants.platform === "macosx" &&
          !(typeof gReduceMotion !== "undefined" && gReduceMotion);
        lazy.zenDnD?.armDropLanding(this.#landingWanted);

        this.#dragImage = this.#createDragImage(source);
        event.dataTransfer.setDragImage(
          this.#dragImage,
          event.clientX - rect.left,
          event.clientY - rect.top
        );
        // The row can be gone by then, if the drop moved it to another
        // folder, and the end of the drag is only ever told to the row.
        source.addEventListener("dragend", () => this.#endDrag(), {
          once: true,
        });
        // eslint-disable-next-line mozilla/valid-services
        Services.zen.playHapticFeedback();
      }

      /**
       * A copy of the row held off screen, like the clone of a tab that
       * Zen drags, so the image is clean of hover and menu states.
       *
       * @param {Element} source
       * @returns {Element} The wrapper to hand to setDragImage
       */
      #createDragImage(source) {
        const { width, height } = source.getBoundingClientRect();
        const wrapper = document.createElement("div");
        wrapper.style.cssText = `
          position: fixed;
          top: -9999px;
          width: ${width}px;
          height: ${height}px;
        `;
        // Outside the Library, so what the image inherits from it is set here.
        const computed = getComputedStyle(source);
        wrapper.style.color = computed.color;
        wrapper.style.colorScheme = computed.colorScheme;
        wrapper.style.fontWeight = computed.fontWeight;
        const clone = source.cloneNode(true);
        for (const attribute of ["cutting", "context-active", "drop-zone"]) {
          clone.removeAttribute(attribute);
        }
        clone.querySelector(".zen-library-drop-indicator")?.remove();
        if (Services.appinfo.OS === "WINNT") {
          // Windows adds its own translucency to a drag image, which Zen's
          // opacity cannot turn off there (only the GTK and macOS builds read
          // it). Zen forces a light scheme on the tab it drags, so that the
          // image is mostly opaque. Folder rows get it too, since they are
          // drawn like any other row here.
          clone.style.colorScheme = "light";
          clone.style.color = "black";
        }
        clone.setAttribute("drag-image", "true");
        wrapper.append(clone);
        // Zen builds its tab's image in the plain tab strip. The Library has
        // paint containment, and the rows of this section skip painting while
        // they are off screen, which is where the image is held. Drawn from
        // inside them, the image comes out faint and partly missing.
        document.documentElement.append(wrapper);
        return wrapper;
      }

      /**
       * Releases what the drag held: its image, Zen's drag state, and the
       * hidden row the image was landing on.
       */
      #endDrag() {
        this.#clearDrop();
        this.#dragImage?.remove();
        this.#dragImage = null;
        this.#dragItem = null;
        this.#dragSize = null;
        this.#indicatorOrigin = null;
        this.#dropBackgroundOrigin = null;
        this.#hapticReady = false;
        this.#landingWanted = false;
        lazy.zenDnD?.onDragEnd();
        if (this.#landingGuid) {
          this.#landingGuid = null;
          this.requestUpdate();
        }
      }

      /**
       * @param {Bookmark} item
       * @returns {boolean} Whether the row can be dragged
       */
      #isDraggable(item) {
        return item.parentGuid !== lazy.PlacesUtils.bookmarks.rootGuid;
      }

      /**
       * Works out where a drop on a row would land, with the same
       * thresholds as the tab strip. On a folder, the edges put it before or
       * after the row and the middle drops it inside, as on a folder of
       * tabs. On anything else it is before or after, by how far down the
       * pointer is. An open folder's bottom edge is its first child's place.
       *
       * @param {DragEvent} event
       * @param {Element} row
       * @returns {{point: object, zone: string}}
       */
      #dropPoint(event, row) {
        const item = row.libraryItem;
        const { bookmarks } = lazy.PlacesUtils;
        const rect = row.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / rect.height;
        const inside = {
          point: makeInsertionPoint(item.guid, bookmarks.DEFAULT_INDEX),
          zone: "inside",
        };
        const before = {
          point: makeInsertionPoint(item.parentGuid, item.index),
          zone: "before",
        };
        if (item.type === "folder") {
          const percent = Services.prefs.getIntPref(FOLDER_DRAGOVER_PREF, 25);
          const edge = percent / 100;
          const nearEdge = ratio < edge || ratio > 1 - edge;
          if (!this.#isDraggable(item) || !nearEdge) {
            return inside;
          }
          if (ratio < edge) {
            return before;
          }
          if (this.#expanded.has(item.guid)) {
            return { point: makeInsertionPoint(item.guid, 0), zone: "after" };
          }
        } else {
          const threshold = Services.prefs.getIntPref(MOVE_OVER_PREF, 50) / 100;
          if (ratio <= threshold) {
            return before;
          }
        }
        return {
          point: makeInsertionPoint(item.parentGuid, item.index + 1),
          zone: "after",
        };
      }

      /**
       * @param {DragEvent} event
       * @returns {Element|null} The row under the drag, when it can be
       *   dropped on. A search or filtered list is not a folder tree, and
       *   has no places to move things to.
       */
      #dropRowOf(event) {
        if (this.searchQuery || this.#filters()) {
          return null;
        }
        const row = event.target.closest?.(".zen-library-row");
        return row?.libraryItem ? row : null;
      }

      /**
       * @param {string} guid - A folder or bookmark shown in the tree
       * @returns {string|null} The folder it sits in
       */
      #parentOf(guid) {
        for (const list of [this.roots ?? [], ...this.#children.values()]) {
          const found = list.find(item => item.guid === guid);
          if (found) {
            return found.parentGuid;
          }
        }
        return null;
      }

      /**
       * A folder cannot go into itself or any folder below it. The native
       * check walks up from the folder it is dropped on, but every folder
       * here is a result of its own, so it only sees one level up. This
       * checks the whole tree for a folder dragged inside this window.
       *
       * @param {string} folderGuid - The folder the drop would land in
       * @returns {boolean}
       */
      #landsInsideDragged(folderGuid) {
        const dragged = this.#dragItem;
        if (dragged?.type !== "folder") {
          return false;
        }
        const { rootGuid } = lazy.PlacesUtils.bookmarks;
        let guid = folderGuid;
        for (let hops = 0; guid && guid !== rootGuid && hops < 64; hops++) {
          if (guid === dragged.guid) {
            return true;
          }
          guid = this.#parentOf(guid);
        }
        return false;
      }

      /**
       * Asks the native drag helper whether the drop is allowed. For a
       * dragged folder it compares with `currentDropTarget`, the node being
       * dragged over, and throws when that is not set. The target is the
       * folder the item would land in.
       */
      #canDrop(point, dataTransfer) {
        const helper = getPlacesDragHelper();
        if (!helper || this.#landsInsideDragged(point.guid)) {
          return false;
        }
        helper.currentDropTarget =
          this.#placesView?.folderNode(point.guid) ?? {};
        try {
          return !!helper.canDrop(point, dataTransfer);
        } catch (ex) {
          return false;
        } finally {
          // Left set, it would shadow the toolbar and sidebar drags.
          helper.currentDropTarget = null;
        }
      }

      #onDragOver = event => {
        const row = this.#dropRowOf(event);
        if (!row) {
          return;
        }
        const drop = this.#dropPoint(event, row);
        if (!this.#canDrop(drop.point, event.dataTransfer)) {
          this.#clearDrop();
          return;
        }
        event.preventDefault();
        this.#showDrop(row, drop.zone);
        // Only a moved row slides onto its place, a copy stays where it is.
        lazy.zenDnD?.armDropLanding(
          this.#landingWanted && event.dataTransfer.dropEffect === "move"
        );
      };

      #onDragLeave = event => {
        const row = event.target.closest?.(".zen-library-row");
        if (
          row &&
          row === this.#dropRow &&
          !row.contains(event.relatedTarget)
        ) {
          this.#clearDrop();
        }
      };

      #onDrop = event => {
        const row = this.#dropRowOf(event);
        const helper = getPlacesDragHelper();
        if (!row || !helper) {
          return;
        }
        const drop = this.#dropPoint(event, row);
        const { dataTransfer } = event;
        this.#clearDrop();
        if (!this.#canDrop(drop.point, dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (this.#landingWanted && dataTransfer.dropEffect === "move") {
          this.#landDragImage(row, drop.zone);
        }
        // The folders it changes are redrawn by the bookmark observer.
        Promise.resolve(
          helper.onDrop(drop.point, dataTransfer, this.#placesView)
        ).catch(ex => console.error(LOG_PREFIX, "Failed to drop", ex));
      };

      #dropListeners = [
        ["dragover", this.#onDragOver],
        ["dragleave", this.#onDragLeave],
        ["drop", this.#onDrop],
        ["dragend", () => this.#endDrag()],
      ];

      /**
       * Tells the OS where the drag image is to land, which is where the
       * dropped row is about to be: its place in the line the drop picked, or
       * the folder it goes into. The row it comes from stays out of sight
       * until the drag ends, so the image is not seen to land twice.
       *
       * @param {Element} row - The row the drop is on
       * @param {string} zone - before, after or inside
       */
      #landDragImage(row, zone) {
        const rect = row.getBoundingClientRect();
        const inside = zone === "inside";
        const top = zone === "after" ? rect.bottom : rect.top;
        const height = inside ? rect.height : this.#dragSize.height;
        lazy.zenDnD?.addDropLandingRect(
          Math.round(window.mozInnerScreenX + rect.left),
          Math.round(window.mozInnerScreenY + top),
          Math.round(rect.width),
          Math.round(height)
        );
        this.#landingGuid = this.#dragItem?.guid ?? null;
        this.requestUpdate();
      }

      /**
       * Marks where the drop would land: a line along the edge of the row
       * for before and after, or the folder itself lit up for inside. Moving
       * to another place taps the haptic feedback, but not the first.
       *
       * Also opens a closed folder that the drag rests on for a moment.
       *
       * @param {Element} row
       * @param {string} zone - before, after or inside
       */
      #showDrop(row, zone) {
        const { guid, type } = row.libraryItem;
        const key = `${guid}:${zone}`;
        if (key !== this.#dropKey) {
          if (this.#hapticReady) {
            // eslint-disable-next-line mozilla/valid-services
            Services.zen.playHapticFeedback();
          }
          this.#hapticReady = true;
          this.#dropKey = key;
        }

        if (this.#dropRow !== row) {
          this.#dropRow?.removeAttribute("drop-zone");
          this.#dropRow = row;
        }
        row.setAttribute("drop-zone", zone);

        if (zone === "inside") {
          this.#indicator?.remove();
          this.#placeDropBackground(row);
        } else {
          this.#dropBackground?.remove();
          this.#placeIndicator(row, zone);
        }

        const opens =
          zone === "inside" && type === "folder" && !this.#expanded.has(guid);
        if (!opens) {
          this.#cancelDragOpen();
        } else if (this.#dragOpenGuid !== guid) {
          this.#cancelDragOpen();
          this.#dragOpenGuid = guid;
          this.#dragOpenTimer = setTimeout(() => {
            this.#dragOpenTimer = null;
            if (!this.#expanded.has(guid)) {
              this.#toggleFolder(guid);
            }
          }, DRAG_OPEN_DELAY_MS);
        }
      }

      /**
       * A fixed element is placed from the viewport unless an ancestor of the
       * Library says otherwise, so this finds where its 0,0 really is.
       *
       * @param {Element} element - A fixed element that is in the document
       * @returns {{x: number, y: number}}
       */
      #fixedOrigin(element) {
        element.style.left = element.style.top = "0px";
        const { left, top } = element.getBoundingClientRect();
        element.style.left = "";
        return { x: left, y: top };
      }

      /**
       * Lays the drop line along the top or bottom of a row, the way Zen lays
       * its own across a tab: one fixed element placed from the bounds of the
       * row. It is not a child of the row, because the rows clip what is
       * drawn outside them (they skip painting while off screen, and the
       * folders cut their contents off to animate), and the dot at the start
       * of the line sticks out of the row.
       *
       * @param {Element} row
       * @param {string} zone - before or after
       */
      #placeIndicator(row, zone) {
        const indicator =
          this.#indicator ??
          (this.#indicator = Object.assign(document.createElement("div"), {
            className: "zen-library-drop-indicator",
          }));
        const host = this.library ?? this;
        if (indicator.parentNode !== host) {
          host.append(indicator);
          this.#indicatorOrigin = null;
        }
        this.#indicatorOrigin ??= this.#fixedOrigin(indicator);
        const { x, y } = this.#indicatorOrigin;
        const rect = row.getBoundingClientRect();
        const separation = 4;
        indicator.setAttribute("orientation", "horizontal");
        indicator.style.setProperty(
          "--indicator-left",
          `${rect.left + separation / 2 - x}px`
        );
        indicator.style.setProperty(
          "--indicator-width",
          `${rect.width - separation}px`
        );
        const top = zone === "before" ? rect.top : rect.bottom;
        indicator.style.top = `${Math.round(top) - y}px`;
      }

      /**
       * Lights up the folder an item would go into, the way Zen's
       * #zen-dragover-background does: a plain band of the primary color
       * across the whole width, 2px short of the row above and below it, and
       * behind the row's contents. The folder's own rounded background is
       * not part of it.
       *
       * @param {Element} row - The folder row
       */
      #placeDropBackground(row) {
        const background =
          this.#dropBackground ??
          (this.#dropBackground = Object.assign(document.createElement("div"), {
            className: "zen-library-drop-background",
          }));
        if (background.parentNode !== this) {
          this.append(background);
          this.#dropBackgroundOrigin = null;
        }
        this.#dropBackgroundOrigin ??= this.#fixedOrigin(background);
        const { x, y } = this.#dropBackgroundOrigin;
        const margin = 2;
        const rect = row.getBoundingClientRect();
        // Nested folders are inset, so the band is as wide as the section.
        const area = this.getBoundingClientRect();
        const left = Math.min(area.left, rect.left);
        const right = Math.max(area.right, rect.right);
        background.style.left = `${left - x}px`;
        background.style.width = `${right - left}px`;
        background.style.top = `${rect.top + margin - y}px`;
        background.style.height = `${rect.height - margin * 2}px`;
      }

      #cancelDragOpen() {
        clearTimeout(this.#dragOpenTimer);
        this.#dragOpenTimer = null;
        this.#dragOpenGuid = null;
      }

      #clearDrop() {
        this.#dropRow?.removeAttribute("drop-zone");
        this.#dropRow = null;
        this.#dropKey = null;
        this.#indicator?.remove();
        this.#dropBackground?.remove();
        this.#cancelDragOpen();
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
          console.error(LOG_PREFIX, "Failed to find the Places node", ex);
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
            ?landing=${this.#landingGuid === bookmark.guid}
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
            @dragstart=${event => this.#onDragStart(event, bookmark)}
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
              draggable=${this.#isDraggable(folder) ? "true" : "false"}
              .libraryItem=${folder}
              ?cutting=${this.#placesView?.isCut(folder)}
              ?landing=${this.#landingGuid === folder.guid}
              @contextmenu=${event => this.#onContextMenu(event, folder)}
              @dragstart=${event => this.#onDragStart(event, folder)}
              @click=${() => this.#toggleFolder(folder.guid)}
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
                  ?landing=${this.#landingGuid === node.guid}
                  @contextmenu=${event => this.#onContextMenu(event, node)}
                  @dragstart=${event => this.#onDragStart(event, node)}
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

    bookmarksSection = ZenLibraryBookmarksSection;
    return bookmarksSection;
  }

  // History section

  let historySection = null;

  /**
   * Creates the History section: the native one, with the two shortcuts of
   * the history menu above its list. It replaces the native section in the
   * Library, so everything else about it stays as Zen made it.
   *
   * @returns {Function} The section class
   */
  function getHistorySection() {
    if (historySection) {
      return historySection;
    }

    const { html } = lazy.lit;
    const { ZenLibraryHistorySection } = lazy.historySection;

    const closedAtFormat = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

    class ZenLibraryHistoryTweaksSection extends ZenLibraryHistorySection {
      static render(library) {
        return html`
          <zen-library-history-tweaks-section
            class="zen-library-section"
            data-section="history"
            .library=${library}
          ></zen-library-history-tweaks-section>
        `;
      }

      #observer = { observe: () => this.#readClosedTabs() };
      // What the closed tabs list shows, as `{tab, index, source}`.
      #closedEntries = [];
      #showingClosed = false;

      connectedCallback() {
        super.connectedCallback();
        this.addEventListener("keydown", this.#onKeyDown);
        Services.obs.addObserver(this.#observer, CLOSED_OBJECTS_TOPIC);
        this.#readClosedTabs();
      }

      disconnectedCallback() {
        super.disconnectedCallback();
        this.removeEventListener("keydown", this.#onKeyDown);
        Services.obs.removeObserver(this.#observer, CLOSED_OBJECTS_TOPIC);
      }

      // Reading the closed tabs

      /**
       * Lists the tabs the native menu lists: the ones closed in this window,
       * and by the same prefs in the other open windows and in windows that
       * were closed. Tabs closed along with a folder are listed as plain tabs,
       * and the blank tab Zen keeps in every folder is left out. Each tab keeps
       * the index it has in its own list, which is what restoring and
       * forgetting take.
       *
       * @returns {object[]}
       */
      #buildClosedEntries() {
        const store = window.SessionStore;
        if (!store) {
          return [];
        }
        const prefs = Services.prefs;
        const windows =
          prefs.getBoolPref(CLOSED_FROM_ALL_WINDOWS_PREF, true) &&
          store.getWindows
            ? store.getWindows(window)
            : [window];
        const sets = windows.map(win => store.getClosedTabDataForWindow(win));
        if (
          prefs.getBoolPref(CLOSED_FROM_CLOSED_WINDOWS_PREF, true) &&
          !lazy.PrivateBrowsingUtils.isWindowPrivate(window) &&
          store.getClosedTabCountFromClosedWindows?.()
        ) {
          sets.push(store.getClosedTabDataFromClosedWindows());
        }

        const entries = [];
        for (const set of sets) {
          set.forEach((tab, index) => {
            if (!this.#isFolderPlaceholder(tab)) {
              entries.push({ tab, index, source: tab });
            }
          });
        }
        return entries;
      }

      #readClosedTabs() {
        try {
          this.#closedEntries = this.#buildClosedEntries();
        } catch (ex) {
          console.error(LOG_PREFIX, "Failed to read the closed tabs", ex);
          this.#closedEntries = [];
        }
        // Nothing left to show, so the list has no reason to stay open.
        if (!this.#closedEntries.length) {
          this.#setShowingClosed(false);
        }
        this.requestUpdate();
      }

      /**
       * Slides between the history and the closed tabs. The sliding itself
       * is a transition on the `closed-view` attribute in the CSS.
       *
       * @param {boolean} showing
       */
      #setShowingClosed(showing) {
        if (this.#showingClosed === showing) {
          return;
        }
        this.#showingClosed = showing;
        this.toggleAttribute("closed-view", showing);
        this.requestUpdate();
        // Inert panes cannot take focus, so this waits for the update.
        this.updateComplete.then(() =>
          this.querySelector(
            showing ? ".zen-library-closed-back" : ".zen-library-closed-shortcut"
          )?.focus()
        );
      }

      #onKeyDown = event => {
        if (event.key === "Escape" && this.#showingClosed) {
          // Goes back a step instead of closing the Library.
          event.preventDefault();
          event.stopPropagation();
          this.#setShowingClosed(false);
        }
      };

      // Closed tabs

      /**
       * @param {object} data - A closed tab or folder, or the tab it came with
       * @returns {object} What session store takes to find where it was closed:
       *   a window that is gone, or one that is still open
       */
      #sourceOf(data) {
        return typeof data.sourceClosedId === "number"
          ? { sourceClosedId: data.sourceClosedId }
          : { sourceWindowId: data.sourceWindowId };
      }

      /**
       * @param {object} closedTab - An entry of the session store's list
       * @returns {{title: string, url: string}} What the row shows: the page
       *   the tab was on when it closed
       */
      #closedTabInfo(closedTab) {
        const { entries = [], index = entries.length } = closedTab.state ?? {};
        const entry = entries[index - 1] ?? entries.at(-1);
        const url = entry?.url ?? "";
        return { url, title: closedTab.title || entry?.title || url };
      }

      /**
       * Zen keeps a blank pinned tab in every folder to hold its place. It
       * is not something to list. A blank tab that was not in a folder is a
       * real tab, so it stays.
       *
       * @param {object} closedTab
       * @returns {boolean}
       */
      #isFolderPlaceholder(closedTab) {
        const entries = closedTab?.state?.entries ?? [];
        return (
          !!closedTab?.closedInTabGroupId &&
          !!entries.length &&
          entries.every(({ url }) => url === "about:blank")
        );
      }

      #undoTab({ tab, index, source }) {
        const store = window.SessionStore;
        if (typeof source.sourceClosedId === "number") {
          // The name of this one changed between releases.
          const undo =
            store.undoClosedTabFromClosedWindow ??
            store.undoCloseTabFromClosedWindow;
          undo.call(store, this.#sourceOf(source), tab.closedId);
        } else if (typeof window.undoCloseTab === "function") {
          window.undoCloseTab(index, source.sourceWindowId);
        } else {
          lazy.SessionWindowUI.undoCloseTab(
            window,
            index,
            source.sourceWindowId
          );
        }
      }

      #forgetTab({ tab, index, source }) {
        const store = window.SessionStore;
        try {
          if (store.forgetClosedTabById) {
            store.forgetClosedTabById(tab.closedId, this.#sourceOf(source));
          } else {
            store.forgetClosedTab(window, index);
          }
        } catch (ex) {
          console.error(LOG_PREFIX, "Failed to forget the closed tab", ex);
        }
        this.#readClosedTabs();
      }

      /**
       * Opens like the history rows do: a plain click brings it back in
       * front and closes the Library, and Ctrl/Cmd or a middle click brings it
       * back behind the tab that is open and leaves the Library up.
       *
       * @param {Function} restore - Brings the tab or folder back
       * @param {MouseEvent|KeyboardEvent} [event] - What asked for it
       */
      #reopen(restore, event) {
        const background =
          !!event && (event.getModifierState("Accel") || event.button === 1);
        if (!background) {
          try {
            restore();
          } catch (ex) {
            console.error(LOG_PREFIX, "Failed to restore", ex);
            return;
          }
          this.library?.constructor.toggle();
          return;
        }
        let restored = false;
        this.library.keepOpenWhile(() => {
          const previous = gBrowser.selectedTab;
          try {
            restore();
            restored = true;
          } catch (ex) {
            console.error(LOG_PREFIX, "Failed to restore", ex);
          }
          // Restoring a tab selects it.
          if (previous?.isConnected) {
            gBrowser.selectedTab = previous;
          }
        });
        if (restored) {
          gZenUIManager.showToast("library-history-opened-in-background");
        }
      }

      /**
       * A tab drags as a link, like a visit does.
       *
       * @param {DragEvent} event
       * @param {string} title
       * @param {string} url
       */
      #onDragStart(event, title, url) {
        if (!url) {
          event.preventDefault();
          return;
        }
        const { dataTransfer } = event;
        dataTransfer.setData("text/x-moz-url", `${url}\n${title}`);
        dataTransfer.setData("text/uri-list", url);
        dataTransfer.setData("text/plain", url);
        dataTransfer.effectAllowed = "copyLink";
        dataTransfer.addElement(event.currentTarget);
        // eslint-disable-next-line mozilla/valid-services
        Services.zen.playHapticFeedback();
      }

      // Clear history

      #clearHistory() {
        document.getElementById("Tools:Sanitize")?.doCommand();
      }

      // Rendering

      #onActivateKey(event, onActivate) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(event);
        }
      }

      #renderShortcut({
        icon,
        text,
        className = "",
        disabled = false,
        chevron = false,
        onActivate,
      }) {
        return html`
          <div
            class="zen-library-row zen-library-shortcut ${className}"
            role="button"
            tabindex=${disabled ? -1 : 0}
            ?disabled=${disabled}
            @click=${onActivate}
            @keydown=${event => this.#onActivateKey(event, onActivate)}
          >
            <img class="zen-library-row-icon" src=${icon} alt="" />
            <div class="zen-library-row-text">
              <span class="zen-library-row-title">${text}</span>
            </div>
            ${chevron
              ? html`<img
                  class="zen-library-shortcut-chevron"
                  src="chrome://global/skin/icons/arrow-right.svg"
                  alt=""
                />`
              : null}
          </div>
        `;
      }

      /**
       * The two buttons of a history row: forget it, and bring it back.
       *
       * @param {Function} onForget
       * @param {function(MouseEvent): void} onReopen
       */
      #renderRowActions(onForget, onReopen) {
        return html`
          <div class="zen-library-row-actions">
            <toolbarbutton
              class="toolbarbutton-1"
              data-l10n-id="library-history-forget-button"
              @click=${event => {
                event.stopPropagation();
                onForget();
              }}
            >
              <img
                class="toolbarbutton-icon"
                src="chrome://browser/skin/zen-icons/trash.svg"
                alt=""
              />
            </toolbarbutton>
            <toolbarbutton
              class="toolbarbutton-1"
              data-l10n-id="library-history-reopen-button"
              @click=${event => {
                event.stopPropagation();
                onReopen(event);
              }}
            >
              <img
                class="toolbarbutton-icon"
                src="chrome://browser/skin/zen-icons/u-turn-to-left.svg"
                alt=""
              />
            </toolbarbutton>
          </div>
        `;
      }

      #renderClosedTab(item) {
        const { tab, source } = item;
        const { title, url } = this.#closedTabInfo(tab);
        const closedAt = tab.closedAt ?? source.closedAt;
        const reopen = event => this.#reopen(() => this.#undoTab(item), event);
        return html`
          <div
            class="zen-library-row"
            role="button"
            tabindex="0"
            draggable="true"
            @click=${reopen}
            @auxclick=${event => {
              if (event.button === 1) {
                event.preventDefault();
                reopen(event);
              }
            }}
            @keydown=${event => this.#onActivateKey(event, reopen)}
            @dragstart=${event => this.#onDragStart(event, title, url)}
          >
            <img class="zen-library-row-icon" src="page-icon:${url}" alt="" />
            <div class="zen-library-row-text">
              <span class="zen-library-row-title">${title}</span>
              <span class="zen-library-row-subtitle"
                >${closedAt
                  ? html`<span class="zen-library-visit-url"
                        >${formatUrl(url)}</span
                      ><span class="zen-library-visit-date"
                        >${closedAtFormat.format(closedAt)}</span
                      >`
                  : formatUrl(url)}</span
              >
            </div>
            ${this.#renderRowActions(() => this.#forgetTab(item), reopen)}
          </div>
        `;
      }

      #renderClosedPane() {
        const back = () => this.#setShowingClosed(false);
        return html`
          <div
            class="zen-library-pane zen-library-closed-pane"
            ?inert=${!this.#showingClosed}
          >
            <div class="zen-library-closed-header">
              <div
                class="zen-library-row zen-library-closed-back"
                role="button"
                tabindex="0"
                aria-label=${STRINGS["library-history-back"]}
                @click=${back}
                @keydown=${event => this.#onActivateKey(event, back)}
              >
                <img
                  class="zen-library-row-icon"
                  src="chrome://global/skin/icons/arrow-left.svg"
                  alt=""
                />
                <div class="zen-library-row-text">
                  <span class="zen-library-row-title"
                    >${STRINGS["library-history-closed-tabs"]}</span
                  >
                </div>
              </div>
            </div>
            <div class="zen-library-closed-list">
              ${this.#closedEntries.length
                ? html`<div class="zen-library-group">
                    ${this.#closedEntries.map(entry =>
                      this.#renderClosedTab(entry)
                    )}
                  </div>`
                : html`<div class="zen-library-empty">
                    ${STRINGS["library-history-closed-tabs-empty"]}
                  </div>`}
            </div>
          </div>
        `;
      }

      renderItems() {
        const items = super.renderItems();
        if (this.searchQuery) {
          return items;
        }
        return html`
          <div class="zen-library-group">
            ${this.#renderShortcut({
              icon: "chrome://browser/skin/zen-icons/u-turn-to-left.svg",
              text: STRINGS["library-history-closed-tabs"],
              className: "zen-library-closed-shortcut",
              disabled: !this.#closedEntries.length,
              chevron: true,
              onActivate: () => this.#setShowingClosed(true),
            })}
            ${this.#renderShortcut({
              icon: "chrome://browser/skin/zen-icons/trash.svg",
              text: STRINGS["library-history-clear"],
              onActivate: () => this.#clearHistory(),
            })}
          </div>
          ${items}
        `;
      }

      /**
       * The history, with the closed tabs one screen to its right. The base
       * class renders the search box and the list, which go in the first pane
       * untouched, so its scrolling and search keep working.
       */
      render() {
        return html`
          <div class="zen-library-pane-track">
            <div
              class="zen-library-pane zen-library-history-pane"
              ?inert=${this.#showingClosed}
            >
              ${super.render()}
            </div>
            ${this.#renderClosedPane()}
          </div>
        `;
      }
    }

    customElements.define(
      "zen-library-history-tweaks-section",
      ZenLibraryHistoryTweaksSection
    );

    historySection = ZenLibraryHistoryTweaksSection;
    return historySection;
  }

  // Registration

  /**
   * The sections this mod adds to the Library. `placement` positions the
   * sidebar tab relative to another section id, and defaults to the end. A
   * section with the id of a native one replaces it where it stands.
   */
  const SECTIONS = [
    {
      resolve: getHistorySection,
    },
    {
      resolve: getBookmarksSection,
      placement: { after: "history" },
    },
  ];

  /**
   * Returns a copy of a sections map with one section inserted. The Library
   * renders its sidebar tabs in the insertion order of this object.
   *
   * @param {object} sections - The current id to section map
   * @param {Function} Section - The section class to add
   * @param {{before?: string, after?: string}} [placement]
   * @returns {object} The new map
   */
  function withSection(sections, Section, { before, after } = {}) {
    if (!before && !after && Section.id in sections) {
      return { ...sections, [Section.id]: Section };
    }
    const entries = Object.entries(sections).filter(
      ([id]) => id !== Section.id
    );
    let index = entries.length;
    const anchor = entries.findIndex(([id]) => id === (before ?? after));
    if (anchor !== -1) {
      index = before ? anchor : anchor + 1;
    }
    entries.splice(index, 0, [Section.id, Section]);
    return Object.fromEntries(entries);
  }

  class LibraryTweaks {
    static version = "v1.1";

    /**
     * The bookmarks data layer, for the Library sections and the console.
     */
    get BookmarksQuery() {
      return BookmarksQuery;
    }

    #Library = null;
    #originalGetInstance = null;
    #originalToggleSidebar = null;

    async init() {
      this.#Library = await customElements.whenDefined(LIBRARY_ELEMENT);
      this.#hookGetInstance();
      this.#hookSidebar();

      // The Library already exists if this script loaded after it was opened.
      const existing = this.#Library.getInstance(false);
      if (existing) {
        this.#extend(existing);
      }
    }

    destroy() {
      if (this.#Library && this.#originalGetInstance) {
        this.#Library.getInstance = this.#originalGetInstance;
      }
      this.#originalGetInstance = null;
      if (this.#originalToggleSidebar) {
        window.SidebarController.toggle = this.#originalToggleSidebar;
      }
      this.#originalToggleSidebar = null;
      this.#Library = null;
    }

    /**
     * Wraps the native factory so a Library is extended as soon as it is
     * created. At that point it is mounted but not yet rendered, so the first
     * render already includes our sections.
     */
    #hookGetInstance() {
      const mod = this;
      const original = this.#Library.getInstance;
      this.#originalGetInstance = original;

      this.#Library.getInstance = function (createIfMissing = true) {
        const creating = createIfMissing && !this.instance;
        // The constructor resets the pref to "history" when it does not know
        // the saved section yet, so it has to be read beforehand.
        const savedTab = creating
          ? Services.prefs.getStringPref(LAST_TAB_PREF, "")
          : "";
        const library = original.call(this, createIfMissing);
        if (creating && library) {
          mod.#extend(library, savedTab);
        }
        return library;
      };
    }

    /**
     * Makes Ctrl+B open the Library on Bookmarks, like Ctrl+H does for
     * History, instead of the bookmarks sidebar. The sidebar still opens when
     * the Library is turned off, and an open one is still closed as before.
     */
    #hookSidebar() {
      const controller = window.SidebarController;
      if (!controller) {
        return;
      }
      const mod = this;
      const original = controller.toggle;
      this.#originalToggleSidebar = original;

      controller.toggle = function (commandID, ...args) {
        if (
          commandID === BOOKMARKS_SIDEBAR_COMMAND &&
          this.currentID !== commandID &&
          Services.prefs.getBoolPref(LIBRARY_ENABLED_PREF, false) &&
          BOOKMARKS_SECTION_ID in mod.#Library.getInstance().zenLibrarySections
        ) {
          mod.#Library.toggle(BOOKMARKS_SECTION_ID);
          return Promise.resolve();
        }
        return original.call(this, commandID, ...args);
      };
    }

    /**
     * Adds every registered section to a Library. Errors are caught so that
     * a problem in the mod can never break the native Library.
     *
     * @param {HTMLElement} library - The zen-library instance
     * @param {string} [savedTab] - The section the Library was last left on
     */
    #extend(library, savedTab = "") {
      try {
        for (const { resolve, placement } of SECTIONS) {
          library.zenLibrarySections = withSection(
            library.zenLibrarySections,
            resolve(),
            placement
          );
        }

        if (savedTab && savedTab in library.zenLibrarySections) {
          library.activeTab = savedTab;
        }

        library.requestUpdate();
        library.updateComplete.then(() => this.#applyTabLabels(library));
      } catch (ex) {
        console.error(LOG_PREFIX, "Failed to extend the Library", ex);
      }
    }

    /**
     * Sets the sidebar tab text of our sections. Lit reuses tab elements by
     * position and Fluent keeps the old text when an id has no message, so a
     * tab could otherwise show the name of another section.
     *
     * @param {HTMLElement} library - The zen-library instance
     */
    #applyTabLabels(library) {
      for (const { resolve } of SECTIONS) {
        const Section = resolve();
        const label = library.querySelector(
          `.zen-library-tab[data-section="${Section.id}"] label`
        );
        // Replaced native sections keep the label Fluent gives them.
        if (label && STRINGS[Section.label] !== undefined) {
          label.textContent = STRINGS[Section.label];
        }
      }
    }
  }

  const mod = new LibraryTweaks();
  window.gLibraryTweaks = mod;
  mod.init().catch(ex => console.error(LOG_PREFIX, "Failed to initialize", ex));
})();