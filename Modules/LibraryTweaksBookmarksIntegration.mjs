import { isRootFolder } from "./LibraryTweaksBookmarksData.mjs";
import { STRINGS } from "./LibraryTweaksShared.mjs";

const PLACES_CONTROLLER_URL = "chrome://browser/content/places/controller.js";
const ROOT_BLOCKED_COMMANDS = new Set(["placesCmd_cut", "placesCmd_copy", "placesCmd_delete"]);
const DRAG_OPEN_DELAY_MS = 600;
const FOLDER_DRAGOVER_PREF = "zen.tabs.folder-dragover-threshold-percent";
const MOVE_OVER_PREF = "browser.tabs.dragDrop.moveOverThresholdPercent";
const DROP_ANIMATION_MS = 100;
const DROP_SETTLE_TIMEOUT_MS = 800;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PlacesBackups: "resource://gre/modules/PlacesBackups.sys.mjs",
  BookmarkHTMLUtils: "resource://gre/modules/BookmarkHTMLUtils.sys.mjs",
  BookmarkJSONUtils: "resource://gre/modules/BookmarkJSONUtils.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "zenDnD", () => {
  try {
    return Cc["@mozilla.org/zen/drag-and-drop;1"].getService(Ci.nsIZenDragAndDrop);
  } catch (ex) {
    console.warn("Zen drag and drop service missing", ex);
    return null;
  }
});

/**
 * Returns native PlacesControllerClass constructor.
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
 * Returns native PlacesControllerDragHelper constructor.
 */
export function getPlacesDragHelper() {
  getPlacesControllerClass();
  return typeof PlacesControllerDragHelper === "undefined" ? null : PlacesControllerDragHelper;
}

/**
 * Normalizes insertion indices relative to native XPCOM targets.
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
 * Virtual view mapping native Places events into Library row logic.
 */
export class BookmarksPlacesView {
  #results = new Map();
  #node = null;
  #index = 0;
  #controller = null;
  #cutting = new Set();
  onCutChanged = null;
  _contextMenuShown = false;
  isContextMenu = true;
  flatList = false;
  singleClickOpens = true;

  get ownerWindow() { return window; }
  get ownerDocument() { return document; }

  get controller() {
    if (!this.#controller) {
      const Controller = getPlacesControllerClass();
      this.#controller = Controller ? new Controller(this) : null;
    }
    return this.#controller;
  }

  get selectedNode() { return this.#node; }
  get selectedNodes() { return this.#node ? [this.#node] : []; }

  get controllers() {
    return {
      getControllerForCommand: command => {
        const controller = this.controller;
        if (!controller?.supportsCommand(command)) return null;
        return this.#isRootSelected() ? this.#guard(controller) : controller;
      },
    };
  }

  #isRootSelected() {
    return !!this.#node && isRootFolder(this.#node.bookmarkGuid);
  }

  #guard(controller) {
    return {
      supportsCommand: command => controller.supportsCommand(command),
      isCommandEnabled: command => !ROOT_BLOCKED_COMMANDS.has(command) && controller.isCommandEnabled(command),
      doCommand: command => ROOT_BLOCKED_COMMANDS.has(command) ? undefined : controller.doCommand(command),
      onEvent: event => controller.onEvent?.(event),
    };
  }

