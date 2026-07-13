// __tests__/components/settings-tabs.test.tsx
//
// Settings reorganization Phase 1: the 3,400-line settings monolith becomes 8 tab components
// (settings/tabs/*.tsx) fed by a shared state bag from page.tsx. These tests pin (a) that each
// tab renders its headline controls from a plain bag, (b) that the SECTIONS THAT MOVED landed
// in their new tabs (acronyms → Search, Cloudflare/retries → Downloads, manga detection lists →
// Discovery, custom headers → Access & Security, engine perf/env paths/Docker test → System),
// and (c) that controls still write through the bag's setConfig.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { MetadataTab } from '@/app/admin/settings/tabs/metadata-tab';
import { LibraryFilesTab } from '@/app/admin/settings/tabs/library-files-tab';
import { SearchIndexersTab } from '@/app/admin/settings/tabs/search-indexers-tab';
import { DownloadsTab } from '@/app/admin/settings/tabs/downloads-tab';
import { DiscoveryTab } from '@/app/admin/settings/tabs/discovery-tab';
import { NotificationsTab } from '@/app/admin/settings/tabs/notifications-tab';
import { AccessSecurityTab } from '@/app/admin/settings/tabs/access-security-tab';
import { SystemTab } from '@/app/admin/settings/tabs/system-tab';

// Radix polyfills (same as the other component suites)
global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

// A complete state bag: every key the tabs destructure, with inert defaults.
const mkBag = (overrides: Record<string, any> = {}) => ({
    config: {},
    setConfig: vi.fn(),
    isSourceAvailable: vi.fn().mockReturnValue(true),
    handleTest: vi.fn(),
    testing: null,
    testResults: {},
    setTestResults: vi.fn(),
    cacheStats: null,
    clearMetadataCache: vi.fn(),
    clearingCache: false,
    configuredLibraries: [],
    addLibrary: vi.fn(), removeLibrary: vi.fn(), updateLibrary: vi.fn(), setLibraryDefault: vi.fn(),
    handleRestoreNamingDefaults: vi.fn(),
    envPaths: {},
    updateProwlarrCategories: vi.fn(),
    customProwlarrCategories: "",
    refreshIndexers: vi.fn(), refreshing: false, hasRefreshed: false,
    availableIndexers: [], configuredIndexers: [],
    openIndexerModal: vi.fn(), deleteIndexer: vi.fn(),
    scoringRules: [], setScoringRules: vi.fn(),
    customAcronyms: [], setCustomAcronyms: vi.fn(),
    configuredClients: [],
    openClientSetup: vi.fn(), deleteClient: vi.fn(),
    setEditingClient: vi.fn(), setClientModalOpen: vi.fn(),
    searchSourcePriority: [], moveSearchSource: vi.fn(), toggleSearchSourceEnabled: vi.fn(),
    hosterPriority: [], moveHosterPriority: vi.fn(), toggleHosterEnabled: vi.fn(),
    configuredHosters: [],
    setAnnasKey: vi.fn(), openHosterSetup: vi.fn(), deleteHoster: vi.fn(),
    applyRecommendedFilters: vi.fn(), applyForeignFilters: vi.fn(),
    configuredWebhooks: [],
    openWebhookModal: vi.fn(), handleTestWebhook: vi.fn(), testingWebhookId: null,
    toggleWebhookActive: vi.fn(), deleteWebhook: vi.fn(), toggleProviderEvent: vi.fn(),
    users: [], apiKeys: [],
    newKeyName: "", setNewKeyName: vi.fn(),
    newKeyUserId: "", setNewKeyUserId: vi.fn(),
    newKeyExpiration: "0", setNewKeyExpiration: vi.fn(),
    handleGenerateKey: vi.fn(), isGeneratingKey: false,
    generatedKey: null, setGeneratedKey: vi.fn(),
    generateError: null, setGenerateError: vi.fn(),
    handleRevokeKey: vi.fn(), copyToClipboard: vi.fn(),
    customHeaders: [], addHeader: vi.fn(), updateHeader: vi.fn(), removeHeader: vi.fn(),
    toast: vi.fn(),
    ...overrides,
});

