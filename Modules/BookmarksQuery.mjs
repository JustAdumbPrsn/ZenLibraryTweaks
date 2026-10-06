/**
 * Reads bookmarks for the Library, one folder at a time, and reports changes.
 */

import {
  BookmarkMeta,
  WorkspaceBookmarks,
  toBookmark,
} from "./BookmarksData.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils:
    "resource://gre/modules/PlacesUtils.sys.mjs",
});

// Only the events that change what a row shows or where it sits, plus the
// two that change the tags and keywords the filter and search read.
// Timestamps and guid changes are left out until a view needs them.
const BOOKMARK_EVENTS = [
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-title-changed",
  "bookmark-url-changed",
  "bookmark-tags-changed",
  "bookmark-keyword-changed",
];
const META_EVENTS = new Set([
  "bookmark-tags-changed",
  "bookmark-keyword-changed",
]);
const OBSERVER_DEBOUNCE_MS = 100;
// Zen notifies this when bookmark to workspace assignments change.
const WORKSPACE_BOOKMARKS_TOPIC = "workspace-bookmarks-updated";

/**
 * Reads and watches bookmarks for the Library. This is the counterpart of
 * the PlacesQuery that the History section uses, which has no bookmarks
 * equivalent. Folders are read one at a time, because Places cannot hand
 * out the whole tree (`fetchTree` is not implemented).
 *
 * Nothing is registered until `observeBookmarks` is called, and `close`
 * releases it again, so an unused query costs nothing.
 */
export class BookmarksQuery {
  #callback = null;
  #folderGuids = new Set();
  #debounce = null;
  // Read on first use, and again after Zen reports a change.
  #assignments = null;
  // Tags and keywords by url, read on first use and after they change.
  #meta = null;
  #metaChanged = false;

  /**
   * Starts reporting bookmark changes. Changes that arrive close together
   * are reported once, so an import does not cause a refresh per bookmark.
   *
   * @param {function({folderGuids: Set<string>,
   *   workspaceBookmarks: boolean, metaChanged: boolean}): void} callback -
   *   Called with the guids of the folders whose contents changed, with
   *   `workspaceBookmarks` set when the workspace assignments changed, or
   *   with `metaChanged` set when tags or keywords changed
   */
  observeBookmarks(callback) {
    if (!this.#callback) {
      lazy.PlacesUtils.observers.addListener(
        BOOKMARK_EVENTS,
        this.#onEvents
      );
      Services.obs.addObserver(
        this.#onWorkspaceBookmarks,
        WORKSPACE_BOOKMARKS_TOPIC
      );
    }
    this.#callback = callback;
  }

