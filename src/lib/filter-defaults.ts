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
