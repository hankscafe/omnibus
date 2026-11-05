// src/lib/reading-list-nav.ts
//
// #270 (niddelicious): reading a Reading List. The list page opens the reader with the list and the
// entry, so the reader's next issue is the list's next entry (from whatever series) instead of the
// series' next issue; and it leaves a note in this tab, so the page it goes Back to can reopen your
// place in the list. Browser-only helpers - nothing here touches the server.

/** sessionStorage: the list whose entry was just opened in the reader (taken once, on the way back). */
export const READING_LIST_RETURN_KEY = 'omnibus-reading-list-return';
/** localStorage: Grouped or Flat, remembered in this browser like "Hide read". */
export const READING_LIST_VIEW_KEY = 'omnibus-reading-lists-view';

type NavIssue = { filePath: string | null };
type NavItem = { id: string; issue: NavIssue | null };

/** The reader for one file; `list` adds the list and the entry it was opened from. */
export function readerHref(filePath: string, seriesPath: string | null | undefined, list?: { listId: string; itemId: string }): string {
    let href = `/reader?path=${encodeURIComponent(filePath)}&series=${encodeURIComponent(seriesPath ?? '')}`;
    if (list) href += `&list=${encodeURIComponent(list.listId)}&item=${encodeURIComponent(list.itemId)}`;
    return href;
}

/**
 * Where the reader goes after `current` in a list (items in reading order): the next entry you have
 * a file for, from any series. `skipped` counts the entries passed over on the way (not in the library
 * yet, or never linked). The current entry is the one the link named - so an issue that is in the list
 * twice continues from the right place - else the file's first entry (an older link, or the list was
 * edited since). `found: false` = the file isn't in the list at all.
 */
export function nextInList<T extends NavItem>(items: T[], current: { itemId: string | null; filePath: string }): { found: boolean; next: T | null; skipped: number } {
    let at = current.itemId ? items.findIndex(i => i.id === current.itemId) : -1;
    if (at < 0 || items[at].issue?.filePath !== current.filePath) at = items.findIndex(i => i.issue?.filePath === current.filePath);
    if (at < 0) return { found: false, next: null, skipped: 0 };

    let skipped = 0;
    for (const item of items.slice(at + 1)) {
        if (item.issue?.filePath) return { found: true, next: item, skipped };
        skipped++;
    }
    return { found: true, next: null, skipped };
}

/** Called as an entry opens in the reader. */
export function markReturnToList(listId: string): void {
    try { window.sessionStorage.setItem(READING_LIST_RETURN_KEY, listId); } catch { /* storage blocked: no way back, nothing breaks */ }
}

/** True once - and only for the list the note was left for - when the page is reached on the way back. */
export function takeReturnToList(listId: string): boolean {
    try {
        if (window.sessionStorage.getItem(READING_LIST_RETURN_KEY) !== listId) return false;
        window.sessionStorage.removeItem(READING_LIST_RETURN_KEY);
        return true;
    } catch {
        return false;
    }
}
