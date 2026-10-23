# Contributing to Diffglow

Diffglow is a local screenshot comparison CLI. Keep changes small and describe the
visible behavior they improve. Discuss larger features in an issue before
implementing them.

## Development

Use Node.js 22 or 24 and npm:

```bash
git clone https://github.com/M1chaelChen/diffglow.git
cd diffglow
npm ci
npm run verify
```

Run the CLI from source:

```bash
npm run diff -- examples/before.png examples/after.png --output diff.png
```

Build and run the compiled CLI:

```bash
npm run build
node dist/cli.js --help
```

`npm run verify` checks types, tests, the compiled package, and installation into a
clean consumer without development dependencies. CI repeats package verification
on Linux, macOS, and Windows using Node.js 22 and 24. A local run only verifies the
current environment.

## Examples

```bash
npm run example
npm run examples:verify
```

The first command regenerates the original before/after/highlighted fixture. The
second checks included browser screenshots, including JPEG input and page growth
and removal, without installing or starting a browser.

The optional `examples/gallery/capture.mjs` uses an existing Playwright installation
and Chromium to recapture controlled HTML fixtures. Set `PLAYWRIGHT_MODULE` if that
installation lives elsewhere. Capture tooling is for fixture generation and is
not part of the CLI.

## Pull requests

- Explain the problem, resulting behavior, and verification performed.
- Add focused coverage when changing comparison behavior, argument handling, or
  file safety. Use small original fixtures with predictable pixels.
- Preserve exit codes: `0` for success, `1` only for differences requested by
  `--fail-on-diff`, and `2` for errors.
- Do not add private screenshots, credentials, machine-specific paths, generated
  release bundles, or research evidence. Existing local research stays excluded.
- Do not skip all overwrite-protection checks when Windows symlink privileges are
  unavailable. Ordinary paths and hard links must still be tested.

The supported interface is the CLI. The comparison implementation is internal and
is not a supported library import. Dependency changes must update the lockfile and
third-party license inventory.

## Releases

Run `npm run release:prepare` to prepare a local review bundle. Publication is a
separate maintainer action. For a hosted release candidate, the manually dispatched
`release.yml` workflow defaults to preparation and verification only
(`publish_to_npm: false`). It tests the same canonical tarball across all six
platform/Node combinations. Publishing requires `publish_to_npm: true` and approval
of the protected `npm-publish` environment. OIDC publication is followed by a fresh
registry installation and a GitHub release (a prerelease for alpha versions); no
stored npm token is needed. Stable versions publish to `latest`; explicit
`x.y.z-alpha.n` versions publish to `alpha`.
See [the release procedure](docs/releasing.md) for setup, approval, and retry steps.
