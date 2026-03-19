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
    person_credits?: ComicVineCredit[];
    character_credits?: ComicVineCredit[];
    site_detail_url: string;
}

// --- INTERNAL APP TYPES ---
export interface FormattedSearchResult {
    id: number;
    name: string;
    year: string | null;
    publisher: string;
    count: number;
    image: string | null;
    description: string;
}