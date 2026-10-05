/**
 * Boosts section tweaks for the Library.
 */

import { LIT_URL } from "./LibraryTweaksShared.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "lit", () =>
  ChromeUtils.importESModule(LIT_URL, { global: "current" })
);

ChromeUtils.defineESModuleGetters(lazy, {
  gZenBoostsManager:
    "resource:///modules/zen/boosts/ZenBoostsManager.sys.mjs",
});


/**
 * Groups boost rows under domain headers, the same way the history section
 * groups visits under date headers. Because `#boosts()` and `#renderBoost()`
 * are private methods on the native class we cannot call them from outside,
 * so we re-read from gZenBoostsManager directly and re-render rows with a
 * template that mirrors the native one.
 *
 * While a search query is active the list is short, so we leave it flat
 * (delegate to the original) just as history leaves search results flat.
 */
export function hookBoostsSection() {
  customElements
    .whenDefined("zen-library-boosts-section")
    .then(BoostsSection => {
      const { html, repeat } = lazy.lit;
      const proto = BoostsSection.prototype;
      const original = proto.renderItems;

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
        // Flat list while searching — let the native render handle it.
        if (this.searchQuery) {
          return original.call(this);
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
          return original.call(this);
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
    })
    .catch(ex =>
      console.error("Failed to hook boosts section", ex)
    );
}
