/**
 * Boosts section tweaks for the Library.
 */

import { LIT_URL } from "./LibraryTweaksShared.mjs";

const PREF_BOOSTS_STYLING_DISABLED = "librarytweaks-boosts-styling-disabled";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "lit", () =>
  ChromeUtils.importESModule(LIT_URL, { global: "current" })
);

ChromeUtils.defineESModuleGetters(lazy, {
  gZenBoostsManager:
    "resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs",
});

/**
 * Checks whether the boosts styling tweak is disabled via preference.
 * Handles boolean (false = 0), integer (0), and string values.
 */
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

/**
 * Finds all instances of the boosts section (across light DOM and shadow roots)
 * and requests a re-render.
 */
function refreshBoostsSections() {
  // 1. Direct document query
  for (const section of document.querySelectorAll("zen-library-boosts-section")) {
    section.requestUpdate();
  }

  // 2. Query inside <zen-library> (including ShadowRoot)
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

// Module-level observer: stays alive for the window and notifies all instances immediately
const boostsPrefObserver = {
  observe(subject, topic, data) {
    if (!data || data === PREF_BOOSTS_STYLING_DISABLED) {
      refreshBoostsSections();
    }
  },
};

try {
  Services.prefs.addObserver(PREF_BOOSTS_STYLING_DISABLED, boostsPrefObserver);
  window.addEventListener(
    "unload",
    () => {
      try {
        Services.prefs.removeObserver(
          PREF_BOOSTS_STYLING_DISABLED,
          boostsPrefObserver
        );
      } catch (_) {}
    },
    { once: true }
  );
} catch (ex) {
  console.error("Failed to register boosts pref observer", ex);
}

/**
 * Groups boost rows under domain headers, the same way the history section
 * groups visits under date headers.
 */
export function hookBoostsSection() {
  customElements
    .whenDefined("zen-library-boosts-section")
    .then(BoostsSection => {
      const proto = BoostsSection.prototype;
      if (proto._boostsTweaksHooked) {
        return;
      }
      proto._boostsTweaksHooked = true;

      const { html, repeat } = lazy.lit;
      const originalRenderItems = proto.renderItems;

      function renderBoostRow(boost) {
        return html`
          <div
            class="zen-library-row zen-library-boost-row"
            ?disabled=${!boost.enabled}
            @click=${() => {
              if (!boost.enabled) {
                lazy.gZenBoostsManager.toggleBoostActiveForDomain(
                  boost.domain,
                  boost.id
                );
              }
            }}
          >
            <div class="zen-library-boost-icon zen-squircle-before">
              <img src="page-icon:https://${boost.domain}/" alt="" />
            </div>
            <div class="zen-library-row-text">
              <span class="zen-library-row-title">${boost.name}</span>
              <span class="zen-library-row-subtitle">${boost.domain}</span>
            </div>
            <div class="zen-library-row-actions">
              <moz-toggle
                ?pressed=${boost.enabled}
                data-l10n-id="library-boosts-toggle"
                @click=${event => event.stopPropagation()}
                @toggle=${() =>
                  lazy.gZenBoostsManager.toggleBoostActiveForDomain(
                    boost.domain,
                    boost.id
                  )}
              ></moz-toggle>
            </div>
          </div>
        `;
      }

      proto.renderItems = function () {
        // If tweaks are disabled via preference or when searching, delegate to native render
        if (isBoostsStylingDisabled() || this.searchQuery) {
          return originalRenderItems.call(this);
        }

        // Collect boosts grouped by domain, mirroring native #boosts().
        const byDomain = new Map();
        for (const [
          domain,
          entry,
        ] of lazy.gZenBoostsManager.registeredDomains) {
          for (const [id, boostEntry] of entry.boostEntries) {
            if (!boostEntry.boostData.changeWasMade) {
              continue;
            }
            if (!byDomain.has(domain)) {
              byDomain.set(domain, []);
            }
            byDomain.get(domain).push({
              id,
              domain,
              name: boostEntry.boostData.boostName,
              enabled: entry.activeBoostId === id,
            });
          }
        }

        if (!byDomain.size) {
          return originalRenderItems.call(this);
        }

        // Domains and their boosts sorted alphabetically.
        const domains = [...byDomain.keys()].sort((a, b) =>
          a.localeCompare(b)
        );
        for (const boosts of byDomain.values()) {
          boosts.sort((a, b) => a.name.localeCompare(b.name));
        }

        return repeat(
          domains,
          domain => domain,
          domain => html`
            <div class="zen-library-group">
              <h3>${domain}</h3>
              ${repeat(
                byDomain.get(domain),
                boost => `${boost.domain}/${boost.id}`,
                boost => renderBoostRow(boost)
              )}
            </div>
          `
        );
      };

      // Force a refresh right after hooking in case it rendered before the hook resolved
      refreshBoostsSections();
    })
    .catch(ex =>
      console.error("Failed to hook boosts section", ex)
    );
}