import { STRINGS } from "./LibraryTweaksShared.mjs";

/*
 * Sidebar customization for the Zen Library: compact tabs, a tab density that follows the
 * window height, and an edit mode in which sections are reordered, removed and restored by
 * dragging.
 */

const ORDER_PREF = "librarytweaks-sections-order";
const COMPACT_PREF = "librarytweaks-sections-compact";
const REMOVED_PREF = "librarytweaks-sections-removed";

const TABS = "#zen-library-sidebar-tabs";
const EDIT_PANE_ID = "zen-library-edit-pane";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SHIFT_DISTANCE = "--zen-library-tab-shift-distance";

const BRUSH_ICON = "chrome://browser/skin/zen-icons/selectable/brush.svg";
const INBOX_ICON = "chrome://browser/skin/zen-icons/selectable/inbox.svg";
// The mod's own icon. The `image` attribute is read against the browser window, so it is
// resolved from this module's URL instead of the mod folder.
const CHECK_ICON = new URL("./Icons/tick.svg", import.meta.url).href;

const TEXT = {
  edit: "Customize Sections",
  storage: "Storage",
  emptyTitle: "Nothing removed",
  emptyBody: "Drag a section here to take it off the sidebar. Drag it back out, or click it, to bring it back.",
  remove: "Remove section",
  restore: "Restore section",
};

// Pointer travel (px) before pressing a removed section counts as a drag, not a click.
const DRAG_THRESHOLD = 5;
// Gap between two tabs: their margins (8 + 8) and the gap between them (8).
const TAB_SPACING = 24;

// --- Small helpers ---

const bounds = element => window.windowUtils.getBoundsWithoutFlushing(element);
const centerY = rect => rect.top + rect.height / 2;
const contains = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
// Which slot a point falls in, given the centers of the slots.
const slotIndex = (centers, y) => centers.filter(center => y > center).length;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

/** Creates an XHTML element: `h("div", { class: "x" }, child, "text")`. */
function h(tag, attributes = {}, ...children) {
  const element = document.createElementNS(XHTML_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

/**
 * Follows a pointer drag that starts with `event`. The element keeps the pointer, so the
 * drag goes on wherever the pointer travels.
 *
 * - `onStart` runs once the pointer has moved `threshold` px (at once when it is 0).
 * - `onMove` runs for every move after that.
 * - `onEnd(commit)` runs when the drag finishes. `commit` is false if it was cancelled,
 *   by Escape or by the system. It does not run if the drag never started.
 *
 * @returns {{cancel: () => void}}
 */
function trackDrag(element, event, { threshold = 0, onStart, onMove, onEnd }) {
  const { pointerId, clientX, clientY } = event;
  let started = false;
  let finished = false;

  // Escape is seen before the Library's own handler, which would close the whole Library.
  const onEscape = keyEvent => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    keyEvent.stopImmediatePropagation();
    finish(false);
  };

  const start = () => {
    started = true;
    window.addEventListener("keydown", onEscape, true);
    onStart();
  };

  const onPointerMove = moveEvent => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!started && Math.hypot(moveEvent.clientX - clientX, moveEvent.clientY - clientY) >= threshold) {
      start();
    }
    if (started) onMove(moveEvent);
  };

  const onPointerEnd = endEvent => {
    if (endEvent.pointerId === pointerId) finish(endEvent.type === "pointerup");
  };

  function finish(commit) {
    if (finished) return;
    finished = true;
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerEnd);
    element.removeEventListener("pointercancel", onPointerEnd);
    window.removeEventListener("keydown", onEscape, true);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    if (started) onEnd(commit);
  }

  element.setPointerCapture(pointerId);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  event.preventDefault();
  if (!threshold) start();

  return { cancel: () => finish(false) };
}

// --- Compact mode ---

function isCompact() {
  try {
    return Services.prefs.getBoolPref(COMPACT_PREF);
  } catch {
    return Services.prefs.getIntPref(COMPACT_PREF, 0) !== 0;
  }
}

function applyCompact(library) {
  library.querySelector(TABS)?.toggleAttribute("compact", isCompact());
}

