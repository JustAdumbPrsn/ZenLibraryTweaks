/**
 * Drag and drop for the rows of the Bookmarks section, shaped like the tab
 * strip's (ZenDragAndDrop): the drag image, where a drop lands, the folders
 * that fold up while dragged, and the slide into place after a drop.
 *
 * The section is the host. It owns the tree and the open folders, and
 * offers the few things this needs: `placesView`, `openFolders`,
 * `acceptsDrops`, `parentOf` and `toggleFolder`.
 */

import { isRootFolder } from "./BookmarksData.mjs";
import {
  getPlacesDragHelper,
  makeInsertionPoint,
} from "./BookmarksPlacesView.mjs";

// How long a drag has to rest on a closed folder before it opens, like the
// native tree.
const DRAG_OPEN_DELAY_MS = 600;
// The tab strip's thresholds, which the rows follow so that dropping feels
// the same in both.
const FOLDER_DRAGOVER_PREF = "zen.tabs.folder-dragover-threshold-percent";
const MOVE_OVER_PREF = "browser.tabs.dragDrop.moveOverThresholdPercent";
// How long the rows take to slide into place after a drop, which is what
// the tab strip's own drop animation takes.
const DROP_ANIMATION_MS = 100;
// How long a drop waits for the bookmark change to reach the rows, before
// giving up on animating it (a drop that moves nothing never gets there).
const DROP_SETTLE_TIMEOUT_MS = 800;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

// The service Zen's tab drag and drop uses to shape the drag image: its
// opacity, and on macOS where it lands once dropped.
ChromeUtils.defineLazyGetter(lazy, "zenDnD", () => {
  try {
    return Cc["@mozilla.org/zen/drag-and-drop;1"].getService(
      Ci.nsIZenDragAndDrop
    );
  } catch (ex) {
    // Without it the OS draws its own translucent drag image.
    console.warn("Zen's drag and drop service is missing", ex);
    return null;
  }
});

export class BookmarksDragAndDrop {
  /** @type {HTMLElement} The section whose rows are dragged */
  host;

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
  // The folder that was open when its drag began. Zen's tab strip folds
  // a folder up while it is dragged, and opens it again afterwards.
  #collapsedForDrag = null;
  // Where the rows were when the drop was made, until the move shows up.
  #dropSnapshot = null;
  #dropSnapshotTimer = null;
  #droppedGuid = null;
  // Keeps the folder shut until the rows have slid into place.
  #holdRestore = false;

  /**
   * @param {HTMLElement} host - The Bookmarks section
   */
  constructor(host) {
    this.host = host;
  }

  /**
   * @returns {string|null} The row the OS drag image is landing on, which
   *   stays out of sight until the drag ends
   */
  get landingGuid() {
    return this.#landingGuid;
  }

  /**
   * Starts listening for drops on the section.
   */
  attach() {
    for (const [type, listener] of this.#dropListeners) {
      this.host.addEventListener(type, listener);
    }
  }

  /**
   * Stops listening, and lets go of everything a drag in progress holds.
   */
  detach() {
    for (const [type, listener] of this.#dropListeners) {
      this.host.removeEventListener(type, listener);
    }
    this.#clearDropSnapshot();
    this.#endDrag();
  }

