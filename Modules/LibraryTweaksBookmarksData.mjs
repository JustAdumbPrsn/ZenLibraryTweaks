const BOOKMARKS_SIDEBAR_URI = "chrome://browser/content/places/bookmarksSidebar.xhtml";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const BOOKMARK_EVENTS = [
  "bookmark-added", "bookmark-removed", "bookmark-moved",
  "bookmark-title-changed", "bookmark-url-changed",
  "bookmark-tags-changed", "bookmark-keyword-changed",
];
const META_EVENTS = new Set(["bookmark-tags-changed", "bookmark-keyword-changed"]);
const OBSERVER_DEBOUNCE_MS = 100;
const WORKSPACE_BOOKMARKS_TOPIC = "workspace-bookmarks-updated";

/**
 * Retrieves the readable format type from PlacesUtils constant.
 * @param {number} type 
 * @returns {"bookmark"|"folder"|"separator"}
 */
export function bookmarkKind(type) {
  const { bookmarks } = lazy.PlacesUtils;
  switch (type) {
    case bookmarks.TYPE_FOLDER: return "folder";
    case bookmarks.TYPE_SEPARATOR: return "separator";
    default: return "bookmark";
  }
}

/**
 * Checks if the target guid represents a core Places root.
 * @param {string} guid 
 * @returns {boolean}
 */
export function isRootFolder(guid) {
  const { bookmarks } = lazy.PlacesUtils;
  return [
    bookmarks.rootGuid, bookmarks.toolbarGuid,
    bookmarks.menuGuid, bookmarks.unfiledGuid, bookmarks.mobileGuid,
  ].includes(guid);
}

/**
 * Normalizes a complex Places bookmark into a clean library standard map.
 * @param {object} item 
 * @returns {object} Normalized bookmark object
 */
export function toBookmark(item) {
  return {
    guid: item.guid,
    parentGuid: item.parentGuid ?? "",
    index: item.index,
    type: bookmarkKind(item.type),
    title: lazy.PlacesUtils.bookmarks.getLocalizedTitle(item) || "",
    url: item.url?.href ?? "",
    dateAdded: item.dateAdded,
    lastModified: item.lastModified,
    childCount: item.childCount ?? 0,
  };
}

export const WorkspaceBookmarks = {
  getWorkspaces() {
    if (!window.gZenWorkspaces || !window.ZenWorkspaceBookmarksStorage) return [];
    return window.gZenWorkspaces.getWorkspaces().map(({ uuid, name }) => ({ uuid, name }));
  },
  async getAssignments() {
    const assignments = new Map();
    try {
      const byWorkspace = await window.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace();
      for (const [uuid, guids] of Object.entries(byWorkspace)) {
        for (const guid of guids) {
          if (!assignments.has(guid)) assignments.set(guid, new Set());
          assignments.get(guid).add(uuid);
        }
      }
    } catch (ex) {
      console.error("Failed to read bookmark workspaces", ex);
    }
    return assignments;
  },
  isShownIn(assigned, uuid) {
    return !assigned?.size || assigned.has(uuid);
  },
};

export const BookmarkMeta = {
  async load() {
    const meta = new Map();
    const entry = url => {
      let found = meta.get(url);
      if (!found) meta.set(url, (found = { tags: [], keyword: null }));
      return found;
    };
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const tagRows = await db.executeCached(
        `SELECT t.title AS tag, h.url AS url
           FROM moz_bookmarks b
           JOIN moz_bookmarks t ON t.id = b.parent
           JOIN moz_bookmarks r ON r.id = t.parent
           JOIN moz_places h ON h.id = b.fk
          WHERE r.guid = :tagsGuid`,
        { tagsGuid: lazy.PlacesUtils.bookmarks.tagsGuid }
      );
      for (const row of tagRows) {
        entry(row.getResultByName("url")).tags.push(row.getResultByName("tag"));
      }
      
      const keywordRows = await db.executeCached(
        `SELECT k.keyword AS keyword, h.url AS url
           FROM moz_keywords k
           JOIN moz_places h ON h.id = k.place_id`
      );
      for (const row of keywordRows) {
        entry(row.getResultByName("url")).keyword = row.getResultByName("keyword");
      }
    } catch (ex) {
      console.error("Failed to read tags and keywords", ex);
    }
    return meta;
  },
};

export const folderStore = {
  id: guid => lazy.PlacesUIUtils.obfuscateUrlForXulStore(`place:parent=${guid}`),
  isOpen(guid) {
    return Services.xulStore.getValue(BOOKMARKS_SIDEBAR_URI, this.id(guid), "open") === "true";
  },
  setOpen(guid, open) {
    if (open) {
      Services.xulStore.setValue(BOOKMARKS_SIDEBAR_URI, this.id(guid), "open", "true");
    } else {
      Services.xulStore.removeValue(BOOKMARKS_SIDEBAR_URI, this.id(guid), "open");
    }
  },
};

/**
 * Handles bookmark DB reads, filtering, and observer updates.
 */
export class BookmarksQuery {
  #callback = null;
  #folderGuids = new Set();
  #debounce = null;
  #assignments = null;
  #meta = null;
  #metaChanged = false;

