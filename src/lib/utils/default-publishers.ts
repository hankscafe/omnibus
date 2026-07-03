// Canonical default manga / western publisher lists used for manga detection and the settings
// "Load Default Lists" button. Kept as plain string constants with no imports so this is safe to use
// from both server code (manga-detector.ts) and the client settings page. Keep in lock-step with the
// Rust engine's DEFAULT_*_PUBLISHERS in omnibus-engine/src/manga_detector.rs.
export const DEFAULT_MANGA_PUBLISHERS = [
    "viz media", "kodansha", "yen press", "seven seas", "shueisha",
    "shogakukan", "tokyopop", "dark horse manga", "vertical",
    "ghost ship", "denpa", "fakku", "j-novel club", "sublime",
    "kuma", "ize press", "square enix", "hakusensha", "lezhin",
    "kadokawa", "futabasha", "houbunsha", "takeshobo", "mag garden",
    "akita shoten", "shonen gahosha", "nihon bungeisha", "coamix",
    "gee-whiz", "suiseisha", "ascii media works", "ichijinsha",
    "project-h", "irodori", "eros comix"
];

export const DEFAULT_WESTERN_PUBLISHERS = [
    "marvel", "dc comics", "image comics", "idw publishing",
    "dynamite", "boom! studios", "valiant", "archie",
    "oni press", "titan comics", "vault comics", "awa studios", "humanoids", "2000 ad", "zenescope"
];
