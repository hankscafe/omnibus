import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// --- NEW: Shared Release Date Checker ---
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

// --- NEW: Shared ComicVine Metadata Parser ---
export function parseComicVineCredits(person_credits?: any[], character_credits?: any[]) {
  const writers: string[] = [];
  const artists: string[] = [];
  const coverArtists: string[] = [];
  const characters: string[] = [];

  if (person_credits) {
    person_credits.forEach((p: any) => {
      const role = (p.role || '').toLowerCase();
      if (role.includes('writer') || role.includes('script') || role.includes('plot') || role.includes('story')) writers.push(p.name);
      if (role.includes('pencil') || role.includes('ink') || role.includes('artist') || role.includes('color') || role.includes('illustrator')) artists.push(p.name);
      if (role.includes('cover')) coverArtists.push(p.name);
    });
  }

  if (character_credits) {
    character_credits.forEach((c: any) => {
      if (c.name) characters.push(c.name);
    });
  }

  return {
    writers: [...new Set(writers)],
    artists: [...new Set(artists)],
    coverArtists: [...new Set(coverArtists)],
    characters: [...new Set(characters)]
  };
}