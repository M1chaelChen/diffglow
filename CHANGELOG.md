# Changelog

## 0.1.0-alpha.2

- Compare recursive folder sets using `baseline/` and `current/` defaults, explicit
  folder paths, or named JSON manifest pairs.
- Configure folder names, include/exclude globs, and filename pairing templates.
- Add opt-in offline HTML reports with screenshot assets, search, status filters,
  detailed statistics, and full-resolution image links.
- Report added/removed screenshots and continue after per-file errors, with
  weighted aggregate statistics and deterministic batch JSON results.
- Stage generated reports before replacing Diffglow-owned output directories.
- Add `--json` for machine-readable comparison statistics alongside the generated
  PNG, including changed/unchanged counts, overlapping modifications, added/removed
  image areas, and change bounds.
- Return structured errors in JSON mode while preserving existing exit codes and
  plain-text output by default.

## 0.1.0-alpha.1

Initial open-source CLI release.

- Compare PNG and JPEG screenshots locally and highlight changes in magenta over
  the second image while preserving unchanged pixels.
- Normalize orientation and sRGB color, align at the top-left without resizing,
  and highlight added or removed image areas.
- Configure per-pixel sensitivity with `--threshold`; use `--fail-on-diff` for CI.
- Report changed-pixel counts, percentages, and the output path.
- Protect input images against output overwrites, including symbolic and hard
  links, and reject unsupported inputs or excessive image dimensions.
- Install the compiled `diffglow` command from npm without development tooling.
- Include deterministic fixtures, packed-package checks, platform CI, and
  Apache-2.0 licensing with third-party notices.

This alpha compares image files supplied by the user. Screenshot capture, baseline
management, and a supported JavaScript API are outside this release.