// --- Adaptive density ---
//
// Zen hides the tab labels below a fixed window height, which is what five labelled tabs
// need. With more sections that is too low, so the same kind of rules is generated here
// from the number of tabs that are shown. As the window gets shorter:
//   labels -> icons only -> icons only with spacing that shrinks smoothly -> scrolling list

const NATIVE_LABEL_HEIGHT = 575; // Zen's own threshold, for NATIVE_TAB_COUNT tabs
const NATIVE_TAB_COUNT = 5;
const ICON_SIZE = 28;
// Vertical spacing around an icon: margin 8+8, padding 16+16 and a gap of 8. It shrinks
// from MAX_SPACE to MIN_SPACE, split 1 : 2 : 1 (margin : padding : gap), before the list scrolls.
const MAX_SPACE = 56;
const MIN_SPACE = 26;
const TAB_HEIGHT = {
  labels: 104,
  icons: ICON_SIZE + MAX_SPACE,
  tight: ICON_SIZE + MIN_SPACE,
};
// What is left of Zen's threshold once the tabs are taken out: the footer and the paddings.
const FIXED_HEIGHT = NATIVE_LABEL_HEIGHT - NATIVE_TAB_COUNT * TAB_HEIGHT.labels;

function buildDensityCSS(count) {
  const heightFor = tab => FIXED_HEIGHT + count * tab;
  // !important: the native rules live in a stylesheet this one does not control.
  return `
@media (height > ${heightFor(TAB_HEIGHT.labels)}px) {
  ${TABS}:not([compact]) .zen-library-tab label { display: block !important; }
}
@media (height <= ${heightFor(TAB_HEIGHT.labels)}px) {
  ${TABS} .zen-library-tab label { display: none !important; }
}
@media (height <= ${heightFor(TAB_HEIGHT.icons)}px) {
  ${TABS} {
    --lt-space: clamp(${MIN_SPACE}px, calc((100vh - ${FIXED_HEIGHT}px) / ${count} - ${ICON_SIZE}px), ${MAX_SPACE}px);
    gap: calc(var(--lt-space) / 7) !important;
  }
  ${TABS} .zen-library-tab {
    margin-block: calc(var(--lt-space) / 7) !important;
    padding-block: calc(var(--lt-space) * 2 / 7) !important;
  }
}
@media (height <= ${heightFor(TAB_HEIGHT.tight)}px) {
  ${TABS} {
    flex: 1 1 0 !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    scrollbar-width: none;
  }
}
`;
}

let appliedTabCount = 0;

function applyDensity(list) {
  const count = list.querySelectorAll(".zen-library-tab:not([hidden])").length;
  if (!count || count === appliedTabCount) return;
  appliedTabCount = count;

  let style = document.getElementById("librarytweaks-density");
  if (!style) {
    style = h("style", { id: "librarytweaks-density" });
    (document.head ?? document.documentElement).append(style);
  }
  style.textContent = buildDensityCSS(count);
}

// --- Sections: order and removed ---
//
// Each library keeps a catalog of all its sections, removed ones included, in the order
// the user arranged them. The library itself is given only the sections that are not
// removed, so Zen renders tabs and content for those and nothing else. That also keeps
// `toggle(id)` and the bookmarks sidebar hook working: both ignore ids that are not in
// `zenLibrarySections`.

const catalogs = new WeakMap(); // library -> Map(id -> Section)

const readIds = pref => Services.prefs.getStringPref(pref, "").split(",").filter(Boolean);
const writeIds = (pref, ids) => Services.prefs.setStringPref(pref, [...new Set(ids)].join(","));

function setCatalog(library, catalog, ids) {
  catalogs.set(library, new Map(ids.map(id => [id, catalog.get(id)])));
}

function removedIds(catalog) {
  const removed = new Set(readIds(REMOVED_PREF).filter(id => catalog.has(id)));
  // A pref that would leave nothing to show is ignored.
  return removed.size < catalog.size ? removed : new Set();
}

