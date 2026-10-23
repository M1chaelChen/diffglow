# Diffglow 0.1.0 announcement draft

Publication status: draft. Publish only after the launch checks in
[releasing.md](releasing.md) pass.

---

Diffglow 0.1.0 is the first stable release of an open-source screenshot comparison
CLI. It highlights changed pixels directly over the current image, keeping
unchanged areas in their original colors. Processing happens locally without
screenshot uploads or telemetry.

```bash
npx --yes diffglow before.png after.png --output highlighted.png
```

Compare individual PNG/JPEG files, folders, or named screenshot pairs. Generate
offline HTML and JSON reports, choose a highlight color, and ignore dynamic areas
such as mobile clocks, prices, dates, and balances. Use `--fail-on-diff` to make
changes fail a CI check after writing the results.

For a report to share:

```bash
npx --yes diffglow baseline/ current/ --html --relative \
  --max-height 1200 --image-format webp --output-dir share-report
```

The smaller report images retain full-resolution comparison statistics.
`--relative` removes local absolute paths from report data and diagnostics. Masks
exclude comparison pixels; they do not redact screenshots. Review image contents
and comparison IDs before sharing the complete report directory.

![Diffglow before, after, and highlighted comparison](demo.png)

Diffglow works with screenshot files from web and mobile applications. Your
existing screenshot tools supply the images; the optional bundled agent skill
connects comparison evidence with existing Playwright, Maestro, or other E2E
workflows. The CLI does not capture screens, manage baselines, or add an AI service.

Try [Diffglow on npm](https://www.npmjs.com/package/diffglow), browse the
[Apache-2.0 source and examples](https://github.com/M1chaelChen/diffglow), or share a
minimal reproduction through [GitHub issues](https://github.com/M1chaelChen/diffglow/issues).

---

Before posting, verify the registry's `latest` tag, package/repository links, and
the stable GitHub release. Attach the original demonstration image. A short
terminal recording may show the command, printed result, and highlighted image;
use project-owned fixtures only. The release workflow does not post this draft.
