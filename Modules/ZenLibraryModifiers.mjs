import { LIT_URL, STRINGS } from "./ZenLibraryTweaksShared.mjs";

const PREF_BOOSTS_STYLING_DISABLED = "librarytweaks-boosts-styling-disabled";
const ORDER_PREF = "librarytweaks-sections-order";
const COMPACT_PREF = "librarytweaks-sections-compact";
const REMOVED_PREF = "librarytweaks-sections-removed";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const EDIT_PANE_ID = "zen-library-edit-pane";
const STORAGE_TITLE = "Storage";
const EMPTY_TITLE = "Nothing removed";
const EMPTY_BODY = "Drag a section here to take it off the sidebar. Drag it back out, or click it, to bring it back.";
const REMOVE_TOOLTIP = "Remove section";
const RESTORE_TOOLTIP = "Restore section";

const BRUSH_ICON = "chrome://browser/skin/zen-icons/selectable/brush.svg";
const CHECK_ICON = "chrome://browser/skin/zen-icons/selectable/checkbox.svg";
const INBOX_ICON = "chrome://browser/skin/zen-icons/selectable/inbox.svg";
// How far from the sidebar (px) a chip being dragged back starts to be pulled into its column.
const CHIP_PULL_RANGE = 160;
const SHIFT_DISTANCE_PROPERTY = "--zen-library-tab-shift-distance";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "lit", () => ChromeUtils.importESModule(LIT_URL, { global: "current" }));
ChromeUtils.defineESModuleGetters(lazy, {
  gZenBoostsManager: "resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs",
});

function isBoostsStylingDisabled() {
  try {
    return Services.prefs.getBoolPref(PREF_BOOSTS_STYLING_DISABLED);
  } catch {
    try {
      return Services.prefs.getIntPref(PREF_BOOSTS_STYLING_DISABLED) !== 0;
    } catch {
      try {
        const val = Services.prefs.getStringPref(PREF_BOOSTS_STYLING_DISABLED);
        return val === "1" || val.toLowerCase() === "true";
      } catch {
        return false;
      }
    }
  }
}

function refreshBoostsSections() {
  for (const section of document.querySelectorAll("zen-library-boosts-section")) {
    section.requestUpdate();
  }
  for (const lib of document.querySelectorAll("zen-library")) {
    lib.requestUpdate();
    const roots = [lib, lib.shadowRoot].filter(Boolean);
    for (const root of roots) {
      for (const section of root.querySelectorAll("zen-library-boosts-section")) {
        section.requestUpdate();
      }
    }
  }
}

const boostsPrefObserver = {
  observe(subject, topic, data) {
    if (!data || data === PREF_BOOSTS_STYLING_DISABLED) refreshBoostsSections();
  },
};

try {
  Services.prefs.addObserver(PREF_BOOSTS_STYLING_DISABLED, boostsPrefObserver);
  window.addEventListener("unload", () => {
    try { Services.prefs.removeObserver(PREF_BOOSTS_STYLING_DISABLED, boostsPrefObserver); } catch (_) {}
  }, { once: true });
} catch (ex) {
  console.error("Failed to register boosts pref observer", ex);
}

const editStates = new WeakMap(); // section element -> { browser, editor }

function whenNavigated(browser) {
  if (browser.currentURI?.spec !== "about:blank") return Promise.resolve();
  return new Promise(resolve => {
    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange(webProgress) {
        if (webProgress.isTopLevel) {
          browser.removeProgressListener(listener);
          resolve();
        }
      },
    };
    browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
  });
}

