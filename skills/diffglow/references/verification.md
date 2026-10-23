# Verification plans and evidence

These are artifacts authored by the agent using this skill. They are not inputs
understood by the current Diffglow CLI, its `--manifest` format, or a built-in AI
verification engine. Store them beside the generated comparison directory, never
inside a directory that Diffglow replaces.

## Establish intent

Record a small plan from the original task and project requirements. Prefer
concrete checks to "looks good" and separate an allowed effect from protected
behavior in the same region. Allowing a button's color to change does not allow
its label to disappear or its position to move. A code diff can help locate
relevant checkpoints but is not an independent statement of desired behavior.

For example, a plan for "make the checkout button green without changing layout":

```json
{
  "artifactType": "diffglow-agent-plan",
  "schemaVersion": 1,
  "requirement": "Make the checkout button green without changing layout",
  "expectations": [
    {
      "id": "checkout-color",
      "checkpoint": "checkout/ready",
      "expected": "Checkout button uses the project's specified green token"
    },
    {
      "id": "checkout-layout",
      "checkpoint": "checkout/ready",
      "expected": "Button label, geometry, and surrounding layout are preserved"
    }
  ],
  "requiredVariants": ["web-chromium-desktop-en-light"],
  "protectedCheckpoints": ["login/ready"]
}
```

Adapt the plan to the task. Do not invent a color token or other acceptance
criterion when the requirement does not specify one. Capture missing detail as a
limit on the corresponding check; progress on independent checks can continue.
For a broad redesign, use the supplied design/requirements and persistent layout
constraints rather than requiring every old pixel or element position to remain.

## Keep evidence attributable

Record enough to distinguish what was actually tested:

- Reference and candidate source revisions, dirty-source status where relevant,
  capture run IDs, screenshot hashes, and checkpoint names.
- Browser/platform/device profile, viewport, scale, theme, locale, and relevant
  test-data configuration. Separate incompatible variants rather than resizing
  images to make them agree.
- Existing E2E command/result, required shards, retry attempt, and which expected
  captures completed, failed, or were skipped. Missing screenshots are not proof
  of intentional removal. Mark unrepresented platforms as uncovered.
- Diffglow version, settings, raw exit code, and the saved JSON/report assets.
- The verification plan fingerprint and evidence supporting each conclusion.

Use an existing project metadata format when available. A file-based adapter can
record these alongside captures; Diffglow does not collect this metadata itself.
If noise is suspected, a bounded repeat of the same code/environment can help
identify unstable captures. Preserve the disagreement instead of retrying until
a favorable image appears or automatically increasing the threshold.

Record effective per-pair masks as comparison settings, including matching
`ignoreRegionsById` rules and manifest regions. Masked content remains visible in
images and cannot support a pixel-comparison conclusion about that area. Portable
paths (`--relative`) and smaller report assets (`--max-height`, lossless WebP) help
sharing, but do not redact captures. Retain full-resolution originals and inspect
them when reduced previews cannot resolve a required detail; unchanged statistics
do not give a thumbnail the evidentiary detail of the original image.

## Report evidence and uncertainty separately

An illustrative report structure:

```json
{
  "artifactType": "diffglow-agent-verification",
  "schemaVersion": 1,
  "verdict": "inconclusive",
  "comparison": {
    "exitCode": 0,
    "status": "different",
    "report": "run-001/comparison/results.json"
  },
  "checks": [
    {
      "id": "checkout-color",
      "status": "passed",
      "method": "runner-assertion",
      "evidence": ["run-001/runner-results.json#checkout-color"],
      "observation": "Existing runner assertion confirms the specified token"
    },
    {
      "id": "checkout-layout",
      "status": "inconclusive",
      "method": "visual-assessment",
      "evidence": ["run-001/comparison/index.html"],
      "observation": "The whole-page preview is too small to assess label clipping"
    }
  ],
  "coverage": {
    "required": ["web-chromium-desktop-en-light"],
    "completed": ["web-chromium-desktop-en-light"],
    "missing": []
  },
  "limitations": ["No native mobile captures were requested or checked"]
}
```

Populate reports only with evidence that exists and was inspected. Reference the
recorded run metadata and plan, as well as individual files/crops/assertions.
The example's runner assertion is not provided by Diffglow; if it did not run,
use the actual verification method and status instead.

Use `passed` only when every required check passes with adequate evidence and
coverage is complete. Any required failure makes the verdict `failed`; otherwise
an unresolved check, missing capture, or processing problem makes it
`inconclusive`. Record a nonzero E2E exit as an execution check: a documented
required assertion failure is `failed`, while an unexplained nonzero exit or
infrastructure failure is `inconclusive` until its cause is established. Neither
can yield an overall pass, and neither should be silently relabeled as a visual
regression. Preserve the original runner exit code and errors.

Distinguish pixel measurements, runner assertions, and model
assessments. A visual assessment can pass a scoped visual question, but cannot be
presented as a measured fact or proof that unobserved behavior works.

This report communicates the agent's conclusions. A CI system cannot enforce
these semantics simply by running today's comparison CLI. Preserve existing
gates and identify any separate verifier/policy implementation the customer wants.
