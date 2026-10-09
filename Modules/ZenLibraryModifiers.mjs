import { LIT_URL } from "./ZenLibraryTweaksShared.mjs";

const PREF_BOOSTS_STYLING_DISABLED = "librarytweaks-boosts-styling-disabled";
const ORDER_PREF = "librarytweaks-sections-order";
const COMPACT_PREF = "librarytweaks-sections-compact";

const BRUSH_ICON = "chrome://browser/skin/zen-icons/selectable/brush.svg";
const CHECK_ICON = "chrome://browser/skin/zen-icons/selectable/checkbox.svg";
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

    function renderBoostRow(boost) {
      return html`
        <div class="zen-library-row zen-library-boost-row" ?disabled=${!boost.enabled}
          @click=${() => {
            if (!boost.enabled) lazy.gZenBoostsManager.toggleBoostActiveForDomain(boost.domain, boost.id);
          }}>
          <div class="zen-library-boost-icon zen-squircle-before">
            <img src="page-icon:https://${boost.domain}/" alt="" />
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
            ${repeat(byDomain.get(domain), boost => `${boost.domain}/${boost.id}`, boost => renderBoostRow(boost))}
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

function getSavedOrder() {
  return Services.prefs.getStringPref(ORDER_PREF, "").split(",").filter(Boolean);
}

/**
 * Reorders UI tabs based on saved preferences.
 * @param {HTMLElement} library 
 */
export function applyOrder(library) {
  const saved = getSavedOrder();
  if (!saved.length) return;
  
  const sections = library.zenLibrarySections;
  const ids = [
    ...saved.filter(id => id in sections),
    ...Object.keys(sections).filter(id => !saved.includes(id)),
  ];
  library.zenLibrarySections = Object.fromEntries(ids.map(id => [id, sections[id]]));
}

const listening = new WeakSet();

class SectionsListController {
  #library;
  #editButton = null;
  #editing = false;
  #committing = false;
  #drag = null;

  constructor(library) {
    this.#library = library;
  }

  get isEditing() { return this.#editing; }
  get #list() { return this.#library.querySelector("#zen-library-sidebar-tabs"); }
  get #tabs() { return [...(this.#list?.querySelectorAll(".zen-library-tab") ?? [])]; }

  init() {
    this.#ensureEditButton();
    this.#listen();
    applyCompact(this.#library);
  }

  toggleEditMode() { this.setEditMode(!this.#editing); }

  setEditMode(value) {
    this.#editing = value;
    this.#list?.toggleAttribute("editing", value);
    this.#editButton?.toggleAttribute("checked", value);
    this.#editButton?.setAttribute("image", value ? CHECK_ICON : BRUSH_ICON);
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
      case "click": if (this.#editing) { event.preventDefault(); event.stopPropagation(); } break;
      case "pointerdown": this.#onPointerDown(event); break;
      case "pointermove": this.#onPointerMove(event); break;
      case "pointerup":
      case "pointercancel": this.#onPointerUp(event); break;
    }
  }

  #onPointerDown(event) {
    if (!this.#editing || this.#committing || this.#drag || event.button !== 0) return;
    
    const tabs = this.#tabs;
    const tab = event.target.closest(".zen-library-tab");
    const index = tabs.indexOf(tab);
    if (index === -1) return;

    const list = this.#list;
    const bounds = tabs.map(other => window.windowUtils.getBoundsWithoutFlushing(other));
    if (bounds.length > 1) {
      list.style.setProperty(SHIFT_DISTANCE_PROPERTY, `${bounds[1].top - bounds[0].top}px`);
    }
    
    this.#drag = {
      tab, pointerId: event.pointerId, index, dropIndex: index,
      startY: event.clientY, lastY: event.clientY,
      centerY: bounds[index].top + bounds[index].height / 2,
      startScroll: list.scrollTop,
      slotCenters: bounds.filter((rect, i) => i !== index).map(rect => rect.top + rect.height / 2),
    };
    
    tab.setAttribute("dragging", "true");
    tab.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #onPointerMove(event) {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#drag.lastY = event.clientY;
    this.#updateDrag();
  }

  #updateDrag() {
    const drag = this.#drag;
    const scrolled = this.#list.scrollTop - drag.startScroll;
    const travel = drag.lastY - drag.startY + scrolled;
    drag.tab.style.translate = `0 ${travel}px`;

    const centerY = drag.centerY + travel;
    const index = drag.dragIndex = drag.slotCenters.filter(center => centerY > center).length;
    
    if (index !== drag.dropIndex) {
      drag.dropIndex = index;
      this.#shiftTabs();
    }
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
    const drag = this.#drag;
    if (drag?.pointerId !== event.pointerId) return;
    
    this.#drag = null;
    this.#committing = true;
    if (drag.tab.hasPointerCapture(event.pointerId)) drag.tab.releasePointerCapture(event.pointerId);

    const list = this.#list;
    list.setAttribute("no-transition", "true");
    try {
      if (drag.dropIndex !== drag.index && event.type === "pointerup") {
        await this.#commitReorder(drag.index, drag.dropIndex);
      }
    } finally {
      for (const tab of this.#tabs) {
        tab.removeAttribute("dragging");
        tab.removeAttribute("shift");
        tab.style.translate = "";
      }
      list.style.removeProperty(SHIFT_DISTANCE_PROPERTY);
      await new Promise(resolve => requestAnimationFrame(resolve));
      list.removeAttribute("no-transition");
      this.#committing = false;
    }
  }

  async #commitReorder(dragIndex, dropIndex) {
    const library = this.#library;
    const sections = library.zenLibrarySections;
    const ids = this.#tabs.map(tab => tab.dataset.section);
    
    ids.splice(dropIndex, 0, ...ids.splice(dragIndex, 1));

    const animated = this.#list.querySelector(".zen-library-tab[animate]")?.dataset.section;

    library.zenLibrarySections = Object.fromEntries(
      [...ids, ...Object.keys(sections).filter(id => !ids.includes(id))]
        .filter(id => id in sections)
        .map(id => [id, sections[id]])
    );
    Services.prefs.setStringPref(ORDER_PREF, Object.keys(library.zenLibrarySections).join(","));

    library.requestUpdate();
    await library.updateComplete;

    for (const tab of this.#tabs) {
      tab.toggleAttribute("animate", tab.dataset.section === animated);
    }
    window.gLibraryTweaks?.applyTabLabels(library);
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