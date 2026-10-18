# Add Diffglow to an existing Maestro suite

Keep Maestro responsible for mobile interactions, assertions, app installation,
device selection, and screenshots. Diffglow consumes exported images; it does not
run Maestro Flows or require Maestro Cloud. Reuse the project's installed Maestro
version, Flows, device setup, and test command.

## Capture a named checkpoint

Reuse existing explicit captures. Otherwise append a screenshot after the existing
Flow steps have established and asserted the intended screen state:

```yaml
# Existing navigation, state setup, and assertions run above this step.
- takeScreenshot:
    path: checkout/ready
```

[`takeScreenshot`](https://docs.maestro.dev/reference/commands-available/takescreenshot.md)
writes PNG and adds the extension, so the checkpoint name above ends in
`checkout/ready.png`. Choose a distinct stable name for each state. Avoid failure
screenshots as substitutes for intentional checkpoints; they may show a different
state. Keep screenshots unmasked unless the project already has a documented
capture policy that excludes specific dynamic content.

## Keep builds, variants, and runs identifiable

Use the project's existing process to install the base build and candidate build
on equivalent devices and run the same Flows. Do not change a developer's checkout,
stash their work, or infer the installed app version from the checkout alone.
Record the actual source commit, build identity, platform, device model, OS,
screen size/pixel ratio, theme, locale, test data, and Maestro version for each run.

These example commands only add output destinations to an existing invocation;
preserve the project's real Flow paths, device flags, environment, and report setup:

```bash
maestro test --test-output-dir=artifacts/visual/run-001/base/maestro .maestro/checkout.yaml
```

```bash
maestro test --test-output-dir=artifacts/visual/run-001/candidate/maestro .maestro/checkout.yaml
```

The [artifact documentation](https://docs.maestro.dev/maestro-flows/workspace-management/test-reports-and-artifacts.md)
currently describes timestamped session and per-Flow bundles. Explicit captures
reside in each bundle's `takeScreenshot/` folder. `--test-output-dir` selects a root;
it does not imply that `checkout/ready.png` sits directly under that root. Consult
the installed version's actual output. Where present, use the Flow `manifest.json`
to locate artifacts and `commands.json` to attribute captures to executed steps.
Do not hardcode a session timestamp or mistake Maestro's manifest for Diffglow's
pairing manifest.

Keep the E2E exit status and available test reports. Record expected versus captured
checkpoints, failed/skipped Flows, attempts, and required/completed shards in a
separate run inventory. Collect all required devices and shards before assessing
coverage. A failed or absent Flow cannot establish that a screen was deleted.
Pair iOS with the corresponding iOS variant and Android with Android; never
compare across different devices, languages, or themes and call the result a pass.

## Pair the actual screenshot paths

Build an explicit Diffglow manifest from recorded artifacts. The stable identity
is the checkpoint plus environment variant, not the timestamped artifact path.
For example, save `artifacts/visual/run-001/pairs.json`, replacing these example
session/Flow names with the actual paths from each run:

```json
{
  "pairs": [
    {
      "id": "checkout-ready/ios/iphone-16/light/en-US",
      "before": "base/maestro/base-session/checkout_flow/takeScreenshot/checkout/ready.png",
      "after": "candidate/maestro/candidate-session/checkout_flow/takeScreenshot/checkout/ready.png"
    }
  ]
}
```

Paths resolve relative to `pairs.json`, and IDs must be unique. After installing
and pinning Diffglow in the project, compare with the existing CLI:

```bash
npx --no-install diffglow --manifest artifacts/visual/run-001/pairs.json --json --html --output-dir artifacts/visual/run-001/diffglow-report > artifacts/visual/run-001/comparison.stdout.json
```

If existing automation exports complete screenshot-only base and candidate
directories with matching relative checkpoint names, those two directories can
be passed directly instead. Do not compare the whole Maestro artifact tree: it
can include automatic failure images, timestamps, and repeated Flow attempts.

Save each rerun under a new run ID. Keep originals, run inventories, and the
entire Diffglow report including assets. The report destination must be dedicated
to Diffglow because rerunning the CLI replaces that directory; put your metadata
and redirected stdout outside it.

## Interpret evidence and rerun

Read `results.json` and inspect before/current/highlighted images against the
original task's expectations and existing Maestro assertions. Identify clipping,
overlap, missing controls, and unintended changes only when the evidence supports
them. Separate measured pixel facts from model interpretation. An image comparison
does not establish that a native control is interactive or accessible; rely on
existing tests and report uncovered checks.

Return passed, failed, or inconclusive per expectation with evidence paths.
Fix unexpected changes, then rerun the affected existing Flows and compare the new
captures. Preserve earlier failures. Do not promote screenshots or ask users to
manually approve them as the way to make verification succeed.

Diffglow currently supplies comparison artifacts, not an AI verdict, baseline
approval/history command, capture runner, or supported JavaScript API:

- `0` without `--fail-on-diff` means comparison outputs were generated; differences
  may still exist, and the requested change may still be absent.
- `1` with `--fail-on-diff` signals raw differences, not a semantic regression.
- `2`, E2E failures, missing required captures, mismatched variants, and incomplete
  shard/device runs prevent a verified result. Retain their evidence.

Do not interpret folder mode's `added`/`removed` labels as intentional screen
changes without task and coverage evidence. Missing captures are uncovered scope;
a small changed percentage or an agent's confidence statement cannot repair it.
