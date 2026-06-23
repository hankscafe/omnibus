import { useState, useEffect, useCallback } from "react";

export type StatusType =
  | 'LIBRARY_MONITORED'
  | 'LIBRARY_UNMONITORED'
  | 'ISSUE_OWNED'
  | 'REQUESTED'
  | 'PENDING_APPROVAL'
  | 'UNRELEASED'
  | null;

/**
 * Shared library-ownership + request-status logic for the Discover grid (comic-grid) and the
 * manual-search component (request-search). This used to be copy-pasted in both, which is how a
 * matching bug got fixed in one and not the other.
 *
 * Ownership is keyed ONLY on the provider volume/issue ID (cvId/metadataId), which is unique per
 * volume. Name-based matching is deliberately NOT used: it ignored the year, so a library
 * "X-Men (1963)" falsely matched every other volume named "X-Men" on Discover/search.
 *
 * Pass a `refreshSignal` that changes when the library/requests should be re-fetched (the manual
 * search has none, so it defaults to a stable value = fetch once on mount).
 */
export function useLibraryOwnership(refreshSignal: unknown = 0) {
  const [ownedSeries, setOwnedSeries] = useState<Set<string>>(new Set());
  const [monitoredSeries, setMonitoredSeries] = useState<Set<string>>(new Set());
  const [ownedIssues, setOwnedIssues] = useState<Set<string>>(new Set());
  const [activeRequests, setActiveRequests] = useState<any[]>([]);
  const [requestedVolumes, setRequestedVolumes] = useState<Set<string>>(new Set());
  const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/library/ids')
      .then(res => res.json())
      .then(data => {
        if (data) {
          setOwnedSeries(new Set((data.series || []).map(String)));
          setMonitoredSeries(new Set((data.monitored || []).map(String)));
          setOwnedIssues(new Set((data.issues || []).map(String)));
          setActiveRequests(data.requests || []);
        }
      })
      .catch(() => {});
  }, [refreshSignal]);

  const getVolumeStatus = useCallback((volumeId: number | string): StatusType => {
    const idStr = String(volumeId);

    // Ownership is determined ONLY by the provider volume ID — never by name (name matching ignored
    // the year and produced false "in library" positives).
    const isOwned = ownedSeries.has(idStr);
    const isMonitored = monitoredSeries.has(idStr);

    if (isOwned) return isMonitored ? 'LIBRARY_MONITORED' : 'LIBRARY_UNMONITORED';
    if (requestedVolumes.has(idStr)) return 'REQUESTED';

    // Match in-flight requests by volume ID only (no loose name-prefix matching).
    const activeReqs = activeRequests.filter(r => String(r.volumeId) === idStr);

    if (activeReqs.length > 0) {
      const allCompleted = activeReqs.every(r => ['IMPORTED', 'COMPLETED'].includes(r.status));
      if (allCompleted) return isMonitored ? 'LIBRARY_MONITORED' : 'LIBRARY_UNMONITORED';
      if (activeReqs.some(r => r.status === 'PENDING_APPROVAL')) return 'PENDING_APPROVAL';
      return 'REQUESTED';
    }
    return null;
  }, [ownedSeries, monitoredSeries, requestedVolumes, activeRequests]);

  const getIssueStatus = useCallback((issueId: number | string, volumeId: number | string, issueName: string, isReleased?: boolean, issueNumber?: string, seriesName?: string): StatusType => {
    const idStr = String(issueId);
    const volStr = String(volumeId);
    const cleanName = issueName.toLowerCase().trim();

    let coreName = cleanName;
    if (seriesName && issueNumber) {
      const parsedNum = parseFloat(issueNumber);
      const numToUse = isNaN(parsedNum) ? issueNumber : parsedNum;
      coreName = `${seriesName} #${numToUse}`.toLowerCase().trim();
    }

    const isOwned = ownedIssues.has(idStr);

    if (isOwned) return 'ISSUE_OWNED';
    if (requestedIssues.has(issueName) || requestedIssues.has(coreName)) return 'REQUESTED';

    const req = activeRequests.find(r =>
      (String(r.volumeId) === volStr && (r.name === issueName || r.name === coreName)) ||
      (r.name && (r.name.toLowerCase() === cleanName || r.name.toLowerCase() === coreName)) ||
      (r.activeDownloadName && (r.activeDownloadName.toLowerCase() === cleanName || r.activeDownloadName.toLowerCase() === coreName))
    );

    if (req) {
      if (['IMPORTED', 'COMPLETED'].includes(req.status)) return 'ISSUE_OWNED';
      if (req.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
      if (req.status === 'UNRELEASED' || isReleased === false) return 'UNRELEASED';
      return 'REQUESTED';
    }

    if (isReleased === false) return 'UNRELEASED';
    return null;
  }, [ownedIssues, requestedIssues, activeRequests]);

  return {
    getVolumeStatus,
    getIssueStatus,
    // Optimistic-update setters used by each component's request handler.
    setMonitoredSeries,
    setRequestedVolumes,
    setRequestedIssues,
    setActiveRequests,
  };
}
