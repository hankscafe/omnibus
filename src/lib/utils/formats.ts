// src/lib/utils/formats.ts

/** Every archive format Omnibus can import and read. */
export const COMIC_EXTENSIONS = ['.cbz', '.cbr', '.zip', '.rar', '.cb7', '.epub'];
export const COMIC_EXT_REGEX = /\.(cbz|cbr|zip|rar|cb7|epub)$/i;
export const isComicFile = (name: string) => COMIC_EXT_REGEX.test(name);

/** Image formats considered valid pages inside an archive. */
export const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp|gif|bmp)$/i;