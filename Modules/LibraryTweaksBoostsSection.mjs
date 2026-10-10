import { LIT_URL } from "./LibraryTweaksShared.mjs";

const PREF_BOOSTS_STYLING_DISABLED = "librarytweaks-boosts-styling-disabled";

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