  /**
   * Rows drag with the data the native tree gives them, so they can be
   * dropped onto the toolbar, the sidebar, content, the tab strip or
   * another app, and reordered here. Top level folders are the Places
   * roots and stay where they are.
   *
   * @param {DragEvent} event
   * @param {Bookmark} item
   */
  start(event, item) {
    event.stopPropagation();
    if (!this.isDraggable(item)) {
      event.preventDefault();
      return;
    }
    const view = this.host.placesView;
    const { dataTransfer } = event;

    let node = null;
    try {
      node = view?.select(item);
    } catch (ex) {
      console.error("Failed to find the Places node", ex);
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
    this.#clearDropSnapshot();
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
    this.#collapseForDrag(item);
  }

  /**
   * Folds an open folder up while it is dragged, like the tab strip does,
   * so it moves as a single row and cannot be dropped into itself. The
   * choice is not saved, and the folder opens again once the drag is
   * over. It waits a tick, because changing the page inside dragstart
   * can cancel the drag.
   *
   * @param {Bookmark} item - The row being dragged
   */
  #collapseForDrag(item) {
    if (item.type !== "folder" || !this.host.openFolders.has(item.guid)) {
      return;
    }
    setTimeout(() => {
      if (
        this.#dragItem?.guid !== item.guid ||
        !this.host.openFolders.has(item.guid)
      ) {
        return;
      }
      this.#collapsedForDrag = item.guid;
      this.host.openFolders.delete(item.guid);
      this.host.requestUpdate();
    }, 0);
  }