  get removableSelectionRanges() { return this.#node ? [this.selectedNodes] : []; }
  get hasSelection() { return !!this.#node; }
  get draggableSelection() { return this.selectedNodes; }

  get result() {
    if (this.#node) return this.#node.parentResult ?? null;
    const guid = lazy.PlacesUtils.bookmarks.menuGuid;
    if (!this.#results.has(guid)) {
      const result = lazy.PlacesUtils.getFolderContents(guid);
      if (result) this.#results.set(guid, result);
    }
    return this.#results.get(guid) ?? null;
  }

  get insertionPoint() {
    const node = this.#node;
    if (!node) return null;
    const { bookmarks } = lazy.PlacesUtils;
    const inside = lazy.PlacesUtils.nodeIsFolderOrShortcut(node);
    const guid = inside ? node.bookmarkGuid : node.parent?.bookmarkGuid;
    const index = inside ? bookmarks.DEFAULT_INDEX : this.#index + 1;
    return makeInsertionPoint(guid, index);
  }

  buildContextMenu(popup) {
    this._contextMenuShown = true;
    window.updateCommands?.("places");
    const show = this.controller.buildContextMenu(popup);
    
    if (show && this.#isRootSelected()) {
      for (const command of ROOT_BLOCKED_COMMANDS) {
        for (const item of popup.querySelectorAll(`[command="${command}"]`)) {
          item.hidden = true;
        }
      }
    }
    return show;
  }

  destroyContextMenu() {
    setTimeout(() => { this._contextMenuShown = false; }, 0);
  }

  selectItems() {}
  selectAll() {}
  selectPlaceURI() {}
  focus() {}

  select({ guid, parentGuid, index }) {
    this.#node = this.#find(parentGuid, guid);
    this.#index = index ?? 0;
    return this.#node;
  }

  toggleCutNode(node, cutting) {
    const { bookmarkGuid } = node;
    if (this.#cutting.has(bookmarkGuid) === !!cutting) return;
    
    if (cutting) this.#cutting.add(bookmarkGuid);
    else this.#cutting.delete(bookmarkGuid);
    
    this.onCutChanged?.();
  }

  isCut({ guid }) { return this.#cutting.has(guid); }

  #find(parentGuid, guid) {
    let result = this.#results.get(parentGuid);
    if (!result) {
      result = lazy.PlacesUtils.getFolderContents(parentGuid);
      if (!result) return null;
      this.#results.set(parentGuid, result);
    }
    const { root } = result;
    for (let i = 0; i < root.childCount; i++) {
      const child = root.getChild(i);
      if (child.bookmarkGuid === guid) return child;
    }
    return null;
  }

  folderNode(guid) {
    let result = this.#results.get(guid);
    if (!result) {
      result = lazy.PlacesUtils.getFolderContents(guid);
      if (!result) return null;
      this.#results.set(guid, result);
    }
    return result.root;
  }

  close() {
    for (const result of this.#results.values()) {
      try { result.root.containerOpen = false; } catch (ex) {}
    }
    this.#results.clear();
    this.#cutting.clear();
    this.#node = null;
    this.#controller = null;
  }
}

/**
 * Connects Library rows dragging logic into native macOS/Windows interaction pipelines.
 */
export class BookmarksDragAndDrop {
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
  #collapsedForDrag = null;
  #dropSnapshot = null;
  #dropSnapshotTimer = null;
  #droppedGuid = null;
  #holdRestore = false;

  constructor(host) {
    this.host = host;
  }

  get landingGuid() { return this.#landingGuid; }

  attach() {
    for (const [type, listener] of this.#dropListeners) {
      this.host.addEventListener(type, listener);
    }
  }

  detach() {
    for (const [type, listener] of this.#dropListeners) {
      this.host.removeEventListener(type, listener);
    }
    this.#clearDropSnapshot();
    this.#endDrag();
  }

  start(event, item) {
    event.stopPropagation();
    if (!this.isDraggable(item)) {
      event.preventDefault();
      return;
    }
    
    const view = this.host.placesView;
    const { dataTransfer } = event;
    let node = null;
    
    try { node = view?.select(item); } catch (ex) { console.error("Places lookup failed", ex); }
    
    const controller = view?.controller;
    if (node && controller) {
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

  #beginDrag(event, item) {
    this.#clearDropSnapshot();
    this.#endDrag();
    
    const source = event.currentTarget;
    const rect = source.getBoundingClientRect();
    this.#dragItem = item;
    this.#dragSize = { width: rect.width, height: rect.height };

    lazy.zenDnD?.onDragStart(1);
    this.#landingWanted = typeof AppConstants !== "undefined" && AppConstants.platform === "macosx" && !(typeof gReduceMotion !== "undefined" && gReduceMotion);
    lazy.zenDnD?.armDropLanding(this.#landingWanted);

    this.#dragImage = this.#createDragImage(source);
    event.dataTransfer.setDragImage(this.#dragImage, event.clientX - rect.left, event.clientY - rect.top);
    
    source.addEventListener("dragend", () => this.#endDrag(), { once: true });
    Services.zen.playHapticFeedback();
    this.#collapseForDrag(item);
  }

  #collapseForDrag(item) {
    if (item.type !== "folder" || !this.host.openFolders.has(item.guid)) return;
    setTimeout(() => {
      if (this.#dragItem?.guid !== item.guid || !this.host.openFolders.has(item.guid)) return;
      this.#collapsedForDrag = item.guid;
      this.host.openFolders.delete(item.guid);
      this.host.requestUpdate();
    }, 0);
  }

  #restoreDraggedFolder() {
    const guid = this.#collapsedForDrag;
    if (!guid) return;
    this.#collapsedForDrag = null;
    if (!this.host.openFolders.has(guid)) {
      this.host.openFolders.add(guid);
      this.host.requestUpdate();
    }
  }

  #createDragImage(source) {
    const { width, height } = source.getBoundingClientRect();
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `position: fixed; top: -9999px; width: ${width}px; height: ${height}px;`;
    
    const computed = getComputedStyle(source);
    wrapper.style.color = computed.color;
    wrapper.style.colorScheme = computed.colorScheme;
    wrapper.style.fontWeight = computed.fontWeight;
    
    const clone = source.cloneNode(true);
    for (const attribute of ["cutting", "context-active", "drop-zone"]) clone.removeAttribute(attribute);
    clone.querySelector(".zen-library-drop-indicator")?.remove();
    
    if (Services.appinfo.OS === "WINNT") {
      clone.style.colorScheme = "light";
      clone.style.color = "black";
    }
    clone.setAttribute("drag-image", "true");
    wrapper.append(clone);
    document.documentElement.append(wrapper);
    return wrapper;
  }

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
    if (!this.#holdRestore) this.#restoreDraggedFolder();
  }

  #snapshotRows(droppedGuid) {
    if (typeof gReduceMotion !== "undefined" && gReduceMotion) return;
    
    const rows = new Map();
    for (const row of this.host.querySelectorAll(".zen-library-row")) {
      const guid = row.libraryItem?.guid;
      if (!guid || row.closest(".zen-library-folder-children[inert]")) continue;
      
      const { top, bottom, height } = row.getBoundingClientRect();
      if (height && bottom > 0 && top < window.innerHeight) {
        rows.set(guid, top);
      }
    }
    
    clearTimeout(this.#dropSnapshotTimer);
    this.#dropSnapshot = rows;
    this.#droppedGuid = droppedGuid;
    this.#holdRestore = true;
    this.#dropSnapshotTimer = setTimeout(() => this.#clearDropSnapshot(), DROP_SETTLE_TIMEOUT_MS);
  }

  #clearDropSnapshot() {
    clearTimeout(this.#dropSnapshotTimer);
    this.#dropSnapshotTimer = null;
    this.#dropSnapshot = null;
    this.#droppedGuid = null;
    this.#holdRestore = false;
    this.#restoreDraggedFolder();
  }

  playDropAnimation() {
    const before = this.#dropSnapshot;
    if (!before) return;
    
    const moves = [];
    for (const row of this.host.querySelectorAll(".zen-library-row")) {
      const guid = row.libraryItem?.guid;
      const top = before.get(guid);
      
      if (top === undefined || row.hasAttribute("landing") || row.closest(".zen-library-folder-children[inert]")) continue;
      
      const delta = top - row.getBoundingClientRect().top;
      if (Math.abs(delta) >= 1) moves.push({ row, delta, dropped: guid === this.#droppedGuid });
    }
    
    if (!moves.length) return;
    
    clearTimeout(this.#dropSnapshotTimer);
    this.#dropSnapshotTimer = null;
    this.#dropSnapshot = null;
    
    Promise.allSettled(moves.map(({ row, delta, dropped }) => this.#slideRow(row, delta, dropped))).then(() => {
      this.#droppedGuid = null;
      this.#holdRestore = false;
      this.#restoreDraggedFolder();
    });
  }

  #slideRow(row, delta, dropped) {
    row.style.transform = `translateY(${delta}px)`;
    if (dropped) row.style.zIndex = "9";
    
    const options = { duration: DROP_ANIMATION_MS, easing: "ease-out" };
    let animation;
    try {
      animation = typeof gZenUIManager !== "undefined" && gZenUIManager.elementAnimate
          ? gZenUIManager.elementAnimate(row, { y: [delta, 0] }, options)
          : row.animate({ transform: [`translateY(${delta}px)`, "translateY(0)"] }, options).finished;
    } catch (ex) {
      animation = Promise.resolve();
    }
    return Promise.resolve(animation).catch(() => {}).finally(() => {
      row.style.transform = "";
      row.style.zIndex = "";
    });
  }

  isDraggable(item) {
    return !isRootFolder(item.guid);
  }

  #dropPoint(event, row) {
    const item = row.libraryItem;
    const { bookmarks } = lazy.PlacesUtils;
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    
    const inside = { point: makeInsertionPoint(item.guid, bookmarks.DEFAULT_INDEX), zone: "inside" };
    const before = { point: makeInsertionPoint(item.parentGuid, item.index), zone: "before" };
    
    if (item.type === "folder") {
      const percent = Services.prefs.getIntPref(FOLDER_DRAGOVER_PREF, 25);
      const edge = percent / 100;
      const nearEdge = ratio < edge || ratio > 1 - edge;
      
      if (!this.isDraggable(item) || !nearEdge) return inside;
      if (ratio < edge) return before;
      if (this.host.openFolders.has(item.guid)) return { point: makeInsertionPoint(item.guid, 0), zone: "after" };
    } else {
      const threshold = Services.prefs.getIntPref(MOVE_OVER_PREF, 50) / 100;
      if (ratio <= threshold) return before;
    }
    return { point: makeInsertionPoint(item.parentGuid, item.index + 1), zone: "after" };
  }

  #dropRowOf(event) {
    if (!this.host.acceptsDrops) return null;
    const row = event.target.closest?.(".zen-library-row");
    return row?.libraryItem ? row : null;
  }

  #landsInsideDragged(folderGuid) {
    const dragged = this.#dragItem;
    if (dragged?.type !== "folder") return false;
    
    const { rootGuid } = lazy.PlacesUtils.bookmarks;
    let guid = folderGuid;
    for (let hops = 0; guid && guid !== rootGuid && hops < 64; hops++) {
      if (guid === dragged.guid) return true;
      guid = this.host.parentOf(guid);
    }
    return false;
  }

  #canDrop(point, dataTransfer) {
    const helper = getPlacesDragHelper();
    if (!helper || this.#landsInsideDragged(point.guid)) return false;
    
    helper.currentDropTarget = this.host.placesView?.folderNode(point.guid) ?? {};
    try {
      return !!helper.canDrop(point, dataTransfer);
    } catch (ex) {
      return false;
    } finally {
      helper.currentDropTarget = null;
    }
  }

  #onDragOver = event => {
    const row = this.#dropRowOf(event);
    if (!row) return;
    
    const drop = this.#dropPoint(event, row);
    if (!this.#canDrop(drop.point, event.dataTransfer)) {
      this.#clearDrop();
      return;
    }
    
    event.preventDefault();
    this.#showDrop(row, drop.zone);
    lazy.zenDnD?.armDropLanding(this.#landingWanted && event.dataTransfer.dropEffect === "move");
  };

  #onDragLeave = event => {
    const row = event.target.closest?.(".zen-library-row");
    if (row && row === this.#dropRow && !row.contains(event.relatedTarget)) this.#clearDrop();
  };

  #onDrop = event => {
    const row = this.#dropRowOf(event);
    const helper = getPlacesDragHelper();
    if (!row || !helper) return;
    
    const drop = this.#dropPoint(event, row);
    const { dataTransfer } = event;
    this.#clearDrop();
    
    if (!this.#canDrop(drop.point, dataTransfer)) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    if (dataTransfer.dropEffect === "move") {
      this.#snapshotRows(this.#dragItem?.guid ?? null);
      if (this.#landingWanted) this.#landDragImage(row, drop.zone);
    }
    
    Promise.resolve(helper.onDrop(drop.point, dataTransfer, this.host.placesView))
      .catch(ex => console.error("Failed to drop", ex));
  };

  #dropListeners = [
    ["dragover", this.#onDragOver],
    ["dragleave", this.#onDragLeave],
    ["drop", this.#onDrop],
    ["dragend", () => this.#endDrag()],
  ];

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

  #showDrop(row, zone) {
    const { guid, type } = row.libraryItem;
    const key = `${guid}:${zone}`;
    
    if (key !== this.#dropKey) {
      if (this.#hapticReady) Services.zen.playHapticFeedback();
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

    const opens = zone === "inside" && type === "folder" && !this.host.openFolders.has(guid);
    if (!opens) {
      this.#cancelDragOpen();
    } else if (this.#dragOpenGuid !== guid) {
      this.#cancelDragOpen();
      this.#dragOpenGuid = guid;
      this.#dragOpenTimer = setTimeout(() => {
        this.#dragOpenTimer = null;
        if (!this.host.openFolders.has(guid)) this.host.toggleFolder(guid);
      }, DRAG_OPEN_DELAY_MS);
    }
  }

  #fixedOrigin(element) {
    element.style.left = element.style.top = "0px";
    const { left, top } = element.getBoundingClientRect();
    element.style.left = "";
    return { x: left, y: top };
  }

  #placeIndicator(row, zone) {
    const indicator = this.#indicator ?? (this.#indicator = Object.assign(document.createElement("div"), { className: "zen-library-drop-indicator" }));
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
    indicator.style.setProperty("--indicator-left", `${rect.left + separation / 2 - x}px`);
    indicator.style.setProperty("--indicator-width", `${rect.width - separation}px`);
    
    const top = zone === "before" ? rect.top : rect.bottom;
    indicator.style.top = `${Math.round(top) - y}px`;
  }

  #placeDropBackground(row) {
    const background = this.#dropBackground ?? (this.#dropBackground = Object.assign(document.createElement("div"), { className: "zen-library-drop-background" }));
    
    if (background.parentNode !== this.host) {
      this.host.append(background);
      this.#dropBackgroundOrigin = null;
    }
    
    this.#dropBackgroundOrigin ??= this.#fixedOrigin(background);
    const { x, y } = this.#dropBackgroundOrigin;
    const margin = 2;
    const rect = row.getBoundingClientRect();
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

/* Import and Backup */

const MIGRATION_UTILS_URLS = [
  "resource:///modules/MigrationUtils.sys.mjs",
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
];
const BACKUP_ITEM_CLASS = "zen-library-backup-item";
const SIZE_UNITS = ["bytes", "KB", "MB", "GB"];

function getMigrationUtils() {
  for (const url of MIGRATION_UTILS_URLS) {
    try {
      return ChromeUtils.importESModule(url).MigrationUtils;
    } catch (ex) {
      // The module moved between versions, so try the next location.
    }
  }
  return null;
}

function formatSize(bytes) {
  let unit = 0;
  while (bytes >= 1024 && unit < SIZE_UNITS.length - 1) {
    bytes /= 1024;
    unit++;
  }
  const value = unit ? bytes.toFixed(bytes < 10 ? 1 : 0) : bytes;
  return `${value} ${SIZE_UNITS[unit]}`;
}

function showError(message) {
  Services.prompt.alert(window, STRINGS["library-bookmarks-import-backup"], message);
}

/**
 * Opens a file picker and returns the chosen file, or null if it was cancelled.
 */
async function pickFile({ title, mode, filter, defaultString, directory }) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  picker.init(window.browsingContext, title, mode);
  picker.appendFilter(...filter);
  picker.appendFilters(Ci.nsIFilePicker.filterAll);
  if (defaultString) picker.defaultString = defaultString;
  if (directory) {
    try {
      picker.displayDirectory = new lazy.FileUtils.File(directory);
    } catch (ex) {
      // A missing directory just means the picker uses its default.
    }
  }

  const result = await new Promise(resolve => picker.open(resolve));
  const accepted = result === Ci.nsIFilePicker.returnOK || result === Ci.nsIFilePicker.returnReplace;
  return accepted ? picker.file : null;
}

async function restoreFromPath(path) {
  const lowerPath = path.toLowerCase();
  if (!lowerPath.endsWith(".json") && !lowerPath.endsWith(".jsonlz4")) {
    showError(STRINGS["library-bookmarks-restore-bad-format"]);
    return;
  }
  if (!(await IOUtils.exists(path))) {
    showError(STRINGS["library-bookmarks-restore-missing"]);
    return;
  }

  const confirmed = Services.prompt.confirm(
    window,
    STRINGS["library-bookmarks-restore-confirm-title"],
    STRINGS["library-bookmarks-restore-confirm-text"]
  );
  if (!confirmed) return;

  try {
    await lazy.BookmarkJSONUtils.importFromFile(path, { replace: true });
  } catch (ex) {
    console.error("Failed to restore bookmarks", ex);
    showError(STRINGS["library-bookmarks-restore-failed"]);
  }
}

const IMPORT_BACKUP_ACTIONS = {
  async backup() {
    const file = await pickFile({
      title: STRINGS["library-bookmarks-backup-title"],
      mode: Ci.nsIFilePicker.modeSave,
      filter: ["JSON", "*.json"],
      defaultString: lazy.PlacesBackups.getFilenameForDate(),
      directory: await lazy.PlacesBackups.getBackupFolder(),
    });
    if (file) await lazy.PlacesBackups.saveBookmarksToJSONFile(file.path);
  },

  async "restore-file"() {
    const file = await pickFile({
      title: STRINGS["library-bookmarks-restore-title"],
      mode: Ci.nsIFilePicker.modeOpen,
      filter: ["JSON", "*.json;*.jsonlz4"],
      directory: await lazy.PlacesBackups.getBackupFolder(),
    });
    if (file) await restoreFromPath(file.path);
  },

  "restore-backup": item => restoreFromPath(item.dataset.path),

  async "import-html"() {
    const file = await pickFile({
      title: STRINGS["library-bookmarks-import-html-title"],
      mode: Ci.nsIFilePicker.modeOpen,
      filter: ["HTML", "*.html;*.htm"],
    });
    if (file) await lazy.BookmarkHTMLUtils.importFromFile(file.path, { replace: false });
  },

  async "export-html"() {
    const file = await pickFile({
      title: STRINGS["library-bookmarks-export-html-title"],
      mode: Ci.nsIFilePicker.modeSave,
      filter: ["HTML", "*.html"],
      defaultString: "bookmarks.html",
    });
    if (file) await lazy.BookmarkHTMLUtils.exportToFile(file.path);
  },

  async "import-browser"() {
    const utils = getMigrationUtils();
    if (!utils) throw new Error("MigrationUtils is unavailable");
    utils.showMigrationWizard(window, { entrypoint: utils.MIGRATION_ENTRYPOINTS?.PLACES });
  },
};

/**
 * The popup behind the Library's "Import and Backup" button, mirroring the
 * native Places Organizer menu.
 */
/**
 * Runs one Import and Backup action without the popup, for the tab menu.
 * @param {string} name - A key of IMPORT_BACKUP_ACTIONS, like "export-html"
 * @param {Function} [keepOpen] - Runs the action while keeping the Library open.
 */
export function runImportBackupAction(name, keepOpen = action => action()) {
  const action = IMPORT_BACKUP_ACTIONS[name];
  if (!action) return Promise.resolve();
  return keepOpen(async () => {
    try {
      await action({ dataset: { action: name } });
    } catch (ex) {
      console.error(`Import and Backup action "${name}" failed`, ex);
      showError(STRINGS["library-bookmarks-action-failed"]);
    }
  });
}

export class ImportBackupMenu {
  #popup = null;
  #restorePopup = null;
  #anchor = null;
  #restoreGeneration = 0;
  #keepOpen;
  #onToggle;

  /**
   * @param {object} [options]
   * @param {Function} [options.keepOpen] - Runs an action while keeping the Library open.
   * @param {Function} [options.onToggle] - Called with (open, anchor) as the menu shows and hides.
   */
  constructor({ keepOpen = action => action(), onToggle = null } = {}) {
    this.#keepOpen = keepOpen;
    this.#onToggle = onToggle;
  }

  mount() {
    const label = id => STRINGS[id];
    const fragment = window.MozXULElement.parseXULToFragment(`
      <menupopup class="zen-library-import-backup-menu">
        <menuitem data-action="backup" label="${label("library-bookmarks-backup")}"/>
        <menu label="${label("library-bookmarks-restore")}">
          <menupopup class="zen-library-restore-popup">
            <menuseparator class="zen-library-restore-separator" hidden="true"/>
            <menuitem data-action="restore-file" label="${label("library-bookmarks-restore-file")}"/>
          </menupopup>
        </menu>
        <menuseparator/>
        <menuitem data-action="import-html" label="${label("library-bookmarks-import-html")}"/>
        <menuitem data-action="export-html" label="${label("library-bookmarks-export-html")}"/>
        <menuitem data-action="import-browser" label="${label("library-bookmarks-import-browser")}"/>
      </menupopup>
    `);

    this.#popup = fragment.firstElementChild;
    this.#restorePopup = this.#popup.querySelector(".zen-library-restore-popup");

    this.#popup.addEventListener("command", this.#onCommand);
    this.#popup.addEventListener("popupshown", this.#onShown);
    this.#popup.addEventListener("popuphidden", this.#onHidden);
    this.#restorePopup.addEventListener("popupshowing", this.#onRestoreShowing);

    document.getElementById("mainPopupSet").appendChild(this.#popup);
  }

  destroy() {
    this.#restoreGeneration++;
    this.#popup?.remove();
    this.#popup = null;
    this.#restorePopup = null;
    this.#anchor = null;
  }

  open(anchor) {
    if (!this.#popup) return;
    this.#anchor = anchor;
    this.#popup.openPopup(anchor, "after_start", 0, 2, false, false);
  }

  #onShown = event => {
    if (event.target === this.#popup) this.#onToggle?.(true, this.#anchor);
  };

  #onHidden = event => {
    if (event.target === this.#popup) this.#onToggle?.(false, this.#anchor);
  };

  #onCommand = event => {
    const item = event.target;
    const action = IMPORT_BACKUP_ACTIONS[item.dataset?.action];
    if (!action) return;

    this.#keepOpen(async () => {
      try {
        await action(item);
      } catch (ex) {
        console.error(`Import and Backup action "${item.dataset.action}" failed`, ex);
        showError(STRINGS["library-bookmarks-action-failed"]);
      }
    });
  };

  #onRestoreShowing = async event => {
    const popup = this.#restorePopup;
    if (event.target !== popup) return;

    const generation = ++this.#restoreGeneration;
    const separator = popup.querySelector(".zen-library-restore-separator");
    popup.querySelectorAll(`.${BACKUP_ITEM_CLASS}`).forEach(item => item.remove());
    separator.hidden = true;

    let paths;
    try {
      paths = await lazy.PlacesBackups.getBackupFiles();
    } catch (ex) {
      console.error("Failed to list bookmark backups", ex);
      return;
    }

    const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
    for (const path of paths) {
      let size;
      try {
        ({ size } = await IOUtils.stat(path));
      } catch (ex) {
        continue;
      }
      // The menu was closed or reopened while the files were being read.
      if (generation !== this.#restoreGeneration || !this.#popup) return;

      const count = lazy.PlacesBackups.getBookmarkCountForFile(path);
      const date = dateFormat.format(lazy.PlacesBackups.getDateForFile(path));
      const details = count == null
        ? formatSize(size)
        : `${formatSize(size)} - ${count} ${count === 1 ? "item" : "items"}`;

      const item = document.createXULElement("menuitem");
      item.className = BACKUP_ITEM_CLASS;
      item.dataset.action = "restore-backup";
      item.dataset.path = path;
      item.setAttribute("label", `${date} (${details})`);
      popup.insertBefore(item, separator);
      separator.hidden = false;
    }
  };
}
