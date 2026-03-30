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

// --- Shared ComicVine Metadata Parser ---
export function parseComicVineCredits(
  person_credits?: ComicVineCredit[], 
  character_credits?: ComicVineCredit[],
  concept_credits?: ComicVineCredit[],
  story_arc_credits?: ComicVineCredit[]
) {
  const writers: string[] = [];
  const artists: string[] = [];
  const coverArtists: string[] = [];
  const characters: string[] = [];
  const genres: string[] = [];
  const storyArcs: string[] = [];

  if (person_credits) {
    person_credits.forEach(p => {
      const role = (p.role || '').toLowerCase();
      if (role.includes('writer') || role.includes('script') || role.includes('plot') || role.includes('story')) writers.push(p.name);
      if (role.includes('pencil') || role.includes('ink') || role.includes('artist') || role.includes('color') || role.includes('illustrator')) artists.push(p.name);
      if (role.includes('cover')) coverArtists.push(p.name);
    });
  }

  if (character_credits) {
    character_credits.forEach(c => {
      if (c.name) characters.push(c.name);
    });
  }

  if (concept_credits) {
    concept_credits.forEach(c => {
      if (c.name) genres.push(c.name);
    });
  }

  if (story_arc_credits) {
    story_arc_credits.forEach(s => { if (s.name) storyArcs.push(s.name); });
  }

  return {
    writers: [...new Set(writers)],
    artists: [...new Set(artists)],
    coverArtists: [...new Set(coverArtists)],
    characters: [...new Set(characters)],
    genres: [...new Set(genres)],
    storyArcs: [...new Set(storyArcs)]
  };
}