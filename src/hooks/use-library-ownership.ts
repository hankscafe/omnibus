import { useState, useEffect, useCallback } from "react";

export type StatusType =
  | 'LIBRARY_MONITORED'
  | 'LIBRARY_UNMONITORED'
  | 'ISSUE_OWNED'
  // #203 COLLECTED coverage: not on disk, but reprinted in a collected edition that is. Neither
  // "In Library" nor something a volume's "Request Missing" asks for; its own Request stays.
  | 'ISSUE_COVERED'
  | 'REQUESTED'
  | 'PENDING_APPROVAL'
  | 'UNRELEASED'
  | null;

/**
 * A request in flight: GET /api/library/ids lists everyone's (its `name` is the download's name), and a
 * request button adds one at once (its `name` the issue it asked for) until the next fetch.
 */
export interface ActiveRequestStub {
  volumeId: string;
  status: string;
  name: string | null;
}

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
  const [coveredIssues, setCoveredIssues] = useState<Set<string>>(new Set());
  const [activeRequests, setActiveRequests] = useState<ActiveRequestStub[]>([]);
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
          setCoveredIssues(new Set((data.covered || []).map(String)));
          setActiveRequests(data.requests || []);
        }
      })
      .catch(() => {});
  }, [refreshSignal]);

  // volumeId as a detail pane holds it: null when the provider gave an issue no volume (String(null) matches nothing).
  const getVolumeStatus = useCallback((volumeId: number | string | null): StatusType => {
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

  const getIssueStatus = useCallback((issueId: number | string, volumeId: number | string | null, issueName: string, isReleased?: boolean, issueNumber?: string, seriesName?: string): StatusType => {
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

    // `name` is the download's name (the route sends it under that key) or the issue asked for; there
    // was also a check on `activeDownloadName`, which no request here ever carries.
    const req = activeRequests.find(r =>
      (String(r.volumeId) === volStr && (r.name === issueName || r.name === coreName)) ||
      (r.name && (r.name.toLowerCase() === cleanName || r.name.toLowerCase() === coreName))
    );

    if (req) {
      if (['IMPORTED', 'COMPLETED'].includes(req.status)) return 'ISSUE_OWNED';
      if (req.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
      if (req.status === 'UNRELEASED' || isReleased === false) return 'UNRELEASED';
      return 'REQUESTED';
    }

    // A request in flight for it wins above (the deliberate ask); otherwise it is covered.
    if (coveredIssues.has(idStr)) return 'ISSUE_COVERED';
    if (isReleased === false) return 'UNRELEASED';
    return null;
  }, [ownedIssues, coveredIssues, requestedIssues, activeRequests]);

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
