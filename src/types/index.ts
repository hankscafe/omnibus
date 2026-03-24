// src/types/index.ts

// --- COMICVINE API TYPES ---
export interface ComicVineImage {
    icon_url: string;
    medium_url: string;
    screen_url: string;
    screen_large_url: string;
    small_url: string;
    super_url: string;
    thumb_url: string;
    tiny_url: string;
    original_url: string;
    image_tags: string;
}

export interface ComicVinePublisher {
    api_detail_url: string;
    id: number;
    name: string;
}

export interface ComicVineCredit {
    api_detail_url: string;
    id: number;
    name: string;
    site_detail_url: string;
    role?: string;
}

export interface ComicVineVolume {
    id: number;
    name: string;
    start_year: string | null;
    end_year: string | null;
    publisher: ComicVinePublisher | null;
    count_of_issues: number;
    image: ComicVineImage | null;
    deck: string | null;
    description: string | null;
    site_detail_url: string;
    person_credits?: ComicVineCredit[] | null;
    character_credits?: ComicVineCredit[] | null;
}

export interface ComicVineIssue {
    id: number;
    name: string | null;
    issue_number: string;
    cover_date: string | null;
    store_date: string | null;
    volume: {
        id: number;
        name: string;
        publisher?: ComicVinePublisher | null;
    };
    image: ComicVineImage | null;
    deck: string | null;
    description: string | null;
    site_detail_url: string;
    person_credits?: ComicVineCredit[] | null;
    character_credits?: ComicVineCredit[] | null;
}

// --- PROWLARR / INDEXER TYPES ---
export interface ProwlarrSearchResult {
    guid: string;
    title: string;
    size: number;
    indexer: string;
    seeders: number;
    peers: number;
    infoUrl: string;
    downloadUrl: string;
    protocol: 'torrent' | 'usenet';
    publishDate?: string;
    infoHash?: string;
}

// --- DISCORD WEBHOOK TYPES ---
export interface DiscordWebhookConfig {
    id: string;
    name: string;
    url: string;
    events: string[];
    isActive: boolean;
    botUsername?: string | null;
    botAvatarUrl?: string | null;
}

// --- STANDARD API RESPONSES ---
export interface ApiResponse<T = any> {
    success?: boolean;
    message?: string;
    error?: string;
    data?: T;
}

// --- UI COMPONENT TYPES ---
export interface OptionType {
    label: string;
    value: string;
}

export interface FormattedSearchResult {
    id: string | number;
    name: string;
    year?: string | number;
    publisher?: string;
    image?: string;
    description?: string;
    issue_number?: string;
}

export interface Comic {
    id: string;
    name: string;
    isVolume?: boolean; // <-- This fixes the comic-grid.tsx error!
    [key: string]: any;
}