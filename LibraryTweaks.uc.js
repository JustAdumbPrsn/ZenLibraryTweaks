// ==UserScript==
// @name            LibraryTweaks
// @description     Tweaks for the Zen Library
// @version         v1.1
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
  // What Ctrl+B and the Bookmarks menu ask the sidebar controller to toggle.
  const BOOKMARKS_SIDEBAR_COMMAND = "viewBookmarksSidebar";
  const LIBRARY_ENABLED_PREF = "zen.library.enabled";
  const BOOKMARKS_SECTION_ID = "bookmarks";

  // Where the modules are. They sit in a LibraryTweaks folder next to this
  // script, wherever the script loader found it, unless this says otherwise.
  const MODULES_URL = null;
  const MODULES_BASE = new URL(
    "Modules/",
    MODULES_URL ?? Components.stack.filename
  ).href;

  /**
   * Loads a module into the window global, like the native sections are, so
   * that the classes they share with Zen are the ones Zen uses. A module is
   * only loaded once per window.
   *
   * @param {string} name - The file name of the module
   * @returns {object} The exports of the module
   */
  function loadModule(name) {
    return ChromeUtils.importESModule(MODULES_BASE + name, {
      global: "current",
    });
  }

  // Registration

  /**
   * The sections added to the Library. `placement` positions the
   * sidebar tab relative to another section id, and defaults to the end. A
   * section with the id of a native one replaces it where it stands.
   */
  const SECTIONS = [
    {
      resolve: () =>
        loadModule("ZenLibraryHistoryTweaksSection.mjs")
          .ZenLibraryHistoryTweaksSection,
    },
    {
      resolve: () =>
        loadModule("ZenLibraryBookmarksSection.mjs").ZenLibraryBookmarksSection,
      placement: { after: "history" },
    },
  ];

  /**
   * Returns a copy of a sections map with one section inserted. The Library
   * renders its sidebar tabs in the insertion order of this object.
   *
   * @param {object} sections - The current id to section map
   * @param {Function} Section - The section class to add
   * @param {{before?: string, after?: string}} [placement]
   * @returns {object} The new map
   */
  function withSection(sections, Section, { before, after } = {}) {
    if (!before && !after && Section.id in sections) {
      return { ...sections, [Section.id]: Section };
    }
    const entries = Object.entries(sections).filter(
      ([id]) => id !== Section.id
    );
    let index = entries.length;
    const anchor = entries.findIndex(([id]) => id === (before ?? after));
    if (anchor !== -1) {
      index = before ? anchor : anchor + 1;
    }
    entries.splice(index, 0, [Section.id, Section]);
    return Object.fromEntries(entries);
  }

  class LibraryTweaks {
    static version = "v1.1";

    /**
     * The bookmarks data layer, for the Library sections and the console.
     */
    get BookmarksQuery() {
      return loadModule("BookmarksQuery.mjs").BookmarksQuery;
    }

    #Library = null;
    #originalGetInstance = null;
    #originalToggleSidebar = null;

    async init() {
      this.#Library = await customElements.whenDefined(LIBRARY_ELEMENT);
      this.#hookGetInstance();
      this.#hookSidebar();
      loadModule("ZenLibraryBoostsTweaks.mjs").hookBoostsSection();

      // The Library already exists if this script loaded after it was opened.
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

    /**
     * Wraps the native factory so a Library is extended as soon as it is
     * created. At that point it is mounted but not yet rendered, so the first
     * render already includes our sections.
     */
    #hookGetInstance() {
      const tweaks = this;
      const original = this.#Library.getInstance;
      this.#originalGetInstance = original;

      this.#Library.getInstance = function (createIfMissing = true) {
        const creating = createIfMissing && !this.instance;
        // The constructor resets the pref to "history" when it does not know
        // the saved section yet, so it has to be read beforehand.
        const savedTab = creating
          ? Services.prefs.getStringPref(LAST_TAB_PREF, "")
          : "";
        const library = original.call(this, createIfMissing);
        if (creating && library) {
          tweaks.#extend(library, savedTab);
        }
        return library;
      };
    }

    /**
     * Makes Ctrl+B open the Library on Bookmarks, like Ctrl+H does for
     * History, instead of the bookmarks sidebar. The sidebar still opens when
     * the Library is turned off, and an open one is still closed as before.
     */
    #hookSidebar() {
      const controller = window.SidebarController;
      if (!controller) {
        return;
      }
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

    /**
     * Adds every registered section to a Library. Errors are caught so that
     * a problem here can never break the native Library.
     *
     * @param {HTMLElement} library - The zen-library instance
     * @param {string} [savedTab] - The section the Library was last left on
     */
    #extend(library, savedTab = "") {
      try {
        for (const { resolve, placement } of SECTIONS) {
          library.zenLibrarySections = withSection(
            library.zenLibrarySections,
            resolve(),
            placement
          );
        }

        if (savedTab && savedTab in library.zenLibrarySections) {
          library.activeTab = savedTab;
        }

        library.requestUpdate();
        library.updateComplete.then(() => this.#applyTabLabels(library));
      } catch (ex) {
        console.error("Failed to extend the Library", ex);
      }
    }

    /**
     * Sets the sidebar tab text of our sections. Lit reuses tab elements by
     * position and Fluent keeps the old text when an id has no message, so a
     * tab could otherwise show the name of another section.
     *
     * @param {HTMLElement} library - The zen-library instance
     */
    #applyTabLabels(library) {
      const { STRINGS } = loadModule("LibraryTweaksShared.mjs");
      for (const { resolve } of SECTIONS) {
        const Section = resolve();
        const label = library.querySelector(
          `.zen-library-tab[data-section="${Section.id}"] label`
        );
        // Replaced native sections keep the label Fluent gives them.
        if (label && STRINGS[Section.label] !== undefined) {
          label.textContent = STRINGS[Section.label];
        }
      }
    }
  }

  const tweaks = new LibraryTweaks();
  window.gLibraryTweaks = tweaks;
  tweaks.init().catch(ex => console.error("Failed to initialize", ex));
})();