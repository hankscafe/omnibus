// src/lib/utils.ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { ComicVineCredit } from "@/types" 

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// --- Shared Release Date Checker ---
export function isReleasedYet(storeDate: string | null, coverDate: string | null) {
  const now = new Date();
  if (storeDate) return new Date(storeDate) <= now;
  if (coverDate) {
    // Comic cover dates are usually printed 1-2 months ahead of physical release.
    const buffer = new Date();
    buffer.setDate(buffer.getDate() + 45); 
    return new Date(coverDate) <= buffer;
  }
  return true; // If CV has no date, assume it's out
}

// ComicVine "concepts" mix real genres and useful non-genre concepts (Time Travel, Martial Arts)
// with cover/variant tags ("Variant Cover: Action Figure", "Variant Theme: Civil War", "Homage
// Covers", "Marvel 25th Anniversary Frame Covers") that have no business in <Genre>. Those
// families are dropped; every other concept is kept. EXACT twin: omnibus-engine/src/metadata.rs
// is_genre_noise.
export function isGenreNoise(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.startsWith('variant ') || n.endsWith(' cover') || n.endsWith(' covers');
}

// A stored genres JSON array with the noise entries removed; null when nothing else is left. A
// value that isn't a JSON string array, or holds no noise, comes back unchanged.
// EXACT twin: omnibus-engine/src/metadata.rs strip_genre_noise_json.
export function stripGenreNoise(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  let list: unknown;
  try { list = JSON.parse(stored); } catch { return stored; }
  if (!Array.isArray(list) || !list.every((g) => typeof g === 'string')) return stored;
  if (!list.some((g) => isGenreNoise(g))) return stored;
  const kept = list.filter((g) => !isGenreNoise(g));
  return kept.length > 0 ? JSON.stringify(kept) : null;
}

// --- Shared ComicVine Metadata Parser ---
export function parseComicVineCredits(
  person_credits?: ComicVineCredit[], 
  character_credits?: ComicVineCredit[],
  concept_credits?: ComicVineCredit[],
  story_arc_credits?: ComicVineCredit[],
  team_credits?: ComicVineCredit[],
  location_credits?: ComicVineCredit[]
) {
  const writers: string[] = [];
  const artists: string[] = [];
  const coverArtists: string[] = [];
  const colorists: string[] = [];
  const letterers: string[] = [];
  const inkers: string[] = [];
  const editors: string[] = [];
  const translators: string[] = [];
  const characters: string[] = [];
  const genres: string[] = [];
  const storyArcs: string[] = [];
  const teams: string[] = [];
  const locations: string[] = [];

  if (person_credits) {
    person_credits.forEach(p => {
      const role = (p.role || '').toLowerCase();
      if (role.includes('writer') || role.includes('script') || role.includes('plot') || role.includes('story')) writers.push(p.name);
      // #199 Call-3 Beta A: inkers moved from the Penciller bucket to their own — ComicInfo separates
      // <Penciller> and <Inker>, and since the Issue table now has an inker column, filing ink roles
      // under Penciller would double-credit them on the next embed.
      if (role.includes('pencil') || role.includes('artist') || role.includes('illustrator')) artists.push(p.name);
      if (role.includes('ink')) inkers.push(p.name);
      if (role.includes('edit')) editors.push(p.name);
      if (role.includes('translat')) translators.push(p.name);
      if (role.includes('cover')) coverArtists.push(p.name);
      if (role.includes('color')) colorists.push(p.name);
      if (role.includes('letter')) letterers.push(p.name);
    });
  }

  if (character_credits) {
    character_credits.forEach(c => {
      if (c.name) characters.push(c.name);
    });
  }

  if (concept_credits) {
    concept_credits.forEach(c => {
      if (c.name && !isGenreNoise(c.name)) genres.push(c.name);
    });
  }

  if (story_arc_credits) {
    story_arc_credits.forEach(s => { if (s.name) storyArcs.push(s.name); });
  }

  if (team_credits) {
    team_credits.forEach(t => { if (t.name) teams.push(t.name); });
  }

  if (location_credits) {
    location_credits.forEach(l => { if (l.name) locations.push(l.name); });
  }

  return {
    writers: [...new Set(writers)],
    artists: [...new Set(artists)],
    coverArtists: [...new Set(coverArtists)],
    colorists: [...new Set(colorists)],
    letterers: [...new Set(letterers)],
    inkers: [...new Set(inkers)],
    editors: [...new Set(editors)],
    translators: [...new Set(translators)],
    characters: [...new Set(characters)],
    genres: [...new Set(genres)],
    storyArcs: [...new Set(storyArcs)],
    teams: [...new Set(teams)],
    locations: [...new Set(locations)]
  };
}