function publishSections(library) {
  const catalog = catalogs.get(library);
  const removed = removedIds(catalog);
  const visible = Object.fromEntries([...catalog].filter(([id]) => !removed.has(id)));
  library.zenLibrarySections = new Proxy(visible, {
    // A section removed while the library is open can still be mounted until it closes, and
    // Zen renders what is mounted by looking it up here. It is not listed, and
    // `id in sections` is false for it, but it has to stay readable.
    get: (target, id) => target[id] ?? catalog.get(id),
  });
}

/**
 * Applies the saved order and the removed sections to the library.
 * @param {HTMLElement} library
 */
export function applySections(library) {
  const catalog = catalogs.get(library) ?? new Map();
  for (const [id, Section] of Object.entries(library.zenLibrarySections)) {
    catalog.set(id, Section);
  }

  const saved = readIds(ORDER_PREF);
  setCatalog(library, catalog, [
    ...saved.filter(id => catalog.has(id)),
    ...[...catalog.keys()].filter(id => !saved.includes(id)),
  ]);
  publishSections(library);

  if (!(library.activeTab in library.zenLibrarySections)) {
    library.activeTab = Object.keys(library.zenLibrarySections)[0];
  }
}

function removeSection(library, id) {
  const visible = Object.keys(library.zenLibrarySections);
  if (!visible.includes(id) || visible.length <= 1) return false;

  if (library.activeTab === id) {
    const others = visible.filter(other => other !== id);
    library.activeTab = others[Math.min(visible.indexOf(id), others.length - 1)];
  }
  writeIds(REMOVED_PREF, [...readIds(REMOVED_PREF), id]);
  publishSections(library);
  return true;
}

function restoreSection(library, id) {
  if (!catalogs.get(library)?.has(id) || id in library.zenLibrarySections) return false;

  writeIds(REMOVED_PREF, readIds(REMOVED_PREF).filter(other => other !== id));
  publishSections(library);
  return true;
}

/**
 * Stores a new order for the sections that are shown. Removed ones keep the slot they had,
 * so restoring one puts it back where it was.
 */
function reorderSections(library, visibleIds) {
  const catalog = catalogs.get(library);
  const queue = [...visibleIds];
  const ids = [...catalog.keys()].map(id => (visibleIds.includes(id) ? queue.shift() : id));

  setCatalog(library, catalog, ids);
  // Ids this window does not have (no Spaces in a private window) are kept as they were.
  const unknown = readIds(ORDER_PREF).filter(id => !catalog.has(id));
  writeIds(ORDER_PREF, [...ids, ...unknown]);
  publishSections(library);
}

function removedSections(library) {
  const catalog = catalogs.get(library) ?? new Map();
  return [...catalog]
    .filter(([id]) => !(id in library.zenLibrarySections))
    .map(([id, Section]) => ({ id, Section }));
}

async function sectionLabel(Section) {
  const l10nId = Section.tabLabel ?? Section.label;
  return STRINGS[Section.label] ?? (l10nId ? await document.l10n?.formatValue(l10nId) : null) ?? Section.id;
}

// --- Edit mode ---

class SidebarController {
  #library;
  #wiredList = null;
  #editButton = null;
  #pane = null;
  #editing = false;
  // True while a drag or a change is under way, so nothing else starts meanwhile.
  #busy = false;
  #drag = null;
  // Set when a removed section was dragged, so the click that follows does not restore it.
  #dragged = false;

  constructor(library) {
    this.#library = library;
  }

