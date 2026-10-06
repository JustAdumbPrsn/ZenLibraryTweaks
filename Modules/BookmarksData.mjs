/**
 * The bookmarks of the Library as plain data: the shape a row works with,
 * which bookmarks belong to which workspace, their tags and keywords, and
 * which folders are open.
 */

// The bookmarks sidebar (Ctrl+B) keeps which folders are open under its own
// document. Reading and writing the same entries makes the Library and the
// sidebar show one arrangement, kept across restarts like the sidebar's.
const BOOKMARKS_SIDEBAR_URI =
  "chrome://browser/content/places/bookmarksSidebar.xhtml";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

/**
 * @typedef {object} Bookmark
 * @property {string} guid
 * @property {string} parentGuid - Empty for the Places root
 * @property {number} index - Position inside the parent folder
 * @property {"bookmark"|"folder"|"separator"} type
 * @property {string} title
 * @property {string} url - Empty for folders and separators
 * @property {Date} dateAdded
 * @property {Date} lastModified
 * @property {number} childCount - Direct children, for folders only
 */

/**
 * @param {number} type - A PlacesUtils.bookmarks.TYPE_* constant
 * @returns {"bookmark"|"folder"|"separator"} The readable name of the type
 */
export function bookmarkKind(type) {
  const { bookmarks } = lazy.PlacesUtils;
  switch (type) {
    case bookmarks.TYPE_FOLDER:
      return "folder";
    case bookmarks.TYPE_SEPARATOR:
      return "separator";
    default:
      return "bookmark";
  }
}

/**
 * The folders Places itself keeps: the toolbar, the menu, Other Bookmarks and
 * Mobile Bookmarks, under the Places root. They are the ones with their own
 * icons, and like in the native tree they cannot be moved, copied, cut or
 * deleted. Things can still be put into them.
 *
 * @param {string} guid
 * @returns {boolean} Whether the guid is one of those folders
 */
export function isRootFolder(guid) {
  const { bookmarks } = lazy.PlacesUtils;
  return [
    bookmarks.rootGuid,
    bookmarks.toolbarGuid,
    bookmarks.menuGuid,
    bookmarks.unfiledGuid,
    bookmarks.mobileGuid,
  ].includes(guid);
}

/**
 * Converts a Places bookmark item to the plain object the Library works
 * with, which carries the url as a string like a History visit does.
 *
 * @param {object} item - An item from PlacesUtils.bookmarks
 * @returns {Bookmark} The converted bookmark
 */
export function toBookmark(item) {
  return {
    guid: item.guid,
    parentGuid: item.parentGuid ?? "",
    index: item.index,
    type: bookmarkKind(item.type),
    // Root folders are stored under a plain name, not the localized one.
    title: lazy.PlacesUtils.bookmarks.getLocalizedTitle(item) || "",
    url: item.url?.href ?? "",
    dateAdded: item.dateAdded,
    lastModified: item.lastModified,
    childCount: item.childCount ?? 0,
  };
}

/**
 * Zen lets a bookmark be assigned to any number of workspaces. A bookmark is
 * hidden from a workspace only when it is assigned to other workspaces and
 * not to that one, so an unassigned bookmark shows everywhere. This is the
 * same rule as `gZenWorkspaces.isBookmarkInAnotherWorkspace`, which can only
 * answer for the active workspace.
 *
 * The assignments live in Zen's own storage, not in Places. If Zen's
 * workspace globals are not reachable, `getWorkspaces` is empty and the
 * Library simply offers no workspace filter.
 */
export const WorkspaceBookmarks = {
  /**
   * @returns {{uuid: string, name: string}[]} The workspaces to filter by
   */
  getWorkspaces() {
    if (!window.gZenWorkspaces || !window.ZenWorkspaceBookmarksStorage) {
      return [];
    }
    return window.gZenWorkspaces
      .getWorkspaces()
      .map(({ uuid, name }) => ({ uuid, name }));
  },

  /**
   * Reads every assignment at once, which is how Zen's own bookmark menus
   * read them.
   *
   * @returns {Promise<Map<string, Set<string>>>} The workspace uuids of
   *   each assigned bookmark, by bookmark guid
   */
  async getAssignments() {
    const assignments = new Map();
    try {
      const byWorkspace =
        await window.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace();
      for (const [uuid, guids] of Object.entries(byWorkspace)) {
        for (const guid of guids) {
          if (!assignments.has(guid)) {
            assignments.set(guid, new Set());
          }
          assignments.get(guid).add(uuid);
        }
      }
    } catch (ex) {
      console.error("Failed to read bookmark workspaces", ex);
    }
    return assignments;
  },

  /**
   * @param {Set<string>|undefined} assigned - Workspaces of a bookmark
   * @param {string} uuid - The workspace being viewed
   * @returns {boolean} Whether the bookmark belongs in that workspace
   */
  isShownIn(assigned, uuid) {
    return !assigned?.size || assigned.has(uuid);
  },
};

/**
 * Tags and keywords belong to a url, not to a bookmark: two bookmarks of the
 * same page share them, and a keyword opens exactly one url. They are read
 * the way Places stores them, in one pass each, into a map by url.
 */
export const BookmarkMeta = {
  /**
   * @returns {Promise<Map<string, {tags: string[], keyword: string|null}>>}
   */
  async load() {
    const meta = new Map();
    const entry = url => {
      let found = meta.get(url);
      if (!found) {
        meta.set(url, (found = { tags: [], keyword: null }));
      }
      return found;
    };
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      // A tag is a folder under a hidden root, holding one bookmark per url.
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
        entry(row.getResultByName("url")).tags.push(
          row.getResultByName("tag")
        );
      }
      const keywordRows = await db.executeCached(
        `SELECT k.keyword AS keyword, h.url AS url
           FROM moz_keywords k
           JOIN moz_places h ON h.id = k.place_id`
      );
      for (const row of keywordRows) {
        entry(row.getResultByName("url")).keyword =
          row.getResultByName("keyword");
      }
    } catch (ex) {
      console.error("Failed to read tags and keywords", ex);
    }
    return meta;
  },
};

/**
 * Which folders are open is remembered the way the native bookmarks tree
 * remembers it: in the XUL store, keyed by the obfuscated place: url of the
 * folder, under the document of the bookmarks sidebar so that the two share
 * their state.
 */
export const folderStore = {
  id: guid =>
    lazy.PlacesUIUtils.obfuscateUrlForXulStore(`place:parent=${guid}`),

  isOpen(guid) {
    return (
      Services.xulStore.getValue(
        BOOKMARKS_SIDEBAR_URI,
        this.id(guid),
        "open"
      ) === "true"
    );
  },

  setOpen(guid, open) {
    if (open) {
      Services.xulStore.setValue(
        BOOKMARKS_SIDEBAR_URI,
        this.id(guid),
        "open",
        "true"
      );
    } else {
      Services.xulStore.removeValue(
        BOOKMARKS_SIDEBAR_URI,
        this.id(guid),
        "open"
      );
    }
  },
};
