/**
 * Lets the native Places controller drive the rows of the Library, so that
 * the context menu, cut and paste, and drops are all the native ones.
 */

import { isRootFolder } from "./BookmarksData.mjs";

const PLACES_CONTROLLER_URL = "chrome://browser/content/places/controller.js";

// What cannot be done to the folders Places keeps, by the command the
// context menu items run.
const ROOT_BLOCKED_COMMANDS = new Set([
  "placesCmd_cut",
  "placesCmd_copy",
  "placesCmd_delete",
]);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

/**
 * @returns {Function|null} The native PlacesController class, which the
 *   sidebar and the toolbar use to run the commands of the context menu
 */
export function getPlacesControllerClass() {
  if (typeof PlacesController === "undefined") {
    try {
      Services.scriptloader.loadSubScript(PLACES_CONTROLLER_URL, window);
    } catch (ex) {
      console.error("Failed to load PlacesController", ex);
    }
  }
  return typeof PlacesController === "undefined" ? null : PlacesController;
}

/**
 * @returns {object|null} The native PlacesControllerDragHelper, which
 *   decides what may be dropped where and performs the drop
 */
export function getPlacesDragHelper() {
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
export function makeInsertionPoint(guid, index) {
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
export class BookmarksPlacesView {
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
        if (!controller?.supportsCommand(command)) {
          return null;
        }
        return this.#isRootSelected() ? this.#guard(controller) : controller;
      },
    };
  }

  /**
   * @returns {boolean} Whether the selected row is one of the folders that
   *   Places keeps, which cannot be cut, copied or deleted
   */
  #isRootSelected() {
    return !!this.#node && isRootFolder(this.#node.bookmarkGuid);
  }

  /**
   * The controller as it answers for a folder that Places keeps: the same
   * one, except that the commands that would take the folder away are off.
   *
   * @param {object} controller - The native PlacesController
   * @returns {object} An nsIController
   */
  #guard(controller) {
    return {
      supportsCommand: command => controller.supportsCommand(command),
      isCommandEnabled: command =>
        !ROOT_BLOCKED_COMMANDS.has(command) &&
        controller.isCommandEnabled(command),
      doCommand: command =>
        ROOT_BLOCKED_COMMANDS.has(command)
          ? undefined
          : controller.doCommand(command),
      onEvent: event => controller.onEvent?.(event),
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
    const show = this.controller.buildContextMenu(popup);
    if (show && this.#isRootSelected()) {
      // Left out rather than grayed, since they never apply.
      for (const command of ROOT_BLOCKED_COMMANDS) {
        for (const item of popup.querySelectorAll(`[command="${command}"]`)) {
          item.hidden = true;
        }
      }
    }
    return show;
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