  get isEditing() { return this.#editing; }
  get #list() { return this.#library.querySelector(TABS); }
  get #tabs() { return [...(this.#list?.querySelectorAll(".zen-library-tab") ?? [])]; }
  get #dropbox() { return this.#pane?.querySelector(".lt-removed-box"); }

  init() {
    this.#ensureEditButton();
    this.#ensurePane();
    this.#wire();
    applyCompact(this.#library);
  }

  toggleEditMode() {
    this.setEditMode(!this.#editing);
  }

  setEditMode(value) {
    this.#editing = value;
    // Leaving edit mode drops whatever drag is still going on.
    if (!value) this.#drag?.cancel();

    this.#library.toggleAttribute("lt-editing", value);
    this.#list?.toggleAttribute("editing", value);
    this.#editButton?.toggleAttribute("checked", value);
    this.#editButton?.setAttribute("image", value ? CHECK_ICON : BRUSH_ICON);

    const pane = this.#ensurePane();
    if (pane) pane.hidden = !value;
    if (value) {
      this.#syncRemoveButtons();
      this.#renderRemoved();
    }
  }

  // --- Setup ---

  #ensureEditButton() {
    const footer = this.#library.querySelector("#zen-library-footer");
    if (!footer) return;

    this.#editButton = footer.querySelector("#zen-library-footer-edit-sections");
    if (this.#editButton) return;

    const button = document.createXULElement("toolbarbutton");
    button.id = "zen-library-footer-edit-sections";
    button.className = "toolbarbutton-1";
    button.setAttribute("image", BRUSH_ICON);
    button.setAttribute("tooltiptext", TEXT.edit);
    button.addEventListener("command", () => this.toggleEditMode());

    const first = footer.querySelector(".toolbarbutton-1");
    if (first) first.after(button);
    else footer.append(button);
    this.#editButton = button;
  }

  /**
   * The edit mode pane: a section-like element in the content area. Like the native
   * sections it is hidden with the `hidden` attribute, and it is only shown while editing.
   * It is not part of `zenLibrarySections`, so it has no tab and never touches `activeTab`.
   */
  #ensurePane() {
    if (this.#pane?.isConnected) return this.#pane;
    const content = this.#library.querySelector("#zen-library-content");
    if (!content) return null;

    // The empty state is laid out like the Media section's opt-in, without a card or button.
    const pane = h("div", { class: "zen-library-section", id: EDIT_PANE_ID },
      h("div", { class: "lt-removed-box" },
        h("div", { class: "lt-removed-title", role: "heading", "aria-level": "2" }, TEXT.storage),
        h("div", { class: "lt-removed-body" },
          h("div", { class: "lt-removed-placeholder" },
            h("img", { class: "lt-removed-placeholder-icon", src: INBOX_ICON, alt: "" }),
            h("h3", {}, TEXT.emptyTitle),
            h("p", {}, TEXT.emptyBody)
          ),
          h("div", { class: "lt-removed-grid" })
        )
      )
    );
    pane.hidden = true;

    pane.addEventListener("pointerdown", event => this.#onDown(event));
    pane.addEventListener("click", event => {
      if (!this.#dragged) this.#restoreFrom(event);
    });
    pane.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") this.#restoreFrom(event);
    });

    content.append(pane);
    this.#pane = pane;
    return pane;
  }

  /** Listens on the tab list, once per list element. */
  #wire() {
    const list = this.#list;
    if (!list || list === this.#wiredList) return;
    this.#wiredList = list;

    // While editing, a click only ever means the remove button.
    list.addEventListener("click", event => {
      if (!this.#editing) return;
      event.preventDefault();
      event.stopPropagation();
      this.#onTabClick(event);
    }, true);
    list.addEventListener("pointerdown", event => this.#onDown(event));

    // Sections can be added, hidden or shown after the first render.
    applyDensity(list);
    new MutationObserver(() => applyDensity(list)).observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }

  // --- Rendering ---

  #renderRemoved() {
    const pane = this.#ensurePane();
    if (!pane) return;

    const removed = removedSections(this.#library);
    pane.querySelector(".lt-removed-box").toggleAttribute("empty", !removed.length);
    pane.querySelector(".lt-removed-grid").replaceChildren(
      ...removed.map(({ id, Section }) => {
        const label = h("span", { class: "lt-removed-chip-label" });
        // `data-section` picks up the section's sprite icon from the native CSS.
        const chip = h("div", { class: "lt-removed-chip", "data-section": id, role: "button", tabindex: "0", title: TEXT.restore },
          h("div", { class: "lt-removed-chip-icon" }, h("div", { class: "zen-library-tab-icon-image" })),
          label,
          h("div", { class: "lt-restore-button" })
        );
        sectionLabel(Section).then(text => {
          label.textContent = text;
          chip.setAttribute("aria-label", `${TEXT.restore}: ${text}`);
        });
        return chip;
      })
    );
  }

  /**
   * Gives every tab its remove button. Zen reuses the tab elements by position when the
   * sections change, so this runs after each update to cover tabs it has added.
   */
  #syncRemoveButtons() {
    const tabs = this.#tabs;
    for (const tab of tabs) {
      let button = tab.querySelector(".lt-remove-button");
      if (!button) {
        button = h("div", { class: "lt-remove-button", role: "button", "aria-label": TEXT.remove, title: TEXT.remove });
        tab.append(button);
      }
      // The last section left cannot be removed.
      button.toggleAttribute("disabled", tabs.length <= 1);
    }
  }

  async #refresh() {
    const library = this.#library;
    // Zen reuses the tab elements by position, so the animation mark is put back by id.
    const animated = this.#list?.querySelector(".zen-library-tab[animate]")?.dataset.section;

    library.requestUpdate();
    await library.updateComplete;

    for (const tab of this.#tabs) {
      tab.toggleAttribute("animate", tab.dataset.section === animated);
    }
    window.gLibraryTweaks?.applyTabLabels(library);
    this.#syncRemoveButtons();
    this.#renderRemoved();
  }

  // --- Changes ---

  /**
   * Runs a change to which sections are shown, then brings the UI up to date.
   * @param {() => boolean} change - Returns whether anything changed
   */
  async #change(change) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (change()) await this.#refresh();
    } finally {
      this.#busy = false;
    }
  }

  #onTabClick(event) {
    const button = event.target.closest(".lt-remove-button");
    if (!button || button.hasAttribute("disabled")) return;

    const id = button.closest(".zen-library-tab").dataset.section;
    this.#change(() => removeSection(this.#library, id));
  }

