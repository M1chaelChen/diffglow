# Add Diffglow to an existing Playwright suite

Keep Playwright responsible for navigation, assertions, application startup, and
screenshots. Diffglow consumes the image files. Reuse the project's installed
Playwright version, fixtures, projects, and invocation; do not replace its test
configuration or introduce another runner.

## Capture a named checkpoint

Reuse existing explicit screenshot captures when available. Otherwise add a
capture after the existing assertions that establish the intended screen state.
Inside an existing test receiving `({ page }, testInfo)`, for example:

```ts
// Existing navigation, data setup, and assertions run above this line.
const screenshotPath = testInfo.outputPath('diffglow', 'checkout-ready.png');
await page.screenshot({ path: screenshotPath, type: 'png' });
```

[`page.screenshot`](https://playwright.dev/docs/screenshots) supplies the PNG;
[`testInfo.outputPath`](https://playwright.dev/docs/api/class-testinfo#test-info-output-path)
isolates concurrent tests' output. Give each checkpoint a distinct name. Record
the actual path, project, test identity, and attempt in the capture inventory;
do not infer stable checkpoint identity from Playwright's generated directory name.

Preserve the suite's existing capture policy, including viewport versus full-page
screenshots. If animations or changing data cause noise, fix capture consistency
in the existing test setup and document any exclusions. Do not hide the changed
component or relax assertions to obtain a clean comparison.

## Keep base and candidate runs separate

Obtain the base build and candidate build through the project's existing build or
CI workflow. Do not switch branches, stash changes, or alter a developer's running
application to produce a reference. If a trustworthy base is unavailable, report
the comparison as inconclusive.

These are example destinations added to an existing command, run against the
corresponding build; retain the project's actual options and project names:

```bash
npx playwright test tests/checkout.spec.ts --project chromium --output artifacts/visual/run-001/base/playwright
```

```bash
npx playwright test tests/checkout.spec.ts --project chromium --output artifacts/visual/run-001/candidate/playwright
```

Playwright documents [`--output`](https://playwright.dev/docs/test-cli) for test
artifacts. Choose a new run directory for each rerun so earlier evidence survives.
For sharded suites, use distinct destinations per shard, then collect every
required shard before assessing coverage. Keep retries and repeated executions
identifiable; do not select the cleanest attempt and discard failures.

Alongside captures, record each build's commit and dirty-state/build identity,
Playwright and browser versions, OS/container, project/device, viewport, pixel
ratio, theme, locale, test-data identity, screenshot options, and capture time.
Include expected checkpoints, captured checkpoints, E2E exit status, skipped or
failed tests, retries, and required/completed shards. This inventory is workflow
metadata; it is not a Diffglow configuration schema. Pair only matching variants.

## Compare explicit checkpoints

Use a Diffglow manifest when generated test directories differ or contain retries.
For example, save `artifacts/visual/run-001/pairs.json` after replacing these
illustrative directory names with the recorded capture paths:

```json
{
  "pairs": [
    {
      "id": "checkout-ready/chromium/1280x720/light/en-US",
      "before": "base/playwright/checkout-guest-chromium/diffglow/checkout-ready.png",
      "after": "candidate/playwright/checkout-guest-chromium/diffglow/checkout-ready.png"
    }
  ]
}
```

Both paths resolve relative to `pairs.json`. IDs must be unique. After installing
and pinning Diffglow in the project, run:

```bash
npx --no-install diffglow --manifest artifacts/visual/run-001/pairs.json --json --html --output-dir artifacts/visual/run-001/diffglow-report > artifacts/visual/run-001/comparison.stdout.json
```

If the project already exports two complete screenshot-only folders with stable
relative names, pass those folders instead of creating a manifest. Never compare
the entire Playwright artifact tree: it can contain failure screenshots and
multiple attempts that are not intended checkpoints.

Keep the report directory separate from inputs and your own metadata. Diffglow
replaces its report directory on rerun. Preserve the entire report, including
assets, and both original capture inventories even if tests or comparisons fail.

## Feed evidence back to the coding agent

Inspect `results.json`, each before/current/diff image, existing E2E assertions,
and the expectations written before inspecting candidate output. Distinguish
observed pixel changes from an interpretation that the requested change is correct.
Report each expectation as passed, failed, or inconclusive with evidence paths.
Fix unexpected changes and rerun the affected existing tests into a new directory;
do not overwrite references or add manual snapshot approval as the acceptance step.

Diffglow currently has no AI verdict, baseline approval/history command, capture
runner, or supported JavaScript API. Its exit code is comparison evidence:

- `0` without `--fail-on-diff` means output generation succeeded; changes may exist.
- `1` with `--fail-on-diff` means raw differences were detected, not that they are
  regressions. Use this flag only when the integration needs that mechanical gate.
- `2`, failed E2E checks, missing required captures, mismatched environments, or
  incomplete shards prevent a verified result. Preserve errors in the final report.

A missing capture is uncovered scope until explained. Folder mode's `added` and
`removed` labels do not establish intentional UI additions or deletions. An
identical image also cannot prove that a required visual change occurred.
