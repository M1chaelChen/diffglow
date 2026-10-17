# Diffglow

Compare two screenshots and highlight changes directly over the second image.
Unchanged areas keep their original colors; changed pixels receive a bright,
65% magenta overlay. Images stay on your machine.

![Before, after, and highlighted screenshot comparison](./docs/demo.png)

## Quick start

Requires Node.js 22 or newer. The alpha targets Linux, macOS, and Windows, with CI
coverage configured for Node.js 22 and 24.

```bash
npx --yes diffglow@alpha before.png after.png --output highlighted.png
```

Or install the command:

```bash
npm install --global diffglow@alpha
diffglow before.png after.png --output highlighted.png
```

PNG and JPEG inputs can be mixed. Quote paths containing spaces:

```bash
diffglow "before screenshot.png" "after screenshot.jpg" -o "my diff.png"
```

The command prints the changed-pixel count, changed percentage, and absolute
output path. The default output is `diff.png` in the current directory. Output is
always PNG; missing parent directories are created. An existing result can be
replaced, but neither input can be overwritten, including through a symbolic link
or hard link.

## Options

| Option | Behavior |
| --- | --- |
| `-o, --output <path>` | Output `.png` path; defaults to `diff.png`. |
| `--threshold <0..1>` | Per-pixel color tolerance; defaults to `0.1`. Lower is more sensitive. |
| `--fail-on-diff` | Exit `1` when changes exist, after saving the highlighted PNG. |
| `-h, --help` | Show usage. |
| `-v, --version` | Show the installed version. |

For a more sensitive comparison:

```bash
diffglow before.png after.png --threshold 0 --output sensitive.png
```

The threshold controls color differences at individual pixels, rather than an
allowed percentage of changes. Detected anti-aliasing differences are ignored,
including at threshold `0`, to reduce text-edge noise. Diffglow compares visual
pixels rather than file bytes. JPEG compression can introduce visual differences.

## Image behavior

- EXIF orientation and color space are normalized to sRGB before comparison.
  Transparency is preserved and compared using pixelmatch's transparency handling.
- Images align at the top-left without resizing. Output dimensions use the larger
  width and height of the two inputs.
- Added and removed areas always count as changes, regardless of threshold.
  Removed content from the first screenshot remains visible under the magenta tint.
- The changed percentage is changed pixels divided by the union of both image
  areas. Parts of the output canvas covered by neither input stay transparent and
  are excluded from that percentage.
- Each decoded input and the combined output canvas are limited to 25 million
  pixels. Animated and multi-page images are rejected.

Diffglow accepts screenshots from websites, mobile browsers, or native mobile
applications as image files. This alpha provides image comparison only; your
existing tools supply the screenshots. It does not capture screens, manage
baselines, or provide a JavaScript library API.

Image processing runs locally, without screenshot uploads or telemetry. npm may
access the network to install the package and its dependencies.

## Exit codes and CI

| Code | Meaning |
| --- | --- |
| `0` | Output written successfully, or help/version displayed. |
| `1` | Changes found with `--fail-on-diff`; the output was still written. |
| `2` | Invalid arguments, unreadable/unsupported image, or processing/output error. |

By default, a successful comparison exits `0` even when changes exist:

```bash
diffglow before.png after.png -o highlighted.png
```

To fail a CI check when changes exist:

```bash
diffglow before.png after.png -o artifacts/diff.png --fail-on-diff
```

In a GitHub Actions job with Node.js installed and both screenshots already
available, add these steps. The artifact upload runs even when differences fail
the comparison:

```yaml
- name: Compare screenshots
  run: npx --yes diffglow@0.1.0-alpha.1 before.png after.png --output artifacts/diff.png --fail-on-diff

- name: Upload highlighted comparison
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: visual-diff
    path: artifacts/diff.png
    if-no-files-found: warn
```

Pin an exact package version in CI for repeatable runs. Supply a previous or
approved screenshot through your own workflow.

## Examples and contributing

See the [browser screenshot examples](https://github.com/M1chaelChen/diffglow/tree/main/examples/gallery)
for layout shifts, missing images, mobile viewport clipping, and page-size changes.
The mobile example is a browser fixture rather than a device capture.

Development instructions are in [CONTRIBUTING](https://github.com/M1chaelChen/diffglow/blob/main/CONTRIBUTING.md).
Report bugs through [GitHub issues](https://github.com/M1chaelChen/diffglow/issues).
For security concerns, follow the [security policy](https://github.com/M1chaelChen/diffglow/blob/main/SECURITY.md).

Diffglow is licensed under [Apache-2.0](./LICENSE). Third-party dependencies retain
their own licenses; see [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES.md).