describe('Settings tabs (Phase 1 reorganization)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('MetadataTab renders provider credentials and writes through setConfig', () => {
        const bag = mkBag();
        render(<MetadataTab s={bag} />);

        expect(screen.getByText(/ComicVine API Key/i)).toBeInTheDocument();
        expect(screen.getByText(/Match Confidence Mode/i)).toBeInTheDocument();
        expect(screen.getByText(/Export series\.json/i)).toBeInTheDocument();

        // The embedded-metadata switch is one of the few controls with a wired htmlFor.
        fireEvent.click(screen.getByLabelText(/Prefer Embedded File Metadata/i));
        expect(bag.setConfig).toHaveBeenCalledWith(expect.objectContaining({ file_metadata_priority: 'true' }));
    });

    it('MetadataTab no longer hosts the manga detection lists (moved to Discovery)', () => {
        render(<MetadataTab s={mkBag()} />);
        expect(screen.queryByText(/Auto-Tagging Logic/i)).not.toBeInTheDocument();
    });

    it('LibraryFilesTab renders libraries, naming, and archive conversion', () => {
        render(<LibraryFilesTab s={mkBag()} />);
        expect(screen.getByText(/Download Scan Root/i)).toBeInTheDocument();
        expect(screen.getByText(/Media Naming Conventions/i)).toBeInTheDocument();
        expect(screen.getByText(/Auto-Convert CBR\/RAR to CBZ/i)).toBeInTheDocument();
        // Engine performance moved to System
        expect(screen.queryByText(/Engine Performance/i)).not.toBeInTheDocument();
    });

    it('SearchIndexersTab renders Prowlarr config, scoring, and the relocated acronym expansion', () => {
        render(<SearchIndexersTab s={mkBag()} />);
        expect(screen.getByText(/Prowlarr URL/i)).toBeInTheDocument();
        expect(screen.getByText(/Release Scoring/i)).toBeInTheDocument();
        expect(screen.getByText(/Search Acronym Expansion/i)).toBeInTheDocument();
    });

    it('DownloadsTab merges clients, hosters, and the relocated network/lifecycle sections', () => {
        render(<DownloadsTab s={mkBag()} />);
        expect(screen.getByText(/Add Download Client/i)).toBeInTheDocument();
        expect(screen.getByText(/Enable Direct Downloads/i)).toBeInTheDocument();
        expect(screen.getAllByText(/Hoster Priority/i).length).toBeGreaterThan(0);
        expect(screen.getByText(/Cloudflare Bypass \(FlareSolverr \/ Byparr\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Automated Download Retry Delay/i)).toBeInTheDocument();
        expect(screen.getByText(/Flag stalled requests/i)).toBeInTheDocument();
    });

    it('DiscoveryTab unifies the manga story: visibility, request gate, and detection lists', () => {
        render(<DiscoveryTab s={mkBag()} />);
        expect(screen.getByText(/Manga Visibility/i)).toBeInTheDocument();
        expect(screen.getByText(/Allow Manga Requests/i)).toBeInTheDocument();
        expect(screen.getByText(/Auto-Tagging Logic/i)).toBeInTheDocument();
        expect(screen.getByText(/Enable Content Filtering/i)).toBeInTheDocument();
        // Acronyms moved to Search & Indexers
        expect(screen.queryByText(/Search Acronym Expansion/i)).not.toBeInTheDocument();
    });

    it('NotificationsTab renders the provider cards', () => {
        render(<NotificationsTab s={mkBag()} />);
        expect(screen.getByText('Discord')).toBeInTheDocument();
        expect(screen.getByText('Pushover')).toBeInTheDocument();
        expect(screen.getByText('Telegram')).toBeInTheDocument();
        expect(screen.getByText(/SMTP Email Alerts/i)).toBeInTheDocument();
    });

    it('AccessSecurityTab merges SSO, API keys, and the relocated custom headers', () => {
        render(<AccessSecurityTab s={mkBag()} />);
        expect(screen.getByText(/Single Sign-On/i)).toBeInTheDocument();
        expect(screen.getByText(/External API Integrations/i)).toBeInTheDocument();
        expect(screen.getByText(/Custom Request Headers/i)).toBeInTheDocument();
    });

    it('SystemTab hosts engine performance, environment paths, and the Docker test area', () => {
        render(<SystemTab s={mkBag()} />);
        expect(screen.getByText(/Engine Performance \(Concurrency\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Environment Paths \(System Defaults\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Docker Path Mappings \(Test Area\)/i)).toBeInTheDocument();
    });
});
