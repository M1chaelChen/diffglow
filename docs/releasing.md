# Releasing Diffglow

Stable Diffglow versions use `x.y.z` and publish to npm's `latest` tag. Optional
alpha versions use `x.y.z-alpha.n` and publish to `alpha`. Releases start with a
manual GitHub Actions dispatch from a reviewed `main` commit. Ordinary pushes and
pull requests run checks without publishing. A stable version creates a regular
GitHub release; an alpha version creates a GitHub prerelease.

Configuring the workflow and trusted publisher does not require a version bump or
publish a package. The setup is fully proven only after a future release completes
an actual OIDC publication, registry installation, and GitHub release.

## One-time setup

Create the GitHub environment **`npm-publish`** in
[the repository settings](https://github.com/M1chaelChen/diffglow/settings/environments):

- Add **`M1chaelChen`** as a required reviewer.
- Allow deployments from the selected branch **`main`** only.
- With a single maintainer, leave **Prevent self-review** disabled so the person
  dispatching the workflow can approve the release.

Do not add an `NPM_TOKEN` secret. The publishing job receives a short-lived OIDC
identity after the environment approval. No npm authentication token is stored in
GitHub Actions.

In npm's Diffglow package settings, configure this trusted publisher:

| Setting | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Label | `Diffglow GitHub Actions` (optional) |
| Organization or user | `M1chaelChen` |
| Repository | `diffglow` |
| Workflow filename | `release.yml` |
| Environment name | `npm-publish` |
| Allow `npm publish` | Checked |
| Allow `npm dist-tag` | Unchecked |

Use the filename only, without `.github/workflows/`. The environment name must
match the publishing job exactly. npm fixes the provider and required fields when
the connection is created; correcting those fields requires deleting and creating
the connection again. Direct publishing sets the version's selected tag (`latest`
or `alpha`) as part of publication and does not require a separate `npm dist-tag`
permission. Keep that independent permission disabled.

Complete the first actual trusted publication within two days of creating the
connection; unused new connections expire. A preparation-only workflow run does
not exercise npm trust or prevent that expiry. If no new release is ready, recreate
the connection when publication is ready instead of publishing a throwaway version.
See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## Prepare and review locally

```bash
npm ci
npm run release:prepare
```

This command writes `artifacts/release/<version>/` without pushing source, creating
a tag, staging a package, or publishing. The review bundle contains the tarball,
`SHA256SUMS`, file inventory, package/public-source audit reports, validation log,
release notes, dependency licenses, and original demonstration screenshots.

Inspect the actual tarball and public Git tree. Keep research, credentials,
development tooling, private screenshots, machine-specific paths, and temporary
artifacts out of public contents. Confirm the README, metadata, executable,
third-party notices, and demonstration images. Package comparison logic remains
internal; the supported interface is the CLI.

A local run proves only its own platform and Node.js version. Publication requires
the hosted Linux/macOS/Windows × Node.js 22/24 matrix against the same canonical
candidate.

## Run a release

1. Prepare and review a version/changelog change. Update `package.json` and its
   lockfile together, using `x.y.z` for stable or `x.y.z-alpha.n` for alpha. Set
   `package.json`'s `publishConfig.tag` to the matching `latest` or `alpha` channel;
   the workflow rejects a mismatch. Push the reviewed commit to `main` and record
   its full 40-character SHA.
