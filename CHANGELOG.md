# Changelog

## 0.1.0-alpha.1

Initial open-source CLI release, prepared for publication.

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
