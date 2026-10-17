# Releasing Diffglow

The initial target is `diffglow@0.1.0-alpha.1`, npm tag `alpha`, and GitHub
prerelease `v0.1.0-alpha.1` in `M1chaelChen/diffglow`. Keep stable releases and
`latest` promotion outside this alpha procedure.

## Prepare locally

Preparation does not create a public repository, push source, reserve a package
name, stage a package, or publish anything. Those are launch actions requiring the
maintainer's explicit launch instruction.

```bash
npm ci
npm run release:prepare
```

Inspect `artifacts/release/0.1.0-alpha.1/` (substitute the release version for later
alphas). It contains:

- `diffglow-0.1.0-alpha.1.tgz` and `SHA256SUMS`.
- `package-report.json`, `public-audit.json`, `dependency-licenses.json`,
  `release-manifest.json`, and `validation.log`.
- `RELEASE_NOTES.md`, `ANNOUNCEMENT.md`, and `screenshots/` with the original
  before/after/highlighted images and demo.

The manifest records which environment was actually verified. Local preparation
does not assert that the hosted matrix has passed. Review the actual tarball,
rather than relying on source files alone. It must contain compiled CLI code,
metadata, README, license/notices,
and the selected demo image, without research, credentials, source maps containing
private paths, development tooling, or extra captures.

Review the public Git tree as well. Preserve local research while ensuring it and
its raw evidence never enter public history. Confirm README links, dependency
licenses, CLI help/version, and version metadata. Record the reviewed commit and
tarball checksum. Package comparison logic stays internal; the supported interface
is the CLI.

A local run only validates that operating system and Node.js version. The release
is not ready for npm approval until the six hosted Linux/macOS/Windows × Node.js
22/24 package-verification jobs pass against the intended commit. The first hosted
checks may run after the authorized public repository creation, before npm staging.

## First public alpha: one-time bootstrap

Use Node.js 24 and npm 12.2.0 for the release procedure. Authenticate interactively
with the intended npm maintainer account and enable 2FA. Do not put authentication
tokens or one-time codes into scripts, command arguments, issues, or logs.

1. Obtain the explicit launch instruction. Recheck that the npm package and
   GitHub repository names are available or owned by the intended maintainer;
   previous availability checks do not reserve either name.
2. Create the public `M1chaelChen/diffglow` repository from the reviewed source and
   push the reviewed `main` commit. Enable private vulnerability reporting.
   Manually dispatch `release.yml` on `main` with `expected_sha` set to the full
   reviewed commit SHA, `expected_version` set to `0.1.0-alpha.1`, and
   `stage_with_oidc` set to **false**. This prepares one canonical tarball and
   verifies those exact bytes on all six platform/Node combinations without
   staging anything. Resolve every failure before proceeding.
3. Download the workflow's `release-candidate` artifact after all six checks pass.
   Inspect its tarball, checksum, reports, and source commit; use this exact
   candidate for publication, rather than repacking locally. Verify `npm whoami`
   reports the intended account. From the downloaded candidate's directory, stage
   its tarball with interactive authentication:

   ```bash
   npm stage publish ./diffglow-0.1.0-alpha.1.tgz --tag alpha --access public
   ```

   Staging a previously nonexistent package creates a **public `0.0.0-stage`
   placeholder**. Staging is therefore a public launch action even before the
   alpha tarball is approved. A new package must exist before Trusted Publishing
   can be configured. [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
4. Save the returned stage ID. Inspect it and download the staged tarball into a
   separate empty directory:

   ```bash
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

   Compare the downloaded bytes with the reviewed SHA-256 checksum. Inspect package
   name, version, `alpha` tag, access, and file inventory. Reject the stage if any
   check differs; do not approve a replacement without repeating verification.
5. Approve the stage interactively, completing the 2FA prompt:

   ```bash
   npm stage approve <stage-id>
   ```

The local bootstrap does not claim CI provenance. Subsequent CI stages use OIDC and
provenance after the package's trusted publisher is configured.

## Subsequent alphas through GitHub Actions

Use a reviewed version/changelog pull request for each release. Preserve the
`x.y.z-alpha.n` version form and npm `alpha` tag. No publishing runs on ordinary
pushes or pull requests.

Configure an npm Trusted Publisher for the package with these exact values:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Owner | `M1chaelChen` |
| Repository | `diffglow` |
| Workflow filename | `release.yml` |
| GitHub environment | `npm-staging` |
| Permission | Staging only; no direct publishing permission |

Protect the GitHub `npm-staging` environment with maintainer approval and restrict
it to `main`. Do not add an `NPM_TOKEN` secret. The workflow requests a short-lived
OIDC token and stages with provenance. Complete the first trusted stage promptly:
new trusted-publisher configurations expire if unused for two days.
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

Manually dispatch `.github/workflows/release.yml` on `main` with:

- `expected_sha`: the full 40-character reviewed `main` commit SHA.
- `expected_version`: the exact version in that commit, such as `0.1.0-alpha.2`.
- `stage_with_oidc`: **true** to stage after verification, once trust is configured.
  Its default is **false**, which only prepares and verifies the candidate.

The workflow only stages from the canonical public repository. It prepares one
candidate tarball on Ubuntu/Node.js 24, then downloads and verifies those exact
bytes in all six platform/Node combinations. After those checks pass, a dispatch
with `stage_with_oidc: true` stages the original candidate using npm 12.2.0, its
recorded checksum, and the `alpha` tag. A false value leaves the candidate available
for review and manual bootstrap staging without making a registry write.
Inspect and approve the returned stage interactively as above. OIDC does not grant
permission to list,
view, or download staged packages; a maintainer uses their own interactive npm
authentication for those review actions. The workflow never approves stages or
creates release tags automatically.

## Verify publication and announce

Use an empty directory outside the source checkout with fresh package installation
and original example images:

```bash
npm view diffglow@0.1.0-alpha.1 version dist-tags dist.integrity
npx --yes diffglow@0.1.0-alpha.1 --version
npx --yes diffglow@0.1.0-alpha.1 before.png after.png --output highlighted.png
```

Confirm `alpha` resolves to the intended version and inspect the generated image.
Also verify `--help`, the unchanged-image case, error exit `2`, and changed-image
exit `1` with `--fail-on-diff` after writing its output. For later releases,
substitute that release's exact version throughout this verification.

Create the Git tag at the reviewed commit and a GitHub **prerelease** only after
the registry verification succeeds. Attach the release notes, tarball checksum,
and original example results. Recheck repository/npm links, then publish the
approved copy from [launch-announcement.md](launch-announcement.md).

## Recovery

- A failed validation has no publishing side effect; fix it and rerun against the
  new reviewed commit and checksum.
- If staging succeeded but the workflow was interrupted, inspect the pending stage
  interactively. A duplicate-version retry may fail safely; it must not autoapprove
  an earlier stage or silently replace its bytes.
- Reject an incorrect stage with `npm stage reject <stage-id>`, then prepare and
  review the corrected release. Resolve any stale pending stage before retrying.
- If approval succeeded but tagging or announcement failed, verify the existing
  package integrity and finish those steps. Do not republish the same version.
- For a defective published alpha, publish a corrected prerelease and deprecate
  the defective version with a useful upgrade message. If necessary, a maintainer
  can restore `alpha` to the previous verified version with interactive 2FA. Do not
  overwrite versions or use unpublishing as routine recovery.
