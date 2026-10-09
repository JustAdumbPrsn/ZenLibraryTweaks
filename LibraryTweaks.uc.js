// ==UserScript==
// @name            LibraryTweaks
// @description     Tweaks for the Zen Library
// @version         v1.4
// @author          JustAdumbPrsn
// @include         main
// ==/UserScript==

(() => {
  "use strict";

  if (window.gLibraryTweaks) {
    return;
  }

  const LIBRARY_ELEMENT = "zen-library";
  const LAST_TAB_PREF = "zen.library.last-tab";
  const BOOKMARKS_SIDEBAR_COMMAND = "viewBookmarksSidebar";
  const LIBRARY_ENABLED_PREF = "zen.library.enabled";
  const BOOKMARKS_SECTION_ID = "bookmarks";

  const MODULES_URL = null;
  const MODULES_BASE = new URL("Modules/", MODULES_URL ?? Components.stack.filename).href;

  /**
   * Loads an ES module into the window global.
   * @param {string} name 
   * @returns {object} Module exports
   */
  function loadModule(name) {
    return ChromeUtils.importESModule(MODULES_BASE + name, { global: "current" });
  }

  const SECTIONS = [
    {
      resolve: () => loadModule("ZenLibraryHistorySection.mjs").ZenLibraryHistoryTweaksSection,
    },
    {
      resolve: () => loadModule("ZenLibraryBookmarksSection.mjs").ZenLibraryBookmarksSection,
      placement: { after: "history" },
    },
    {
      resolve: () => loadModule("ZenLibrarySpaceRoutingSection.mjs").ZenLibrarySpaceRoutingSection,
      placement: { after: "spaces" },
      enabled: () => !window.gZenWorkspaces.privateWindowOrDisabled,
    },
  ];

  /**
   * Inserts a section into the sections map based on placement rules.
   * @param {object} sections 
   * @param {Function} Section 
   * @param {{before?: string, after?: string}} [placement] 
   * @returns {object} 
   */
  function withSection(sections, Section, { before, after } = {}) {
    if (!before && !after && Section.id in sections) {
      return { ...sections, [Section.id]: Section };
    }
    const entries = Object.entries(sections).filter(([id]) => id !== Section.id);
    let index = entries.length;
    const anchor = entries.findIndex(([id]) => id === (before ?? after));
    if (anchor !== -1) {
      index = before ? anchor : anchor + 1;
    }
    entries.splice(index, 0, [Section.id, Section]);
    return Object.fromEntries(entries);
  }

  class LibraryTweaks {
    #Library = null;
    #originalGetInstance = null;
    #originalToggleSidebar = null;

    get BookmarksQuery() {
      return loadModule("ZenLibraryBookmarksData.mjs").BookmarksQuery;
    }

    async init() {
      this.#Library = await customElements.whenDefined(LIBRARY_ELEMENT);
      this.#hookGetInstance();
      this.#hookSidebar();
      this.#hookLibraryClose();
      
      const modifiers = loadModule("ZenLibraryModifiers.mjs");
      modifiers.hookBoostsSection();
      modifiers.initSectionsTweaks();

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

    #hookGetInstance() {
      const tweaks = this;
      const original = this.#Library.getInstance;
      this.#originalGetInstance = original;

      this.#Library.getInstance = function (createIfMissing = true) {
        const creating = createIfMissing && !this.instance;
        const savedTab = creating ? Services.prefs.getStringPref(LAST_TAB_PREF, "") : "";
        const library = original.call(this, createIfMissing);
        
        if (creating && library) {
          tweaks.#extend(library, savedTab);
          tweaks.#hookLibraryClose();
        }
        return library;
      };
    }

    #hookLibraryClose() {
      if (this.#Library._ltCloseHooked) {
        return;
      }
      this.#Library._ltCloseHooked = true;
      const originalAnimate = this.#Library.animateProgress;
      
      this.#Library.animateProgress = function (target, ...args) {
        if (target === 0) {
          loadModule("ZenLibraryModifiers.mjs").resetSectionsEditMode();
        }
        return originalAnimate.call(this, target, ...args);
      };
    }

    #hookSidebar() {
      const controller = window.SidebarController;
      if (!controller) return;

      const tweaks = this;
      const original = controller.toggle;
      this.#originalToggleSidebar = original;

      controller.toggle = function (commandID, ...args) {
        if (
          commandID === BOOKMARKS_SIDEBAR_COMMAND &&
          this.currentID !== commandID &&
          Services.prefs.getBoolPref(LIBRARY_ENABLED_PREF, false) &&
          BOOKMARKS_SECTION_ID in tweaks.#Library.getInstance().zenLibrarySections
        ) {
          tweaks.#Library.toggle(BOOKMARKS_SECTION_ID);
          return Promise.resolve();
        }
        return original.call(this, commandID, ...args);
      };
    }

    #extend(library, savedTab = "") {
      try {
        const modifiers = loadModule("ZenLibraryModifiers.mjs");

        for (const { resolve, placement, enabled } of SECTIONS) {
          if (enabled && !enabled()) continue;
          library.zenLibrarySections = withSection(
            library.zenLibrarySections,
            resolve(),
            placement
          );
        }

        modifiers.applySections(library);

        if (savedTab && savedTab in library.zenLibrarySections) {
          library.activeTab = savedTab;
        }

        library.requestUpdate();
        library.updateComplete.then(() => {
          this.applyTabLabels(library);
          modifiers.hookSections(library);
        });
      } catch (ex) {
        console.error("Failed to extend the Library", ex);
      }
    }

    applyTabLabels(library) {
      const { STRINGS } = loadModule("ZenLibraryTweaksShared.mjs");
      for (const [id, Section] of Object.entries(library.zenLibrarySections)) {
        const tab = library.querySelector(`.zen-library-tab[data-section="${id}"]`);
        const label = tab?.querySelector("label");
        if (!label) continue;

        if (STRINGS[Section.label] !== undefined) {
          label.removeAttribute("data-l10n-id");
          label.textContent = STRINGS[Section.label];
        } else {
          const l10nId = Section.tabLabel ?? Section.label;
          if (l10nId) document.l10n?.setAttributes(label, l10nId);
        }
      }
    }
  }

  const tweaks = new LibraryTweaks();
  window.gLibraryTweaks = tweaks;
  tweaks.init().catch(ex => console.error("Failed to initialize", ex));
})();