  observeBookmarks(callback) {
    if (!this.#callback) {
      lazy.PlacesUtils.observers.addListener(BOOKMARK_EVENTS, this.#onEvents);
      Services.obs.addObserver(this.#onWorkspaceBookmarks, WORKSPACE_BOOKMARKS_TOPIC);
    }
    this.#callback = callback;
  }

  close() {
    if (this.#callback) {
      lazy.PlacesUtils.observers.removeListener(BOOKMARK_EVENTS, this.#onEvents);
      Services.obs.removeObserver(this.#onWorkspaceBookmarks, WORKSPACE_BOOKMARKS_TOPIC);
    }
    this.#callback = null;
    clearTimeout(this.#debounce);
    this.#debounce = null;
    this.#folderGuids = new Set();
    this.#assignments = null;
    this.#meta = null;
    this.#metaChanged = false;
  }

  getMeta() {
    return (this.#meta ??= BookmarkMeta.load());
  }

  #onWorkspaceBookmarks = () => {
    this.#assignments = null;
    this.#callback?.({ folderGuids: new Set(), workspaceBookmarks: true });
  };

  #onEvents = events => {
    for (const event of events) {
      if (META_EVENTS.has(event.type)) {
        this.#meta = null;
        this.#metaChanged = true;
        continue;
      }
      if (event.isTagging) continue;
      
      for (const guid of [event.parentGuid, event.oldParentGuid]) {
        if (guid) this.#folderGuids.add(guid);
      }
    }
    if ((!this.#folderGuids.size && !this.#metaChanged) || this.#debounce) return;
    
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      const folderGuids = this.#folderGuids;
      const metaChanged = this.#metaChanged;
      this.#folderGuids = new Set();
      this.#metaChanged = false;
      this.#callback?.({ folderGuids, workspaceBookmarks: false, metaChanged });
    }, OBSERVER_DEBOUNCE_MS);
  };

  async #inFilters(items, filters) {
    if (!filters) return items;
    
    const { workspace, tags } = filters;
    if (workspace) this.#assignments ??= WorkspaceBookmarks.getAssignments();
    
    const [assignments, meta] = await Promise.all([
      workspace ? this.#assignments : null,
      tags.length ? this.getMeta() : null,
    ]);
    
    return items.filter(item => {
      if (item.type !== "bookmark") return true;
      if (assignments && !WorkspaceBookmarks.isShownIn(assignments.get(item.guid), workspace)) return false;
      if (meta) {
        const own = meta.get(item.url)?.tags;
        return !!own && tags.every(tag => own.includes(tag));
      }
      return true;
    });
  }

  async getRoots() {
    const { bookmarks } = lazy.PlacesUtils;
    const roots = await Promise.all(
      bookmarks.userContentRoots.map(guid => bookmarks.fetch(guid, null, { concurrent: true }))
    );
    return roots
      .filter(root => root && (root.guid !== bookmarks.mobileGuid || root.childCount))
      .map(toBookmark);
  }

  async getChildren(folderGuid, { filters = null } = {}) {
    const children = [];
    await lazy.PlacesUtils.bookmarks.fetch(
      { parentGuid: folderGuid },
      child => children.push(toBookmark(child)),
      { concurrent: true }
    );
    return this.#inFilters(children, filters);
  }

  async getFlat({ filters }) {
    const flatten = async folderGuid => {
      const children = await this.getChildren(folderGuid, { filters });
      const parts = await Promise.all(
        children.map(child => {
          if (child.type === "folder") return flatten(child.guid);
          return child.type === "bookmark" ? [child] : [];
        })
      );
      return parts.flat();
    };
    const roots = await this.getRoots();
    const parts = await Promise.all(roots.map(root => flatten(root.guid)));
    return parts.flat();
  }

  async getRecent(limit = 100) {
    const items = await lazy.PlacesUtils.bookmarks.getRecent(limit);
    return items.map(toBookmark);
  }

  async search(query, { limit = 100, filters = null } = {}) {
    if (!query) return [];
    const { bookmarks } = lazy.PlacesUtils;
    const text = query.toLowerCase();
    const keyword = text.split(/\s+/)[0];
    const meta = await this.getMeta();
    
    const keywordUrls = [];
    const tagUrls = [];
    for (const [url, { tags, keyword: own }] of meta) {
      if (own === keyword) {
        keywordUrls.push(url);
      } else if (tags.some(tag => tag.toLowerCase().includes(text))) {
        tagUrls.push(url);
      }
    }
    
    const withUrls = urls => Promise.all(urls.map(url => bookmarks.search({ url }).catch(() => [])));
    const [found, byKeyword, byTag] = await Promise.all([
      bookmarks.search(query),
      withUrls(keywordUrls),
      withUrls(tagUrls),
    ]);
    
    const rest = [...found, ...byTag.flat()].sort((a, b) => b.lastModified - a.lastModified);
    const seen = new Set();
    const sorted = [];
    
    for (const item of [...byKeyword.flat(), ...rest]) {
      if (item.type === bookmarks.TYPE_BOOKMARK && !seen.has(item.guid)) {
        seen.add(item.guid);
        sorted.push(toBookmark(item));
      }
    }
    
    const matches = [];
    for (let i = 0; i < sorted.length && matches.length < limit; i += limit) {
      matches.push(...(await this.#inFilters(sorted.slice(i, i + limit), filters)));
    }
    return matches.slice(0, limit);
  }
}