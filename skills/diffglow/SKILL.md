---
name: diffglow
description: Integrate Diffglow with existing E2E screenshot tooling, or verify a UI change through intent, captures, visual evidence, agent feedback, and reruns. Use for Playwright, Maestro, or other screenshot-producing suites; preserve the existing test runner.
---

# Diffglow

Use the customer's existing E2E tools to capture screenshots and Diffglow to
compare them. Use your own image-reading capabilities to assess visual intent.
The workflow is **intent → existing E2E captures → evidence → agent feedback →
rerun**. Routine changes do not require a separate snapshot approval ceremony.

## Find the integration point

Inspect the project's instructions, package manager, existing test commands,
screenshot checkpoints, CI jobs, and available reference captures. Preserve the
chosen runner and its assertions. Add named screenshot checkpoints only where
the requested coverage is missing; do not replace a working E2E suite.

- For Playwright, read [references/playwright.md](references/playwright.md).
- For Maestro, read [references/maestro.md](references/maestro.md).
- For verification plans and evidence reports, read
  [references/verification.md](references/verification.md).
- For another runner, use its existing screenshot output and the same file or
  folder comparison interface. Do not require browser-only metadata for mobile.

Prefer the project's installed, pinned Diffglow command. If installing it is part
of the request, use the project's package manager and record the resolved version
in its lockfile. Diffglow requires Node.js 22+. Check that version's `--help`
before configuring commands. Keep the skill usable independently of a particular
coding-agent vendor or hosted model provider.

## Integrate with the current CLI

Diffglow accepts PNG/JPEG files, two folders, a root with `baseline/` and `current/`,
or explicit JSON pairs. Names and variants must identify the same checkpoint
across runs. Separate browser/device, viewport, locale, and theme where relevant;
keep timestamps and run IDs out of checkpoint identity.

For an installed command, an evidence-producing invocation is:

```sh
diffglow captures/base captures/candidate --html --json --output-dir artifacts/diffglow/run-001
```

Adapt paths and the invocation to the existing project. Preserve stdout JSON and
the complete report directory, including assets, even if a comparison or E2E job
fails. Use a distinct report directory per run and keep verification plans and
agent reports outside the generated directory: rerunning replaces that directory.
Keep generated captures out of source control unless project policy says otherwise.

Exit `0` means the comparison completed, even if images differ. With
`--fail-on-diff`, exit `1` means raw differences were found; it does not establish
that they are regressions. Exit `2` means processing failed. Record E2E results
separately so a completed comparison cannot hide a failed test run. Preserve any
existing strict visual gate; do not turn it green by swallowing failures.

The CLI currently produces pixel evidence, not an AI verdict. It has no supported
JavaScript import API, semantic `verify` command, approval command, or automatic
baseline history. Plans and agent reports below are skill-authored artifacts,
separate from CLI `results.json`. If asked for an enforced semantic CI check,
identify that additional implementation explicitly; prose from this skill is
not an executable gate or independent verification service.

## Verify the change

1. Derive expected effects and protected behavior from the original request,
   acceptance criteria, and existing tests. Save that plan before inspecting the
   candidate images. If implementation already exists, record that fact and use
   the original requirements rather than treating the patch as proof of intent.
   Do not broaden expectations, masks, or tolerances to explain away a failure.
2. Obtain reference and candidate captures from the existing E2E workflow under
   matching render conditions. Record source revisions, runner outcomes, capture
   hashes, expected checkpoint coverage, and comparison settings. Confirm the
   images show the declared checkpoint/state; filenames alone do not establish
   that the correct screen was captured. Never label
   synthetic fixtures or two copies of the same capture as real before/after
   application evidence. If the reference or runner is unavailable, make useful
   integration changes and report the missing execution as inconclusive.
3. Check completeness before interpreting folder additions/removals. A missing
   screenshot may mean a skipped/failed test or absent shard. Require explicit
   scope/completion information for deletions; do not remove references based on
   absence alone. Aggregate compatible shards and identify retry attempts without
   selecting whichever image happens to pass.
4. Read the original before/after images and highlighted diff. Examine changed
   areas at sufficient resolution and keep whole-screen context. Pixel counts
   establish change, not correctness. Verify text, geometry, state, and visibility
   with supplied runner assertions or element metadata where available. Report
   screenshot-only judgments as model-assessed; an accessibility assertion alone
   does not prove the absence of visual clipping or overlap.
5. Return per-check **passed**, **failed**, or **inconclusive**, with evidence and
   verification method. A measured failure cannot be waived by model opinion.
   Missing coverage, unreadable evidence, or an ambiguous requirement stays
   inconclusive. Never invent model confidence percentages or claim the whole
   application is correct because captured checkpoints passed.
6. Fix demonstrated defects within the authorized task, then rerun the relevant
   existing E2E tests and comparison. Preserve earlier evidence, bound retries,
   and stop when checks pass or further progress needs missing infrastructure,
   product clarification, or authorization beyond the task. Report unresolved
   issues instead of weakening the checks.

## Handoff and references

Summarize intended effects verified, unexpected changes, failed/incomplete tests,
coverage limits, and links to the evidence. Keep raw diff status distinct from
the agent's semantic verdict. An integration-only request can be complete while
real application verification remains unexecuted; say which was achieved.

Use the project's established reference/history process if one exists. Do not
overwrite references merely to make a comparison pass. If automatic advancement
is requested, bind it to the exact verified capture hashes and the project's
normal trusted merge/check process, preserving previous revisions. Changes to
the images, reference, expectations, or settings invalidate affected conclusions.
Do not introduce manual per-snapshot approvals as the default workflow.
