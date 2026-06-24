// src/lib/filter-defaults.ts
//
// Recommended Discover content-filter defaults, shared by the first-run setup wizard
// (src/app/setup/page.tsx) and the admin settings page (src/app/admin/settings/page.tsx) so the two
// can't drift. An admin's "Apply Recommended" writes these into the `filter_publishers` /
// `filter_keywords` SystemSettings; the Rust Discover sync (omnibus-engine/src/discover.rs) then
// matches them (word-boundary) against each Discover item's title + deck + description.

/** Publishers to block from the Discover feed — predominantly manga / adult imprints. Comma-separated. */
export const RECOMMENDED_PUBLISHERS =
  "hakusensha, shueisha, kodansha, shogakukan, square enix, yen press, viz media, seven seas, fakku, " +
  "project-h, denpa, irodori, eros comix, tokyopop, kadokawa, futabasha, houbunsha, takeshobo, " +
  "mag garden, akita shoten, shonen gahosha, nihon bungeisha, coamix, gee-whiz, ghost ship, " +
  "j-novel club, suiseisha, shinchosha, ascii media works, ichijinsha";

/**
 * Keywords to block — genre/demographic terms, adult terms, and known adult/seinen magazine names.
 * Curated to general, reusable patterns: typos fixed (e.g. "yojng comic"), ambiguous single words made
 * specific ("gaze" -> "comic gaze" so it can't false-match the verb in a synopsis), and one-off title
 * entries + non-NSFW foreign-language titles removed. Comma-separated.
 */
export const RECOMMENDED_KEYWORDS =
  "manga, hentai, doujinshi, shoujo, shojo, seinen, josei, gee-whiz, comic gaze, weekly young, " +
  "young animal, weekly shonen, monthly shonen, weekly playboy, monthly young magazine, " +
  "big comic superior, big comic spirits, young champion, young king, young comic, comic zenon, " +
  "shonen sunday s";

/**
 * True if `needle` occurs in `haystack` as a whole word — i.e. with no ASCII alphanumeric character
 * immediately on either side of the match. Byte-level (not a `/\b/` regex) so hyphenated needles
 * ("gee-whiz", "project-h") and multi-word phrases ("comic gaze") match correctly and regex
 * metacharacters are never an issue. Both arguments should already be lowercased. Parity with the
 * engine's `discover::contains_word`; used by the Discover content filter + the Anna's Archive blocklist
 * so the curated keyword list can't false-match substrings (e.g. "manga" inside "mangaka").
 */
export function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isWordChar = (c: string) =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack[idx - 1] : '';
    const afterIdx = idx + needle.length;
    const after = afterIdx < haystack.length ? haystack[afterIdx] : '';
    if ((!before || !isWordChar(before)) && (!after || !isWordChar(after))) return true;
    from = idx + 1;
  }
}