// Mirrors native ZenLibraryBoostsSection.#edit
async function editBoost(section, boost, row) {
  let state = editStates.get(section);
  if (!state) editStates.set(section, (state = { browser: null, editor: null }));
  if (state.browser) return;

  const url = `https://${boost.domain}/`;
  const uri = Services.io.newURI(url);
  if (!lazy.gZenBoostsManager.canBoostSite(uri)) return;

  const rowRect = row.getBoundingClientRect();
  const glance = await gZenGlanceManager.openDetachedGlance({
    url,
    clientX: rowRect.left + rowRect.width / 2,
    clientY: rowRect.top + rowRect.height / 2,
    userContextId: gZenWorkspaces.getActiveWorkspace()?.containerTabId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  if (!glance) return;

  const { browser } = glance;
  state.browser = browser;
  glance.closed.then(() => {
    state.browser = null;
    state.editor?.close();
    state.editor = null;
  });

  await whenNavigated(browser);
  if (state.browser !== browser) return;

  const stored = lazy.gZenBoostsManager.loadBoostFromStore(boost.domain, boost.id);
  state.editor = lazy.gZenBoostsManager.openBoostWindow(window, stored, uri, { browser });
}

async function exportBoost(boost) {
  const { boostEntry } = lazy.gZenBoostsManager.loadBoostFromStore(boost.domain, boost.id);
  await lazy.gZenBoostsManager.exportBoost(window, boostEntry.boostData);
}

function deleteBoost(boost) {
  lazy.gZenBoostsManager.deleteBoost({ domain: boost.domain, id: boost.id });
}

// Mirrors native context menu (Edit / Export / Delete)
let boostMenu = null;
let boostMenuTarget = null;

function openBoostMenu(section, boost, row, event) {
  if (!boostMenu) {
    boostMenu = window.MozXULElement.parseXULToFragment(`
      <menupopup class="zen-library-boosts-menu">
        <menuitem data-action="edit" data-l10n-id="library-boosts-menu-edit"/>
        <menuitem data-action="export" data-l10n-id="zen-boost-save"/>
        <menuseparator/>
        <menuitem data-action="delete" data-l10n-id="zen-boost-edit-delete"/>
      </menupopup>
    `).firstElementChild;
    boostMenu.addEventListener("command", commandEvent => {
      const t = boostMenuTarget;
      if (!t) return;
      switch (commandEvent.target.dataset.action) {
        case "edit": editBoost(t.section, t.boost, t.row); break;
        case "export": exportBoost(t.boost); break;
        case "delete": deleteBoost(t.boost); break;
      }
    });
    boostMenu.addEventListener("popuphidden", hiddenEvent => {
      if (hiddenEvent.target !== boostMenu) return;
      boostMenuTarget?.row?.removeAttribute("menu-open");
      boostMenuTarget = null;
    });
    document.getElementById("mainPopupSet").appendChild(boostMenu);
  }
  boostMenuTarget?.row?.removeAttribute("menu-open");
  boostMenuTarget = { section, boost, row };
  row.setAttribute("menu-open", "true");
  boostMenu.openPopupAtScreen(event.screenX, event.screenY, true, event);
}

/**
 * Injects domain-based grouping into the native Zen Library Boosts section.
 */
export function hookBoostsSection() {
  customElements.whenDefined("zen-library-boosts-section").then(BoostsSection => {
    const proto = BoostsSection.prototype;
    if (proto._boostsTweaksHooked) return;
    proto._boostsTweaksHooked = true;

    const { html, repeat } = lazy.lit;
    const originalRenderItems = proto.renderItems;

    function renderBoostRow(section, boost) {
      return html`
        <div class="zen-library-row zen-library-boost-row" ?disabled=${!boost.enabled}
          @click=${event => {
            if (boost.enabled) editBoost(section, boost, event.currentTarget);
            else lazy.gZenBoostsManager.toggleBoostActiveForDomain(boost.domain, boost.id);
          }}
          @contextmenu=${event => {
            event.preventDefault();
            openBoostMenu(section, boost, event.currentTarget, event);
          }}>
          <div class="zen-library-boost-icon zen-squircle-before">
            <img src="page-icon:https://${boost.domain}/" decoding="async" alt="" />
          </div>
          <div class="zen-library-row-text">
            <span class="zen-library-row-title">${boost.name}</span>
            <span class="zen-library-row-subtitle">${boost.domain}</span>
          </div>
          <div class="zen-library-row-actions">
            <moz-toggle ?pressed=${boost.enabled} data-l10n-id="library-boosts-toggle"
              @click=${event => event.stopPropagation()}
              @toggle=${() => lazy.gZenBoostsManager.toggleBoostActiveForDomain(boost.domain, boost.id)}
            ></moz-toggle>
          </div>
        </div>
      `;
    }

    proto.renderItems = function () {
      if (isBoostsStylingDisabled() || this.searchQuery) return originalRenderItems.call(this);

      const byDomain = new Map();
      for (const [domain, entry] of lazy.gZenBoostsManager.registeredDomains) {
        for (const [id, boostEntry] of entry.boostEntries) {
          if (!boostEntry.boostData.changeWasMade) continue;
          if (!byDomain.has(domain)) byDomain.set(domain, []);
          
          byDomain.get(domain).push({
            id, domain,
            name: boostEntry.boostData.boostName,
            enabled: entry.activeBoostId === id,
          });
        }
      }

      if (!byDomain.size) return originalRenderItems.call(this);

      const domains = [...byDomain.keys()].sort((a, b) => a.localeCompare(b));
      for (const boosts of byDomain.values()) boosts.sort((a, b) => a.name.localeCompare(b.name));

      return repeat(
        domains,
        domain => domain,
        domain => html`
          <div class="zen-library-group">
            <h3>${domain}</h3>
            ${repeat(byDomain.get(domain), boost => `${boost.domain}/${boost.id}`, boost => renderBoostRow(this, boost))}
          </div>
        `
      );
    };

    refreshBoostsSections();
  }).catch(ex => console.error("Failed to hook boosts section", ex));
}


// --- Sections Modifiers ---

function isCompactEnabled() {
  try { return Services.prefs.getBoolPref(COMPACT_PREF); } catch {
    return Services.prefs.getIntPref(COMPACT_PREF, 0) !== 0;
  }
}

function applyCompact(library) {
  library.querySelector("#zen-library-sidebar-tabs")?.toggleAttribute("compact", isCompactEnabled());
}

const compactObserver = {
  observe(subject, topic, data) {
    if (data && data !== COMPACT_PREF) return;
    for (const library of document.querySelectorAll("zen-library")) applyCompact(library);
  },
};

// --- Adaptive density ---
//
// Zen hides the tab labels with a fixed `@media (max-height: 575px)` rule. That number
// is what five labelled tabs need (5 x 104px) plus 55px for the footer and paddings, so
// it is too low once this mod adds sections. The same kind of media rules is generated
// here from the number of tabs that are actually shown, so the sidebar adapts as the
// window gets shorter:
//   labels -> icons only -> icons only with spacing that shrinks smoothly -> scrolling list
// The spacing is not a fixed step: it follows the window height, so there is no sudden
// jump in density. The footer is never pushed out of view, and nothing is measured.

const NATIVE_LABEL_THRESHOLD = 575;
const NATIVE_SECTION_COUNT = 5;
const ICON_SIZE = 28;
// Native vertical spacing around one icon: margin 8+8, padding 16+16 and the 8px gap.
// It is split 1 : 2 : 1 (margin : padding : gap) when the spacing shrinks.
const MAX_SPACE = 56;
// Smallest spacing before the list scrolls instead. Raise it for roomier tabs.
const MIN_SPACE = 26;
// Height one tab takes, including its margin, padding and the gap below it.
const TAB_PITCH = {
  labels: 104, // native: 8+16 + 28 icon + 4 + 16 label + 16+8, plus the 8px gap
  icons: ICON_SIZE + MAX_SPACE, // native without the label (84)
  tight: ICON_SIZE + MIN_SPACE, // smallest the spacing gets (54)
};
const FIXED_HEIGHT = NATIVE_LABEL_THRESHOLD - NATIVE_SECTION_COUNT * TAB_PITCH.labels; // 55
const TIERS_STYLE_ID = "librarytweaks-tiers";
const TABS = "#zen-library-sidebar-tabs";

function buildTierCSS(count) {
  const labels = FIXED_HEIGHT + count * TAB_PITCH.labels;
  const icons = FIXED_HEIGHT + count * TAB_PITCH.icons;
  const tight = FIXED_HEIGHT + count * TAB_PITCH.tight;
  // !important because the native rules live in a stylesheet this one does not control.
  return `
@media (height > ${labels}px) {
  ${TABS}:not([compact]) .zen-library-tab label { display: block !important; }
}
@media (height <= ${labels}px) {
  ${TABS} .zen-library-tab label { display: none !important; }
}
@media (height <= ${icons}px) {
  ${TABS} {
    /* Spacing each tab can afford: it falls from ${MAX_SPACE}px to ${MIN_SPACE}px as the window shrinks. */
    --lt-space: clamp(${MIN_SPACE}px, calc((100vh - ${FIXED_HEIGHT}px) / ${count} - ${ICON_SIZE}px), ${MAX_SPACE}px);
    gap: calc(var(--lt-space) / 7) !important;
  }
  ${TABS} .zen-library-tab {
    margin-block: calc(var(--lt-space) / 7) !important;
    padding-block: calc(var(--lt-space) * 2 / 7) !important;
  }
}
@media (height <= ${tight}px) {
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

function applyTiers(library) {
  const list = library.querySelector(TABS);
  if (!list) return;
  const count = list.querySelectorAll(".zen-library-tab:not([hidden])").length;
  if (!count || count === appliedTabCount) return;
  appliedTabCount = count;

  let style = document.getElementById(TIERS_STYLE_ID);
  if (!style) {
    style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = TIERS_STYLE_ID;
    (document.head ?? document.documentElement).appendChild(style);
  }
  style.textContent = buildTierCSS(count);
  console.info(
    `[LibraryTweaks] ${count} tabs: labels above ${FIXED_HEIGHT + count * TAB_PITCH.labels}px, ` +
    `spacing shrinks below ${FIXED_HEIGHT + count * TAB_PITCH.icons}px, ` +
    `tightest above ${FIXED_HEIGHT + count * TAB_PITCH.tight}px, scrolling below that`
  );
}

const tierObservers = new WeakMap();

function watchTabs(library) {
  const list = library.querySelector(TABS);
  if (!list) return;
  applyTiers(library);
  if (tierObservers.has(list)) return;
  // Sections can be added, hidden or shown after the first render.
  const observer = new MutationObserver(() => applyTiers(library));
  observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  tierObservers.set(list, observer);
}

function createElement(tag, className) {
  const element = document.createElementNS(XHTML_NS, tag);
  if (className) element.className = className;
  return element;
}

// --- Sections: order and removed ---
//
// Each library keeps a catalog of every section it has, removed ones included, in the order
// the user arranged them. The library itself is only given the sections that are not
// removed, so Zen renders tabs and content for those and nothing else. That also keeps
// `toggle(id)` and the bookmarks sidebar hook working: both already ignore ids that are not
// in `zenLibrarySections`.

const catalogs = new WeakMap(); // library -> Map(id -> Section)

function getSavedOrder() {
  return Services.prefs.getStringPref(ORDER_PREF, "").split(",").filter(Boolean);
}

function getRemovedIds() {
  return Services.prefs.getStringPref(REMOVED_PREF, "").split(",").filter(Boolean);
}

function setRemovedIds(ids) {
  Services.prefs.setStringPref(REMOVED_PREF, [...new Set(ids)].join(","));
}

function getRemovedSet(catalog) {
  const removed = new Set(getRemovedIds().filter(id => catalog.has(id)));
  // A pref that would leave nothing to show is ignored.
  return removed.size < catalog.size ? removed : new Set();
}

function publishSections(library) {
  const catalog = catalogs.get(library);
  const removed = getRemovedSet(catalog);
  const visible = Object.fromEntries([...catalog].filter(([id]) => !removed.has(id)));
  library.zenLibrarySections = new Proxy(visible, {
    // A section removed while the library is open can still be mounted until it closes,
    // and Zen renders what is mounted by looking it up here. It is not listed, and
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

  const saved = getSavedOrder();
  const ids = [
    ...saved.filter(id => catalog.has(id)),
    ...[...catalog.keys()].filter(id => !saved.includes(id)),
  ];
  catalogs.set(library, new Map(ids.map(id => [id, catalog.get(id)])));
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
  setRemovedIds([...getRemovedIds(), id]);
  publishSections(library);
  return true;
}

function restoreSection(library, id) {
  if (!catalogs.get(library)?.has(id) || id in library.zenLibrarySections) return false;

  setRemovedIds(getRemovedIds().filter(other => other !== id));
  publishSections(library);
  return true;
}

/**
 * Stores a new order for the sections that are shown. Removed ones keep the slot they
 * had, so restoring one puts it back where it was.
 */
function reorderSections(library, visibleIds) {
  const catalog = catalogs.get(library);
  const queue = [...visibleIds];
  const ids = [...catalog.keys()].map(id => (visibleIds.includes(id) ? queue.shift() : id));

  catalogs.set(library, new Map(ids.map(id => [id, catalog.get(id)])));
  // Ids this window does not have (no Spaces in a private window) are kept as they were.
  const unknown = getSavedOrder().filter(id => !catalog.has(id));
  Services.prefs.setStringPref(ORDER_PREF, [...ids, ...unknown].join(","));
  publishSections(library);
}

function getRemovedSections(library) {
  const catalog = catalogs.get(library) ?? new Map();
  return [...catalog]
    .filter(([id]) => !(id in library.zenLibrarySections))
    .map(([id, Section]) => ({ id, Section }));
}

async function getSectionLabel(Section) {
  const l10nId = Section.tabLabel ?? Section.label;
  return STRINGS[Section.label] ?? (l10nId ? await document.l10n?.formatValue(l10nId) : null) ?? Section.id;
}

const listening = new WeakSet();

class SectionsListController {
  #library;
  #editButton = null;
  #editing = false;
  #committing = false;
  #drag = null;
  #chipDrag = null;
  #chipMoved = false;
  #pane = null;

  constructor(library) {
    this.#library = library;
  }

  get isEditing() { return this.#editing; }
  get #list() { return this.#library.querySelector("#zen-library-sidebar-tabs"); }
  get #tabs() { return [...(this.#list?.querySelectorAll(".zen-library-tab") ?? [])]; }
  get #dropbox() { return this.#pane?.querySelector(".lt-removed-box"); }

  init() {
    this.#ensureEditButton();
    this.#ensurePane();
    this.#listen();
    applyCompact(this.#library);
    watchTabs(this.#library);
  }

  toggleEditMode() { this.setEditMode(!this.#editing); }

  setEditMode(value) {
    // Leaving edit mode drops whatever drag is still going on.
    if (!value) this.#cancelDrags(false);

    this.#editing = value;
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

  /**
   * The edit mode pane: a section-like element that lives in the content area. Like the
   * native sections it is hidden with the `hidden` attribute, and it is only shown while
   * editing. It is not part of `zenLibrarySections`, so it has no tab and never touches
   * `activeTab`.
   */
  #ensurePane() {
    if (this.#pane?.isConnected) return this.#pane;
    const content = this.#library.querySelector("#zen-library-content");
    if (!content) return null;

    const pane = createElement("div", "zen-library-section");
    pane.id = EDIT_PANE_ID;
    pane.hidden = true;

    const box = createElement("div", "lt-removed-box");

    const title = createElement("div", "lt-removed-title");
    title.setAttribute("role", "heading");
    title.setAttribute("aria-level", "2");
    title.textContent = STORAGE_TITLE;

    // Empty state, laid out like the Media section's opt-in but without a card or button.
    const placeholder = createElement("div", "lt-removed-placeholder");
    const icon = createElement("img", "lt-removed-placeholder-icon");
    icon.setAttribute("src", INBOX_ICON);
    icon.setAttribute("alt", "");
    const heading = createElement("h3");
    heading.textContent = EMPTY_TITLE;
    const text = createElement("p");
    text.textContent = EMPTY_BODY;
    placeholder.append(icon, heading, text);

    const body = createElement("div", "lt-removed-body");
    body.append(placeholder, createElement("div", "lt-removed-grid"));
    box.append(title, body);

    pane.append(box);
    pane.addEventListener("click", event => {
      // A click that ends a drag is not a request to restore in place.
      if (this.#chipMoved) return;
      const chip = event.target.closest(".lt-removed-chip");
      if (chip) this.#change(() => restoreSection(this.#library, chip.dataset.section));
    });
    pane.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const chip = event.target.closest?.(".lt-removed-chip");
      if (!chip) return;
      event.preventDefault();
      this.#change(() => restoreSection(this.#library, chip.dataset.section));
    });
    pane.addEventListener("pointerdown", event => this.#onChipDown(event));
    pane.addEventListener("pointermove", event => this.#onChipMove(event));
    pane.addEventListener("pointerup", event => this.#onChipUp(event));
    pane.addEventListener("pointercancel", event => this.#onChipUp(event));
    content.append(pane);
    this.#pane = pane;
    return pane;
  }

  #renderRemoved() {
    const pane = this.#ensurePane();
    if (!pane) return;

    const removed = getRemovedSections(this.#library);
    pane.querySelector(".lt-removed-box").toggleAttribute("empty", !removed.length);
    pane.querySelector(".lt-removed-grid").replaceChildren(
      ...removed.map(({ id, Section }) => {
        const chip = createElement("div", "lt-removed-chip");
        chip.dataset.section = id; // picks up the section's sprite icon from the native CSS
        chip.setAttribute("role", "button");
        chip.setAttribute("tabindex", "0");
        chip.title = RESTORE_TOOLTIP;

        const icon = createElement("div", "lt-removed-chip-icon");
        icon.append(createElement("div", "zen-library-tab-icon-image"));
        const label = createElement("span", "lt-removed-chip-label");
        getSectionLabel(Section).then(text => {
          label.textContent = text;
          chip.setAttribute("aria-label", `${RESTORE_TOOLTIP}: ${text}`);
        });
        chip.append(icon, label, createElement("div", "lt-restore-button"));
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
        button = createElement("div", "lt-remove-button");
        button.setAttribute("role", "button");
        button.setAttribute("aria-label", REMOVE_TOOLTIP);
        button.title = REMOVE_TOOLTIP;
        tab.append(button);
      }
      // The last section left cannot be removed.
      button.toggleAttribute("disabled", tabs.length <= 1);
    }
  }

  #ensureEditButton() {
    const footer = this.#library.querySelector("#zen-library-footer");
    if (!footer) return;

    this.#editButton = footer.querySelector("#zen-library-footer-edit-sections");
    if (this.#editButton) return;

    const button = document.createXULElement("toolbarbutton");
    button.id = "zen-library-footer-edit-sections";
    button.className = "toolbarbutton-1";
    button.setAttribute("image", BRUSH_ICON);
    button.setAttribute("tooltiptext", "Customize Sections");
    button.addEventListener("command", () => this.toggleEditMode());

    const first = footer.querySelector(".toolbarbutton-1");
    if (first) first.after(button);
    else footer.appendChild(button);

    this.#editButton = button;
  }

  #listen() {
    const list = this.#list;
    if (!list || listening.has(list)) return;

    listening.add(list);
    list.addEventListener("click", this, true);
    for (const type of ["pointerdown", "pointermove", "pointerup"]) list.addEventListener(type, this);
    list.addEventListener("pointercancel", this);
  }

  handleEvent(event) {
    switch (event.type) {
      case "click":
        if (!this.#editing) break;
        event.preventDefault();
        event.stopPropagation();
        this.#onClick(event);
        break;
      case "pointerdown": this.#onPointerDown(event); break;
      case "pointermove": this.#onPointerMove(event); break;
      case "pointerup":
      case "pointercancel": this.#onPointerUp(event); break;
    }
  }

  #onClick(event) {
    const button = event.target.closest(".lt-remove-button");
    if (!button || button.hasAttribute("disabled")) return;

    const id = button.closest(".zen-library-tab").dataset.section;
    this.#change(() => removeSection(this.#library, id));
  }

  /**
   * Runs a change to which sections are shown, then brings the UI up to date.
   * @param {() => boolean} change - Returns whether anything changed
   */
  async #change(change) {
    if (this.#committing || this.#drag || this.#chipDrag) return;
    this.#committing = true;
    try {
      if (change()) await this.#refresh();
    } finally {
      this.#committing = false;
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

  // --- Cancelling a drag ---
  //
  // Escape drops the drag like a cancelled pointer would. It is listened for on the window,
  // in the capture phase, so it is seen before the Library's own handler, which would
  // otherwise close the whole Library.

  #escapeListener = event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#cancelDrags();
  };

  #watchEscape(on) {
    window[on ? "addEventListener" : "removeEventListener"]("keydown", this.#escapeListener, true);
  }

  #cancelDrags(animate = true) {
    if (this.#drag) this.#endTabDrag(false);
    if (this.#chipDrag) this.#endChipDrag(false, animate);
  }

  // --- Dragging a tab (into the box of removed sections, or to reorder) ---

  #onPointerDown(event) {
    if (!this.#editing || this.#committing || this.#drag || this.#chipDrag || event.button !== 0) return;
    if (event.target.closest(".lt-remove-button")) return;

    const tabs = this.#tabs;
    const tab = event.target.closest(".zen-library-tab");
    const index = tabs.indexOf(tab);
    if (index === -1) return;

    const list = this.#list;
    const bounds = tabs.map(other => window.windowUtils.getBoundsWithoutFlushing(other));
    if (bounds.length > 1) {
      list.style.setProperty(SHIFT_DISTANCE_PROPERTY, `${bounds[1].top - bounds[0].top}px`);
    }

    // Without a second section there is nothing that may be removed, so no drop target.
    const dropbox = this.#dropbox;

    this.#drag = {
      tab, pointerId: event.pointerId, index, dropIndex: index,
      startX: event.clientX, lastX: event.clientX,
      startY: event.clientY, lastY: event.clientY,
      centerY: bounds[index].top + bounds[index].height / 2,
      startScroll: list.scrollTop,
      slotCenters: bounds.filter((rect, i) => i !== index).map(rect => rect.top + rect.height / 2),
      listBounds: window.windowUtils.getBoundsWithoutFlushing(list),
      dropBounds: dropbox && tabs.length > 1 ? window.windowUtils.getBoundsWithoutFlushing(dropbox) : null,
      removing: false,
    };

    tab.setAttribute("dragging", "true");
    tab.setPointerCapture(event.pointerId);
    this.#watchEscape(true);
    event.preventDefault();
  }

  #onPointerMove(event) {
    const drag = this.#drag;
    if (drag?.pointerId !== event.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    this.#updateDrag();
  }

  #updateDrag() {
    const drag = this.#drag;
    const scrolled = this.#list.scrollTop - drag.startScroll;
    const travel = drag.lastY - drag.startY + scrolled;

    // Past the sides of the list the tab follows the pointer sideways too, so it can be
    // carried to the box of removed sections.
    const { left, width } = drag.listBounds;
    const sideways = drag.lastX < left ? drag.lastX - left : Math.max(0, drag.lastX - (left + width));
    drag.tab.style.translate = `${sideways}px ${travel}px`;

    const removing = this.#isOverDropbox(drag);
    if (removing !== drag.removing) {
      drag.removing = removing;
      drag.tab.toggleAttribute("removing", removing);
      this.#dropbox?.toggleAttribute("over", removing);
    }

    const centerY = drag.centerY + travel;
    const index = removing ? drag.index : drag.slotCenters.filter(center => centerY > center).length;

    if (index !== drag.dropIndex) {
      drag.dropIndex = index;
      this.#shiftTabs();
    }
  }

  #isOverDropbox({ dropBounds, lastX, lastY }) {
    return (
      !!dropBounds &&
      lastX >= dropBounds.left && lastX <= dropBounds.left + dropBounds.width &&
      lastY >= dropBounds.top && lastY <= dropBounds.top + dropBounds.height
    );
  }

  #shiftTabs() {
    const { index, dropIndex } = this.#drag;
    this.#tabs.forEach((tab, i) => {
      let shift = "";
      if (index < i && i <= dropIndex) shift = "up";
      else if (dropIndex <= i && i < index) shift = "down";

      if (shift) tab.setAttribute("shift", shift);
      else tab.removeAttribute("shift");
    });
  }

  async #onPointerUp(event) {
    if (this.#drag?.pointerId !== event.pointerId) return;
    await this.#endTabDrag(event.type === "pointerup");
  }

  /**
   * Ends the drag of a tab.
   * @param {boolean} commit - Whether to apply where it was dropped
   */
  async #endTabDrag(commit) {
    const drag = this.#drag;
    if (!drag) return;

    this.#drag = null;
    this.#committing = true;
    this.#watchEscape(false);
    if (drag.tab.hasPointerCapture(drag.pointerId)) drag.tab.releasePointerCapture(drag.pointerId);

    const list = this.#list;
    list.setAttribute("no-transition", "true");
    try {
      if (commit) {
        if (drag.removing) {
          if (removeSection(this.#library, drag.tab.dataset.section)) await this.#refresh();
        } else if (drag.dropIndex !== drag.index) {
          await this.#commitReorder(drag.index, drag.dropIndex);
        }
      }
    } finally {
      for (const tab of this.#tabs) {
        tab.removeAttribute("dragging");
        tab.removeAttribute("removing");
        tab.removeAttribute("shift");
        tab.style.translate = "";
      }
      this.#dropbox?.removeAttribute("over");
      list.style.removeProperty(SHIFT_DISTANCE_PROPERTY);
      await new Promise(resolve => requestAnimationFrame(resolve));
      list.removeAttribute("no-transition");
      this.#committing = false;
    }
  }

  async #commitReorder(dragIndex, dropIndex) {
    const ids = this.#tabs.map(tab => tab.dataset.section);
    ids.splice(dropIndex, 0, ...ids.splice(dragIndex, 1));

    reorderSections(this.#library, ids);
    await this.#refresh();
  }

  // --- Dragging a removed section back into the sidebar ---
  //
  // The box that holds the chips clips whatever leaves it, so the chip being dragged is
  // represented by a ghost that lives in the library itself. A plain click (no movement
  // past the threshold) still restores the section in its old slot.

  #onChipDown(event) {
    if (!this.#editing || this.#committing || this.#drag || this.#chipDrag || event.button !== 0) return;
    const chip = event.target.closest(".lt-removed-chip");
    if (!chip) return;

    this.#chipMoved = false;
    this.#chipDrag = {
      chip, pointerId: event.pointerId, active: false,
      startX: event.clientX, lastX: event.clientX,
      startY: event.clientY, lastY: event.clientY,
    };
    chip.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #onChipMove(event) {
    const drag = this.#chipDrag;
    if (drag?.pointerId !== event.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    if (!drag.active) {
      if (Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY) < 5) return;
      this.#startChipDrag(drag);
    }
    this.#updateChipDrag(drag);
  }

  #startChipDrag(drag) {
    const { chip } = drag;
    const library = this.#library;
    const list = this.#list;
    const getBounds = el => window.windowUtils.getBoundsWithoutFlushing(el);

    drag.active = true;
    this.#chipMoved = true;
    this.#watchEscape(true);

    // How far a tab moves to open a slot: the distance between two neighbouring tabs.
    const tabBounds = this.#tabs.map(getBounds);
    const shift = tabBounds.length > 1
      ? tabBounds[1].top - tabBounds[0].top
      : (tabBounds[0]?.height ?? 0) + 24;
    list.style.setProperty(SHIFT_DISTANCE_PROPERTY, `${shift}px`);

    drag.tabBounds = tabBounds;
    drag.shift = shift;
    drag.centers = tabBounds.map(rect => rect.top + rect.height / 2);
    drag.startScroll = list.scrollTop;
    drag.sideBounds = getBounds(library.querySelector("#zen-library-side"));
    drag.libBounds = getBounds(library);
    // Where the tabs sit horizontally: the column the chip is pulled into.
    drag.slotLeft = tabBounds[0]?.left ?? drag.sideBounds.left;

    const chipBounds = getBounds(chip);
    drag.grabX = drag.startX - chipBounds.left;
    drag.grabY = drag.startY - chipBounds.top;
    drag.halfHeight = chipBounds.height / 2;

    const ghost = chip.cloneNode(true);
    ghost.classList.add("lt-chip-ghost");
    for (const name of ["title", "tabindex", "role", "aria-label"]) ghost.removeAttribute(name);
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${chipBounds.width}px`;
    ghost.style.height = `${chipBounds.height}px`;
    library.append(ghost);

    drag.ghost = ghost;
    drag.dropIndex = null;
    chip.setAttribute("dragging", "");
  }

  #updateChipDrag(drag) {
    const { ghost, libBounds, sideBounds } = drag;
    const sideRight = sideBounds.left + sideBounds.width;

    // Like a tab carried out to the box of removed sections, the chip stays in the column
    // of the tabs while the pointer is over the sidebar, and only follows the overshoot
    // past its edge. The pull fades in as the pointer nears the sidebar, so it never jumps.
    const overshoot = drag.lastX < sideBounds.left
      ? drag.lastX - sideBounds.left
      : Math.max(0, drag.lastX - sideRight);
    const pull = Math.max(0, 1 - Math.abs(overshoot) / CHIP_PULL_RANGE);
    const eased = pull * pull * (3 - 2 * pull);
    const free = drag.lastX - drag.grabX;
    const sticky = drag.slotLeft + overshoot;

    ghost.style.left = `${free + (sticky - free) * eased - libBounds.left}px`;
    ghost.style.top = `${drag.lastY - drag.grabY - libBounds.top}px`;

    const over =
      drag.lastX >= sideBounds.left && drag.lastX <= sideRight &&
      drag.lastY >= sideBounds.top && drag.lastY <= sideBounds.top + sideBounds.height;

    let index = null;
    if (over) {
      const scrolled = this.#list.scrollTop - drag.startScroll;
      const centerY = drag.lastY - drag.grabY + drag.halfHeight + scrolled;
      index = drag.centers.filter(center => centerY > center).length;
    }

    ghost.toggleAttribute("over", over);
    if (index !== drag.dropIndex) {
      drag.dropIndex = index;
      this.#tabs.forEach((tab, i) => {
        if (index !== null && i >= index) tab.setAttribute("shift", "down");
        else tab.removeAttribute("shift");
      });
    }
  }

  async #onChipUp(event) {
    if (this.#chipDrag?.pointerId !== event.pointerId) return;
    await this.#endChipDrag(event.type === "pointerup");
  }

  /**
   * Ends the drag of a removed section.
   * @param {boolean} commit - Whether to restore it where it was dropped
   * @param {boolean} [animate] - Whether the ghost glides to where it lands first
   */
  async #endChipDrag(commit, animate = true) {
    const drag = this.#chipDrag;
    if (!drag) return;

    this.#chipDrag = null;
    if (drag.chip.hasPointerCapture(drag.pointerId)) drag.chip.releasePointerCapture(drag.pointerId);
    // Never moved: the click event restores it.
    if (!drag.active) return;

    this.#committing = true;
    this.#watchEscape(false);
    const list = this.#list;
    const restoring = commit && drag.dropIndex !== null;
    try {
      if (animate) await this.#settleGhost(drag, restoring);
      list.setAttribute("no-transition", "true");
      if (restoring) await this.#commitRestore(drag.chip.dataset.section, drag.dropIndex);
    } finally {
      drag.ghost.remove();
      drag.chip.removeAttribute("dragging");
      for (const tab of this.#tabs) tab.removeAttribute("shift");
      list.style.removeProperty(SHIFT_DISTANCE_PROPERTY);
      await new Promise(resolve => requestAnimationFrame(resolve));
      list.removeAttribute("no-transition");
      this.#committing = false;
    }
  }

  /**
   * Glides the ghost to where it is about to land: the slot it opened in the sidebar, or
   * back to its chip when the drag is cancelled. Skipped for reduced motion.
   */
  async #settleGhost(drag, restoring) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const { ghost, libBounds } = drag;
    let left;
    let top;
    if (restoring) {
      const scrolled = this.#list.scrollTop - drag.startScroll;
      const slot = drag.tabBounds[drag.dropIndex];
      left = drag.slotLeft;
      top = (slot ? slot.top : drag.tabBounds.at(-1).top + drag.shift) - scrolled;
    } else {
      const rect = window.windowUtils.getBoundsWithoutFlushing(drag.chip);
      left = rect.left;
      top = rect.top;
    }

    try {
      const animation = ghost.animate(
        [
          { left: ghost.style.left, top: ghost.style.top, scale: "1.04" },
          { left: `${left - libBounds.left}px`, top: `${top - libBounds.top}px`, scale: "1" },
        ],
        { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }
      );
      await animation.finished;
    } catch {
      // Interrupted: the ghost is removed right after anyway.
    }
  }

  async #commitRestore(id, dropIndex) {
    const library = this.#library;
    const ids = this.#tabs.map(tab => tab.dataset.section);
    if (!restoreSection(library, id)) return;

    ids.splice(dropIndex, 0, id);
    reorderSections(library, ids);
    await this.#refresh();
  }
}

const controllers = new WeakMap();

export function hookSections(library) {
  let controller = controllers.get(library);
  if (!controller) {
    controller = new SectionsListController(library);
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
  Services.prefs.addObserver(COMPACT_PREF, compactObserver);
  window.addEventListener("unload", () => Services.prefs.removeObserver(COMPACT_PREF, compactObserver), { once: true });
}