  /**
   * Stops observing and drops anything still waiting to be reported.
   */
  close() {
    if (this.#callback) {
      lazy.PlacesUtils.observers.removeListener(
        BOOKMARK_EVENTS,
        this.#onEvents
      );
      Services.obs.removeObserver(
        this.#onWorkspaceBookmarks,
        WORKSPACE_BOOKMARKS_TOPIC
      );
    }
    this.#callback = null;
    clearTimeout(this.#debounce);
    this.#debounce = null;
    this.#folderGuids = new Set();
    this.#assignments = null;
    this.#meta = null;
    this.#metaChanged = false;
  }

  /**
   * @returns {Promise<Map<string, {tags: string[], keyword: string|null}>>}
   *   The tags and keyword of each bookmarked url
   */
  getMeta() {
    return (this.#meta ??= BookmarkMeta.load());
  }

  #onWorkspaceBookmarks = () => {
    this.#assignments = null;
    this.#callback?.({ folderGuids: new Set(), workspaceBookmarks: true });
  };

  /**
   * Places lists changes in batches. The first one starts a short timer and
   * the rest join it, so the callback never waits longer than the delay.
   *
   * @param {object[]} events - The Places bookmark events
   */
  #onEvents = events => {
    for (const event of events) {
      if (META_EVENTS.has(event.type)) {
        // Dropped right away, so a read before the report is not stale.
        this.#meta = null;
        this.#metaChanged = true;
        continue;
      }
      // Tags are bookmarks under a hidden root, not ones the user sees.
      if (event.isTagging) {
        continue;
      }
      for (const guid of [event.parentGuid, event.oldParentGuid]) {
        if (guid) {
          this.#folderGuids.add(guid);
        }
      }
    }
    if ((!this.#folderGuids.size && !this.#metaChanged) || this.#debounce) {
      return;
    }
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      const folderGuids = this.#folderGuids;
      const metaChanged = this.#metaChanged;
      this.#folderGuids = new Set();
      this.#metaChanged = false;
      this.#callback?.({
        folderGuids,
        workspaceBookmarks: false,
        metaChanged,
      });
    }, OBSERVER_DEBOUNCE_MS);
  };

  /**
   * Keeps the bookmarks that pass the filters: they belong in the workspace,
   * and carry every picked tag. Folders and separators have neither and
   * always stay.
   *
   * @param {Bookmark[]} items
   * @param {{workspace: string|null, tags: string[]}|null} filters - The
   *   workspace uuid and tags to require, or null to keep everything
   * @returns {Promise<Bookmark[]>}
   */
  async #inFilters(items, filters) {
    if (!filters) {
      return items;
    }
    const { workspace, tags } = filters;
    if (workspace) {
      this.#assignments ??= WorkspaceBookmarks.getAssignments();
    }
    const [assignments, meta] = await Promise.all([
      workspace ? this.#assignments : null,
      tags.length ? this.getMeta() : null,
    ]);
    return items.filter(item => {
      if (item.type !== "bookmark") {
        return true;
      }
      if (
        assignments &&
        !WorkspaceBookmarks.isShownIn(assignments.get(item.guid), workspace)
      ) {
        return false;
      }
      if (meta) {
        const own = meta.get(item.url)?.tags;
        return !!own && tags.every(tag => own.includes(tag));
      }
      return true;
    });
  }

  /**
   * Gets the top level folders, which hold all other bookmarks.
   *
   * @returns {Promise<Bookmark[]>} The roots, in the order Places lists them
   */
  async getRoots() {
    const { bookmarks } = lazy.PlacesUtils;
    const roots = await Promise.all(
      bookmarks.userContentRoots.map(guid =>
        bookmarks.fetch(guid, null, { concurrent: true })
      )
    );
    // Mobile Bookmarks stays hidden until something is synced into it.
    return roots
      .filter(
        root =>
          root && (root.guid !== bookmarks.mobileGuid || root.childCount)
      )
      .map(toBookmark);
  }

  /**
   * Gets what a folder contains, separators included.
   *
   * @param {string} folderGuid - The folder to read
   * @param {{filters?: object|null}} [options] - The filters the bookmarks
   *   must pass, as `#inFilters` takes them
   * @returns {Promise<Bookmark[]>} The children in folder order
   */
  async getChildren(folderGuid, { filters = null } = {}) {
    const children = [];
    // Without a callback, fetch resolves to the first child only.
    await lazy.PlacesUtils.bookmarks.fetch(
      { parentGuid: folderGuid },
      child => children.push(toBookmark(child)),
      { concurrent: true }
    );
    return this.#inFilters(children, filters);
  }

  /**
   * Gets every bookmark that passes the filters, with the folders
   * flattened away. They come in the order a fully opened tree would list
   * them.
   *
   * @param {{filters: object}} options - The filters the bookmarks must pass
   * @returns {Promise<Bookmark[]>}
   */
  async getFlat({ filters }) {
    const flatten = async folderGuid => {
      const children = await this.getChildren(folderGuid, { filters });
      const parts = await Promise.all(
        children.map(child => {
          if (child.type === "folder") {
            return flatten(child.guid);
          }
          return child.type === "bookmark" ? [child] : [];
        })
      );
      return parts.flat();
    };
    const roots = await this.getRoots();
    const parts = await Promise.all(roots.map(root => flatten(root.guid)));
    return parts.flat();
  }

  /**
   * Gets the most recently added bookmarks. Folders and separators are not
   * included.
   *
   * @param {number} [limit] - The most to return
   * @returns {Promise<Bookmark[]>} The bookmarks, newest first
   */
  async getRecent(limit = lazy.searchSection.PAGE_SIZE) {
    const items = await lazy.PlacesUtils.bookmarks.getRecent(limit);
    return items.map(toBookmark);
  }

  /**
   * Searches bookmark titles, urls and tags, like the Library bar does, and
   * keywords, like the address bar does: a bookmark whose keyword is the
   * first word typed comes first. Only bookmarks are returned, since folders
   * and separators have nothing to open.
   *
   * @param {string} query - The text to look for
   * @param {{limit?: number, filters?: object|null}} [options] - The most
   *   to return, and the filters the bookmarks must pass
   * @returns {Promise<Bookmark[]>} The matches, keyword first and then the
   *   most recently changed
   */
  async search(
    query,
    { limit = lazy.searchSection.PAGE_SIZE, filters = null } = {}
  ) {
    if (!query) {
      return [];
    }
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
    const withUrls = urls =>
      Promise.all(urls.map(url => bookmarks.search({ url }).catch(() => [])));
    const [found, byKeyword, byTag] = await Promise.all([
      bookmarks.search(query),
      withUrls(keywordUrls),
      withUrls(tagUrls),
    ]);
    // Places has no way to limit or order a search, so it is done here.
    const rest = [...found, ...byTag.flat()].sort(
      (a, b) => b.lastModified - a.lastModified
    );
    const seen = new Set();
    const sorted = [];
    for (const item of [...byKeyword.flat(), ...rest]) {
      if (item.type === bookmarks.TYPE_BOOKMARK && !seen.has(item.guid)) {
        seen.add(item.guid);
        sorted.push(toBookmark(item));
      }
    }
    // Filtering can drop matches, so keep reading until the page is full.
    const matches = [];
    for (let i = 0; i < sorted.length && matches.length < limit; i += limit) {
      matches.push(
        ...(await this.#inFilters(sorted.slice(i, i + limit), filters))
      );
    }
    return matches.slice(0, limit);
  }
}
