# Third-party notices

Diffglow's original code is licensed under Apache-2.0. This does not relicense
its dependencies. The npm tarball contains Diffglow's JavaScript and notices;
npm installs the external dependencies and platform-specific binaries separately.
Diffglow does not bundle, modify, or statically link these dependencies.

| Runtime package | Version in lockfile | License | Included notice |
| --- | --- | --- | --- |
| pixelmatch | 8.0.0 | ISC | `licenses/pixelmatch-LICENSE` |
| pngjs | 7.0.0 | MIT | `licenses/pngjs-LICENSE` |
| sharp | 0.35.5 | Apache-2.0 | `licenses/sharp-LICENSE` |
| @img/colour | 1.1.0 | MIT | `licenses/img-colour-LICENSE.md` |
| detect-libc | 2.1.2 | Apache-2.0 | `licenses/detect-libc-LICENSE` |
| semver | 7.8.5 | ISC | `licenses/semver-LICENSE` |

The complete lockfile inventory, including optional platform packages, is in
[dependency-licenses.json](https://github.com/M1chaelChen/diffglow/blob/main/docs/dependency-licenses.json).
The lockfile records the reviewed development and CI dependency graph. A normal
consumer installation can resolve newer compatible transitive dependencies.

## Sharp native components

Sharp's native add-ons use Apache-2.0; some packages, including Windows builds,
also declare LGPL-3.0-or-later for the included libvips components. Prebuilt
`@img/sharp-libvips-*` packages declare LGPL-3.0-or-later and contain libraries
under additional licenses, including MIT, BSD, MPL, IJG, and zlib terms.
Wasm packages can include MIT runtime components as well.

The upstream macOS ARM64 licensing table is preserved verbatim in
`licenses/sharp-libvips-darwin-arm64-NOTICES.md` as a reference for that build;
it is not an exhaustive statement for every platform. Consult the README,
license files, and metadata of the actual installed `@img` packages for the
licenses and library versions of that platform. Keep those upstream notices
when redistributing installed dependencies or native binaries.

Upstream sources and build information:

- [Sharp](https://github.com/lovell/sharp) and its [license](https://github.com/lovell/sharp/blob/main/LICENSE).
- [Sharp libvips distributions](https://github.com/lovell/sharp-libvips), including build recipes and source-download information.
- [libvips source and license](https://github.com/libvips/libvips).
- [pixelmatch](https://github.com/mapbox/pixelmatch).

Dependency updates must refresh the inventory and review the installed notices.
Any future bundled binary or container distribution needs its own license and
corresponding-source review; this alpha distributes the npm CLI with external
runtime dependencies.
