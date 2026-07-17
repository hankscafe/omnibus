#!/usr/bin/env python3
"""Regenerate the .cb7 (7z) reader/scanner test fixtures.

The .cb7 fixtures mirror their .cbr siblings entry-for-entry so the native-7z
reading tests assert the same expectations as the RAR tests:

  reader_pages.cb7    01.png, 02.png, 10.png   (10 sorts after 2 -> natural order)
  comicinfo_pack.cb7  01.jpg, ComicInfo.xml    (non-image entry must not count as a page)

Entry BYTES are copied verbatim from the .cbr fixtures (extracted with unrar) so
the two archive formats carry identical content. Requires `py7zr` (pip install
py7zr) and `unrar` on PATH. Run from anywhere:

    python omnibus-engine/tests/fixtures/make_cb7_fixtures.py
"""
import io
import subprocess
import sys
from pathlib import Path

try:
    import py7zr
except ImportError:
    sys.exit("py7zr is required: pip install py7zr")

FIXTURES = Path(__file__).resolve().parent
# Ordered so 7z stores entries in this sequence (matches the .cbr listing order).
SOURCES = {
    "reader_pages.cb7": ("reader_pages.cbr", ["01.png", "02.png", "10.png"]),
    "comicinfo_pack.cb7": ("comicinfo_pack.cbr", ["01.jpg", "ComicInfo.xml"]),
}


def entry_bytes(cbr: Path, name: str) -> bytes:
    # `unrar p` prints one entry to stdout; -inul silences everything else, -p- skips the
    # password prompt. Exit code is not trusted (vintage-RAR quirk) — bytes are the signal.
    out = subprocess.run(
        ["unrar", "p", "-inul", "-p-", str(cbr), name],
        capture_output=True,
    ).stdout
    if not out:
        sys.exit(f"could not extract {name} from {cbr.name}")
    return out


def main() -> None:
    for target, (cbr_name, entries) in SOURCES.items():
        cbr = FIXTURES / cbr_name
        if not cbr.exists():
            sys.exit(f"missing source fixture: {cbr}")
        dest = FIXTURES / target
        with py7zr.SevenZipFile(dest, "w") as archive:
            for name in entries:
                archive.writef(io.BytesIO(entry_bytes(cbr, name)), name)
        print(f"wrote {dest.name} ({dest.stat().st_size} bytes): {', '.join(entries)}")


if __name__ == "__main__":
    main()