2. Open [Actions → release workflow](https://github.com/M1chaelChen/diffglow/actions/workflows/release.yml)
   and select **Run workflow** on **main**. Supply:

   | Input | Value |
   | --- | --- |
   | `expected_sha` | The full reviewed `main` commit SHA |
   | `expected_version` | The exact version in that commit's `package.json` |
   | `publish_to_npm` | `true` for publication; the default `false` only prepares and verifies |

3. The workflow validates the repository, selected branch, SHA, and package
   version. It builds and audits one canonical tarball, then installs and checks
   those exact bytes across all six platform/Node combinations. It retains the
   candidate and platform evidence as workflow artifacts.
4. With `publish_to_npm: true`, the publishing job waits at the **`npm-publish`**
   environment. Review the candidate, checksum, platform results, and source
   commit, then approve **Review deployments** in the workflow run.
5. After approval, npm verifies the workflow's OIDC identity. The job publishes the
   downloaded, checksum-verified tarball directly with the version's selected tag
   (`--tag latest` for stable or `--tag alpha` for alpha), public access,
   provenance, and lifecycle scripts disabled. It does not rebuild the package or
   ask for an npm password, token, or interactive 2FA approval.
6. A separate verification job checks the registry's exact version and integrity,
   confirms the selected tag, and installs the release into a fresh consumer/cache.
   It checks the installed CLI and actual comparisons, including output generation
   and exit codes. npm can accept a publication before its version metadata and
   tag become visible; verification polls for up to five minutes with delays
   increasing from two seconds to a maximum of 15 seconds. Both the reviewed
   integrity and the expected tag must match. This job has no publishing
   permission.
7. Only after registry verification succeeds, a separate job creates
   **`v<version>`** at the reviewed commit and publishes a GitHub release with
   the release notes and release assets. That job receives `contents: write`;
   it does not receive npm's OIDC publishing permission. Stable versions are regular
   releases, and alpha versions are marked as prereleases.

Use `publish_to_npm: false` to validate the configured workflow without registry
writes or a GitHub release. This tests preparation and the platform matrix;
it does not prove OIDC authentication. A later dispatch with publishing enabled
prepares a new candidate, which must pass its own checks and environment review.

## Verify the result

The workflow records the published version, source commit, checksum, registry
checks, and GitHub release in its run summary. Check that npm's provenance links
back to the intended repository and workflow run.

For an additional manual check, use an empty directory outside the checkout and
substitute the newly published version:

```bash
npm view diffglow@0.1.0 version dist.integrity dist-tags
npx --yes diffglow@0.1.0 --version
npx --yes diffglow@0.1.0 before.png after.png --output highlighted.png
```

Confirm the selected tag (`latest` for stable) resolves to that version, the image
is correct, unchanged inputs report zero changes, invalid input returns `2`, and
`--fail-on-diff` returns `1` after generating output when changes exist. Review
announcement copy separately before posting it; the release workflow does not
publish announcements.

## Recovery and retries

- Before publication, failed checks have no registry side effect. Fix the problem
  in a newly reviewed commit and run its checks.
- After an interruption, choose **Re-run failed jobs** in the **same workflow
  run**. This reuses the original canonical candidate and completed platform
  checks. Do not start a new dispatch or rerun successful preparation jobs merely
  to recover a later step. Artifacts are retained for 14 days; if unavailable,
  stop and review a newly prepared candidate.
- The publishing job checks for the exact version first. An existing package with
  the same integrity skips publication and resumes verification. Different bytes
  for the same version fail; use a new version after investigation.
- A network failure can happen after npm accepts a package. Inspect the registry
  before retrying. The workflow rechecks the exact version and integrity rather
  than assuming a failed command means nothing was published.
- A publication-processing timeout also does not mean the package was rejected.
  Inspect the exact registry version, integrity, and selected tag. Once the reviewed
  bytes and tag are visible, choose **Re-run failed jobs** in the same workflow
  run so verification can finish with the original candidate. Do not republish,
  bump the version, or create a new candidate just to recover from this delay.
  Integrity mismatches, a newer release on the selected tag, and authorization
  errors still fail immediately instead of being treated as processing delays.
- An existing Git tag must resolve to the reviewed commit. Existing release assets
  must match the reviewed bytes. Conflicting tags or assets fail instead of being
  overwritten. A matching release can be completed on a retry.
- If a newer version already owns the selected tag, investigate rather than
  silently moving it backward. For a defective published version, publish a
  corrected patch or prerelease and deprecate the defective version with an
  upgrade message.

If OIDC configuration cannot be repaired in time, manual staged publishing is a
maintainer recovery option. Use Node.js 24 and npm 12.2.0, authenticate interactively
with 2FA, and use the exact reviewed candidate rather than repacking:

```bash
npm stage publish ./diffglow-<version>.tgz --tag latest --access public
npm stage view <stage-id>
npm stage download <stage-id>
```

For an alpha candidate, replace `--tag latest` with `--tag alpha`. Compare the
downloaded bytes with the reviewed checksum, then approve with
`npm stage approve <stage-id>` and complete 2FA. Reject an incorrect stage with
`npm stage reject <stage-id>`. Pending stages are not approved by OIDC or by the
release workflow. After manual approval, rerun the failed jobs in the original
workflow: matching registry integrity allows verification and GitHub release
creation to finish. Manual publication does not claim GitHub Actions provenance.
See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

Never overwrite a published version or use unpublishing as routine recovery. A
maintainer can explicitly restore a channel to a previously verified release with
interactive authentication when recovery requires it; the trusted publisher does
not receive permission to manage dist-tags independently.

## Retire the alpha channel after the first stable release

After verifying `0.1.0`, its provenance, a fresh installation, and the `latest` tag,
a maintainer can remove the old alpha alias using an authenticated npm session:

```bash
npm dist-tag ls diffglow
npm dist-tag rm diffglow alpha
npm dist-tag ls diffglow
```

Confirm `latest: 0.1.0` remains and `alpha` is absent. This removes the alias; it
does not delete previously published alpha versions, which remain installable by
their exact versions. It also means `diffglow@alpha` is no longer an installation
command until a future alpha is published.

This one-time cleanup is separate from OIDC publication because the approved
trusted publisher cannot manage dist-tags independently. npm may require a fresh
interactive login and physical 2FA verification. Do not add a long-lived publishing
token or broaden the trusted publisher to automate the cleanup.
