# Changelog

## 0.1.0

First stable CLI release, published on the npm `latest` channel.

- Hide the highlighted diff panel for identical comparisons in HTML reports, using
  the full available width for the baseline and current images.
- Add `--relative` for portable HTML, JSON, and CLI path presentation, including
  sanitized native error diagnostics, without changing filesystem safeguards.
- Reduce shared report assets with `--max-height` and lossless
  `--image-format webp`, while retaining full-resolution comparison statistics and
  the ordinary single-pair PNG output.
- Configure dynamic areas by comparison ID with `ignoreRegionsById` glob rules
  and per-pair manifest `ignoreRegions`, additive with selected global masks.
  Comparison masks do not redact screenshot previews or support element selectors.

## 0.1.0-alpha.5

- Ignore rectangular areas such as mobile clocks with repeatable `--ignore-region`
  flags or JSON `ignoreRegions`, across single, folder, and manifest comparisons.
- Exclude ignored pixels from highlights, comparison totals, percentages, bounds,
  and failure checks; report regions and ignored-pixel counts in JSON and HTML.
- Handle overlapping and clipped regions consistently, and identify comparisons
  with no remaining pixels without claiming visual coverage.
- Configure the highlight color with `--highlight-color` or JSON `highlightColor`,
  accepting `#RGB` and `#RRGGBB` while retaining the default magenta and 65% opacity.
- Apply the selected color to single, folder, and manifest comparisons and HTML
  report legends; record normalized rendering settings in JSON reports without
  changing comparison statistics.

## 0.1.0-alpha.4

- Bundle an optional agent skill for adding Diffglow to existing E2E workflows,
  with Playwright and Maestro guidance and an intent/evidence/fix/rerun loop.
- Distinguish raw screenshot changes, runner assertions, and agent assessments
  in verification plans and reports without adding manual snapshot approvals.

## 0.1.0-alpha.3

- Publish reviewed alpha releases from GitHub Actions using npm Trusted Publishing
  and provenance, after approval in the main-only `npm-publish` environment.
- Verify a fresh registry installation before creating the GitHub prerelease.
- Check candidate integrity, immutable versions, release tags, and asset digests
  so interrupted releases can resume without overwriting published contents.
- Add offline release-safety tests and document the approval and recovery flow.

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
