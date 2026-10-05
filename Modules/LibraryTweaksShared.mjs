/**
 * Constants and strings the Library Tweaks modules have in common.
 */

// The sections load the native Library's own modules into the window global,
// the way the native sections do, so that the classes are shared with Zen.
export const LIT_URL = "chrome://global/content/vendor/lit.all.mjs";
export const PLACES_CONTEXT_ID = "placesContext";
export const BOOKMARKS_SECTION_ID = "bookmarks";

/**
 * English text for the ids used by these sections. They have no Fluent
 * resource, so the text is applied directly instead.
 * Ids the native Library already translates, like its filter button, are
 * left to Fluent.
 */
export const STRINGS = {
  "library-bookmarks-section-title": "Bookmarks",
  "library-bookmarks-search-placeholder": "Search bookmarks",
  "library-bookmarks-empty": "No bookmarks to show",
  "library-bookmarks-filter-title": "Filter bookmarks",
  "library-bookmarks-filter-workspace": "Workspace",
  "library-bookmarks-filter-tags": "Tags",
  "library-history-closed-tabs": "Recently closed tabs",
  "library-history-clear": "Clear recent history\u2026",
  "library-history-closed-tabs-empty": "No recently closed tabs",
  "library-history-back": "Back to history",
};

/**
 * @param {string} url
 * @returns {string} The url without its scheme, "www." and trailing slash
 */
export function formatUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}
