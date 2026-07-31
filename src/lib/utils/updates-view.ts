// src/lib/utils/updates-view.ts
//
// Pure helpers for the /library/updates feed (Beta B of the follow model): day-grouping and
// same-day series clustering over the API's already-sorted (createdAt desc, id desc) items.
// Extracted from the page for direct unit tests; `now` is injectable so labels are testable.

export interface UpdateItemLike {
    id: string;
    seriesId: string;
    seriesName: string;
    createdAt: string | Date;
    isRead: boolean;
}

export interface SeriesCluster<T> { seriesId: string; seriesName: string; items: T[] }
export interface DayGroup<T> { dayKey: string; clusters: SeriesCluster<T>[] }

/** Local-timezone YYYY-MM-DD — feed days follow the reader's clock, not UTC. */
export function dayKeyOf(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function dayLabel(dayKey: string, now: Date = new Date()): string {
    if (dayKey === dayKeyOf(now)) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (dayKey === dayKeyOf(yesterday)) return 'Yesterday';
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Groups by local day, then clusters consecutive-in-feed same-series items within each day (the
 * Komikku pattern: a 12-chapter dump renders as one expandable row, not twelve). Input order is
 * preserved throughout — items arrive newest-first and stay that way inside clusters.
 */
export function groupUpdates<T extends UpdateItemLike>(items: T[]): DayGroup<T>[] {
    const groups: DayGroup<T>[] = [];
    const clusterIndex = new Map<string, SeriesCluster<T>>(); // `${dayKey}|${seriesId}` → cluster

    for (const item of items) {
        const dayKey = dayKeyOf(new Date(item.createdAt));
        let group = groups[groups.length - 1];
        if (!group || group.dayKey !== dayKey) {
            group = { dayKey, clusters: [] };
            groups.push(group);
        }
        const key = `${dayKey}|${item.seriesId}`;
        let cluster = clusterIndex.get(key);
        if (!cluster) {
            cluster = { seriesId: item.seriesId, seriesName: item.seriesName, items: [] };
            clusterIndex.set(key, cluster);
            group.clusters.push(cluster);
        }
        cluster.items.push(item);
    }
    return groups;
}

export function filterUnread<T extends UpdateItemLike>(items: T[], unreadOnly: boolean): T[] {
    return unreadOnly ? items.filter(i => !i.isRead) : items;
}