  #restoreFrom(event) {
    const chip = event.target.closest?.(".lt-removed-chip");
    if (!chip) return;

    event.preventDefault();
    this.#change(() => restoreSection(this.#library, chip.dataset.section));
  }

  /** Puts a section in a slot of the sidebar, restoring it first if it was removed. */
  async #place(id, to) {
    const library = this.#library;
    const ids = this.#tabs.map(tab => tab.dataset.section).filter(other => other !== id);
    if (!(id in library.zenLibrarySections) && !restoreSection(library, id)) return;

    ids.splice(to, 0, id);
    reorderSections(library, ids);
    await this.#refresh();
  }

  // --- Dragging ---
  //
  // One drag for everything, in the way of the Spaces cards: the dragged element follows
  // the pointer, the tabs around it shift to open a slot, and the change is applied on
  // release.
  //   - A tab is reordered within the sidebar, or carried to the Storage box to remove it.
  //   - A removed section (a chip in the box) is carried back into a slot of the sidebar.
  // A removed section is dragged as a ghost that lives in the library itself, because the
  // box clips whatever leaves it. A plain click on one still restores it in its old slot.

  #onDown(event) {
    if (!this.#editing || this.#busy || event.button !== 0) return;
    if (event.target.closest(".lt-remove-button")) return;

    const item = event.target.closest(".zen-library-tab, .lt-removed-chip");
    if (!item) return;

    this.#dragged = false;
    this.#startDrag(item, event);
  }

  #startDrag(item, event) {
    const library = this.#library;
    const list = this.#list;
    const box = this.#dropbox;
    const isTab = item.classList.contains("zen-library-tab");

    const tabs = this.#tabs;
    const rects = tabs.map(bounds);
    // A removed section is dragged in as if it sat one past the last tab.
    const from = isTab ? tabs.indexOf(item) : tabs.length;
    const home = centerY(isTab ? rects[from] : bounds(item));
    const slots = rects.filter((rect, i) => i !== from).map(centerY);
    // How far a tab moves to open a slot: the distance between two neighbouring tabs.
    const spacing = rects.length > 1 ? rects[1].top - rects[0].top : (rects[0]?.height ?? 0) + TAB_SPACING;

    const listRect = bounds(list);
    const sideRect = bounds(library.querySelector("#zen-library-side"));
    // The last section left cannot be removed, so there is no box to carry it to.
    const boxRect = isTab && tabs.length > 1 && box ? bounds(box) : null;
    const scrollStart = list.scrollTop;

    let ghost = null;
    let to = from;
    let removing = false;

    this.#drag = trackDrag(item, event, {
      threshold: isTab ? 0 : DRAG_THRESHOLD,

      onStart: () => {
        this.#busy = true;
        this.#dragged = true;
        item.setAttribute("dragging", "");
        list.style.setProperty(SHIFT_DISTANCE, `${spacing}px`);
        if (isTab) return;

        const rect = bounds(item);
        const libRect = bounds(library);
        ghost = item.cloneNode(true);
        ghost.classList.add("lt-chip-ghost");
        for (const name of ["title", "tabindex", "role", "aria-label"]) ghost.removeAttribute(name);
        ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, {
          left: `${rect.left - libRect.left}px`,
          top: `${rect.top - libRect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        library.append(ghost);
      },

      onMove: ({ clientX: x, clientY: y }) => {
        const dx = x - event.clientX;
        const dy = y - event.clientY;
        const scrolled = list.scrollTop - scrollStart;

        if (isTab) {
          // Past the sides of the list the tab follows the pointer sideways too, so it can
          // be carried to the Storage box.
          const sideways = x < listRect.left ? x - listRect.left : Math.max(0, x - listRect.right);
          item.style.translate = `${sideways}px ${dy + scrolled}px`;
        } else {
          ghost.style.translate = `${dx}px ${dy}px`;
        }

        if (boxRect) {
          removing = contains(boxRect, x, y);
          item.toggleAttribute("removing", removing);
          box.toggleAttribute("over", removing);
        }

        // The dragged element holds a slot while it is over the sidebar.
        const inSidebar = isTab ? !removing : contains(sideRect, x, y);
        to = inSidebar ? slotIndex(slots, home + dy + scrolled) : from;
        this.#shiftTabs(i => (from < i && i <= to ? "up" : to <= i && i < from ? "down" : ""));
      },

      onEnd: commit => this.#endDrag(
        async () => {
          if (!commit) return;
          if (removing) {
            if (removeSection(library, item.dataset.section)) await this.#refresh();
          } else if (to !== from) {
            await this.#place(item.dataset.section, to);
          }
        },
        () => {
          ghost?.remove();
          item.removeAttribute("dragging");
        }
      ),
    });
  }

  /** Shifts each tab by what `directionOf(index)` returns: "up", "down" or nothing. */
  #shiftTabs(directionOf) {
    this.#tabs.forEach((tab, i) => {
      const direction = directionOf(i);
      if (direction) tab.setAttribute("shift", direction);
      else tab.removeAttribute("shift");
    });
  }

  /**
   * Ends a drag. Transitions are switched off while the change is applied, so tabs land in
   * their new places instead of sliding there from the old ones.
   * @param {() => Promise} apply - Applies the change
   * @param {() => void} [cleanup] - Runs once it is applied
   */
  async #endDrag(apply, cleanup) {
    const list = this.#list;
    this.#drag = null;

    list.setAttribute("no-transition", "true");
    try {
      await apply();
    } finally {
      cleanup?.();
      for (const tab of this.#tabs) {
        for (const name of ["dragging", "removing", "shift"]) tab.removeAttribute(name);
        tab.style.translate = "";
      }
      this.#dropbox?.removeAttribute("over");
      list.style.removeProperty(SHIFT_DISTANCE);
      await nextFrame();
      list.removeAttribute("no-transition");
      this.#busy = false;
    }
  }
}

// --- Entry points ---

const controllers = new WeakMap();

export function hookSections(library) {
  let controller = controllers.get(library);
  if (!controller) {
    controller = new SidebarController(library);
    controllers.set(library, controller);
  }
  controller.init();
}

export function resetSectionsEditMode() {
  for (const library of document.querySelectorAll("zen-library")) {
    const controller = controllers.get(library);
    if (controller?.isEditing) controller.setEditMode(false);
  }
}

export function initSectionsTweaks() {
  const observer = {
    observe(subject, topic, data) {
      if (data && data !== COMPACT_PREF) return;
      for (const library of document.querySelectorAll("zen-library")) applyCompact(library);
    },
  };
  Services.prefs.addObserver(COMPACT_PREF, observer);
  window.addEventListener("unload", () => Services.prefs.removeObserver(COMPACT_PREF, observer), { once: true });
}
