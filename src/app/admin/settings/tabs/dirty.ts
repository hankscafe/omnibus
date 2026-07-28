// src/app/admin/settings/tabs/dirty.ts
//
// Per-tab dirty tracking for the settings page (Phase 2 save-model polish). The page keeps one
// global unsaved-changes hash; this maps each config key / collection to the tab that owns it so
// the tab bar can show an amber dot exactly where the unsaved edits live. Keys the settings page
// does NOT own (e.g. the Jobs page's *_schedule keys, which ride along in the config bag) are
// deliberately unmapped and never light a dot.

export const SETTINGS_TABS = [
    { value: 'metadata', label: 'Metadata' },
    { value: 'library', label: 'Library & Files' },
    { value: 'search', label: 'Search & Indexers' },
    { value: 'downloads', label: 'Downloads' },
    { value: 'discovery', label: 'Discovery & Filtering' },
    { value: 'notifications', label: 'Notifications' },
    { value: 'access', label: 'Access & Security' },
    { value: 'system', label: 'System' },
] as const;

const TAB_CONFIG_KEYS: Record<string, string[]> = {
    metadata: [
        'primary_metadata_source', 'cv_api_key', 'metron_user', 'metron_pass', 'series_ended_months',
        'matcher_mode', 'matcher_auto_threshold', 'file_metadata_priority', 'metron_detail_credits',
        'metadata_cache_enabled', 'metadata_cache_detail_days', 'metadata_cache_list_hours', 'metadata_cache_max_mb',
        'export_series_json', 'metadata_write_comicinfo', 'cover_source',
    ],
    library: [
        'download_path', 'folder_naming_pattern', 'file_naming_pattern', 'manga_file_naming_pattern',
        'cbr_conversion_enabled', 'convert_to_webp', 'webp_quality',
    ],
    search: [
        'prowlarr_url', 'prowlarr_key', 'prowlarr_categories',
        'filter_match_ratio', 'filter_junk_words', 'filter_exclude_groups',
    ],
    downloads: [
        'ddl_enabled', 'allow_bulk_packs', 'prioritize_packs', 'prowlarr_accept_yearless',
        'getcomics_interactive_pages', 'getcomics_automated_pages',
        'annas_archive_interactive_enabled', 'annas_archive_base_url', 'annas_archive_formats',
        'gc_avoid_large_downloads', 'solver_type', 'flaresolverr_url', 'flaresolverr_timeout',
        'download_retry_delay', 'awaiting_retry_days', 'flag_stalled_requests',
        'usenet_delete_after_import',
    ],
    discovery: [
        'show_popular_issues', 'show_new_releases',
        'discover_manga_filter_mode', 'discover_manga_allowed_publishers', 'manga_requests_enabled',
        'manga_publishers', 'western_publishers',
        'filter_enabled', 'filter_publishers', 'filter_keywords', 'filter_foreign_publishers',
    ],
    notifications: [
        'discord_enabled',
        'pushover_enabled', 'pushover_token', 'pushover_user', 'pushover_events',
        'telegram_enabled', 'telegram_bot_token', 'telegram_chat_id', 'telegram_events',
        'apprise_enabled', 'apprise_url', 'apprise_events',
        'smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from',
    ],
    access: [
        'oidc_enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_client_secret',
        'oidc_force_sso', 'oidc_auto_approve', 'oidc_admin_group', 'oidc_user_group',
    ],
    system: [
        'engine_max_scan_workers', 'engine_max_convert_workers', 'engine_cpu_cap',
        'engine_max_blocking_threads', 'engine_memory_ceiling_mb', 'engine_max_db_connections',
        'remote_path_mapping', 'local_path_mapping',
    ],
};

const TAB_COLLECTIONS: Record<string, string[]> = {
    library: ['configuredLibraries'],
    search: ['configuredIndexers', 'scoringRules', 'customAcronyms'],
    downloads: ['configuredClients', 'configuredHosters', 'hosterPriority', 'searchSourcePriority'],
    notifications: ['configuredWebhooks'],
    access: ['customHeaders'],
};

// Snapshot shape = the object the page already serializes for its unsaved-changes hash.
export interface SettingsSnapshot {
    config: Record<string, any>;
    [collection: string]: any;
}

const differs = (a: any, b: any) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

export function computeDirtyTabs(current: SettingsSnapshot, initial: SettingsSnapshot): string[] {
    const dirty: string[] = [];
    for (const tab of SETTINGS_TABS) {
        const keys = TAB_CONFIG_KEYS[tab.value] || [];
        const collections = TAB_COLLECTIONS[tab.value] || [];
        const keyChanged = keys.some(k => differs(current.config?.[k], initial.config?.[k]));
        const collectionChanged = collections.some(c => differs(current[c], initial[c]));
        if (keyChanged || collectionChanged) dirty.push(tab.value);
    }
    return dirty;
}
