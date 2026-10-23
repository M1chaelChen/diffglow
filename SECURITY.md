# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/M1chaelChen/diffglow/security/advisories/new)
for security issues. Include the Diffglow version, operating system, Node.js
version, reproduction command, and a minimal synthetic image when relevant.

Do not include credentials or customer screenshots in public issues. If private
reporting is temporarily unavailable, open a public issue asking for a private
reporting channel without disclosing vulnerability details.

## Supported versions

Security fixes target the latest stable release. Update to the newest stable
version when a fix is published; the project does not maintain older release
branches. Prereleases receive fixes through a subsequent prerelease or stable
release.

## Local image handling

Diffglow reads input images and writes the requested output locally. It does not
upload screenshots or send telemetry. Image decoding uses Sharp and its native
dependencies. Malformed or excessive images may be rejected during processing;
each input and the output canvas are limited to 25 million pixels.

Output paths are checked against both inputs, including aliases and hard links.
Run the CLI with only the filesystem permissions needed for the files you intend
to compare, particularly when processing files supplied by someone else.