  /**
   * Opens the folder that was folded up for its drag, in its new place.
   */
  #restoreDraggedFolder() {
    const guid = this.#collapsedForDrag;
    if (!guid) {
      return;
    }
    this.#collapsedForDrag = null;
    if (!this.host.openFolders.has(guid)) {
      this.host.openFolders.add(guid);
      this.host.requestUpdate();
    }
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
      this.host.requestUpdate();
    }
    // After a drop, it waits for the rows to settle.
    if (!this.#holdRestore) {
      this.#restoreDraggedFolder();
    }
  }

  /**
   * Remembers where the rows are as a move is dropped. The move reaches
   * the rows a moment later, through the bookmark observer, and the
   * rows are then slid from here to where they ended up.
   *
   * @param {string|null} droppedGuid - The row that was dropped
   */
  #snapshotRows(droppedGuid) {
    if (typeof gReduceMotion !== "undefined" && gReduceMotion) {
      return;
    }
    const rows = new Map();
    for (const row of this.host.querySelectorAll(".zen-library-row")) {
      const guid = row.libraryItem?.guid;
      if (!guid || row.closest(".zen-library-folder-children[inert]")) {
        continue;
      }
      const { top, bottom, height } = row.getBoundingClientRect();
      // Rows that are not on screen cannot be seen to move.
      if (height && bottom > 0 && top < window.innerHeight) {
        rows.set(guid, top);
      }
    }
    clearTimeout(this.#dropSnapshotTimer);
    this.#dropSnapshot = rows;
    this.#droppedGuid = droppedGuid;
    this.#holdRestore = true;
    this.#dropSnapshotTimer = setTimeout(
      () => this.#clearDropSnapshot(),
      DROP_SETTLE_TIMEOUT_MS
    );
  }

  #clearDropSnapshot() {
    clearTimeout(this.#dropSnapshotTimer);
    this.#dropSnapshotTimer = null;
    this.#dropSnapshot = null;
    this.#droppedGuid = null;
    this.#holdRestore = false;
    this.#restoreDraggedFolder();
  }

  /**
   * Does what the tab strip does once a tab is dropped: every item that
   * changed place starts from where it was and slides to where it is,
   * for as long as the tab strip takes. Runs after each render, and
   * acts only once the rows have actually moved.
   */
  playDropAnimation() {
    const before = this.#dropSnapshot;
    if (!before) {
      return;
    }
    const moves = [];
    for (const row of this.host.querySelectorAll(".zen-library-row")) {
      const guid = row.libraryItem?.guid;
      const top = before.get(guid);
      // The row that lands from the OS drag image is hidden meanwhile.
      if (
        top === undefined ||
        row.hasAttribute("landing") ||
        row.closest(".zen-library-folder-children[inert]")
      ) {
        continue;
      }
      const delta = top - row.getBoundingClientRect().top;
      if (Math.abs(delta) >= 1) {
        moves.push({ row, delta, dropped: guid === this.#droppedGuid });
      }
    }
    if (!moves.length) {
      return;
    }
    clearTimeout(this.#dropSnapshotTimer);
    this.#dropSnapshotTimer = null;
    this.#dropSnapshot = null;
    Promise.allSettled(
      moves.map(({ row, delta, dropped }) =>
        this.#slideRow(row, delta, dropped)
      )
    ).then(() => {
      this.#droppedGuid = null;
      this.#holdRestore = false;
      this.#restoreDraggedFolder();
    });
  }

  /**
   * Slides a row from an offset to its place, the way the tab strip
   * does it: with its own animation helper when Zen has one.
   *
   * @param {Element} row
   * @param {number} delta - How far above (negative) or below the row
   *   was, in px
   * @param {boolean} dropped - Whether this is the row that was dropped,
   *   which is drawn above the ones it passes
   * @returns {Promise}
   */
  #slideRow(row, delta, dropped) {
    row.style.transform = `translateY(${delta}px)`;
    if (dropped) {
      row.style.zIndex = "9";
    }
    const options = { duration: DROP_ANIMATION_MS, easing: "ease-out" };
    let animation;
    try {
      animation =
        typeof gZenUIManager !== "undefined" && gZenUIManager.elementAnimate
          ? gZenUIManager.elementAnimate(row, { y: [delta, 0] }, options)
          : row.animate(
              { transform: [`translateY(${delta}px)`, "translateY(0)"] },
              options
            ).finished;
    } catch (ex) {
      animation = Promise.resolve();
    }
    return Promise.resolve(animation)
      .catch(() => {})
      .finally(() => {
        row.style.transform = "";
        row.style.zIndex = "";
      });
  }

  /**
   * @param {Bookmark} item
   * @returns {boolean} Whether the row can be dragged. The folders Places
   *   keeps stay where they are.
   */
  isDraggable(item) {
    return !isRootFolder(item.guid);
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
      if (!this.isDraggable(item) || !nearEdge) {
        return inside;
      }
      if (ratio < edge) {
        return before;
      }
      if (this.host.openFolders.has(item.guid)) {
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
    if (!this.host.acceptsDrops) {
      return null;
    }
    const row = event.target.closest?.(".zen-library-row");
    return row?.libraryItem ? row : null;
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
      guid = this.host.parentOf(guid);
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
      this.host.placesView?.folderNode(point.guid) ?? {};
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
    if (dataTransfer.dropEffect === "move") {
      // Before anything is redrawn, so the rows can slide into place.
      this.#snapshotRows(this.#dragItem?.guid ?? null);
      if (this.#landingWanted) {
        this.#landDragImage(row, drop.zone);
      }
    }
    // The folders it changes are redrawn by the bookmark observer.
    Promise.resolve(
      helper.onDrop(drop.point, dataTransfer, this.host.placesView)
    ).catch(ex => console.error("Failed to drop", ex));
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
    this.host.requestUpdate();
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
      zone === "inside" && type === "folder" && !this.host.openFolders.has(guid);
    if (!opens) {
      this.#cancelDragOpen();
    } else if (this.#dragOpenGuid !== guid) {
      this.#cancelDragOpen();
      this.#dragOpenGuid = guid;
      this.#dragOpenTimer = setTimeout(() => {
        this.#dragOpenTimer = null;
        if (!this.host.openFolders.has(guid)) {
          this.host.toggleFolder(guid);
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
    const container = this.host.library ?? this.host;
    if (indicator.parentNode !== container) {
      container.append(indicator);
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
    if (background.parentNode !== this.host) {
      this.host.append(background);
      this.#dropBackgroundOrigin = null;
    }
    this.#dropBackgroundOrigin ??= this.#fixedOrigin(background);
    const { x, y } = this.#dropBackgroundOrigin;
    const margin = 2;
    const rect = row.getBoundingClientRect();
    // Nested folders are inset, so the band is as wide as the section.
    const area = this.host.getBoundingClientRect();
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
}
