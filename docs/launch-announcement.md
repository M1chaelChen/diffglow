# Diffglow alpha announcement draft

Publication status: draft. Publish only after the launch checks in
[releasing.md](releasing.md) pass.

---

Diffglow is an open-source CLI for comparing two screenshots. It highlights changed
pixels directly over the second image, keeping unchanged areas in their original
colors.

```bash
npx --yes diffglow@alpha before.png after.png --output highlighted.png
```

The first alpha supports PNG and JPEG, highlights added and removed image areas,
and offers `--fail-on-diff` for CI checks. Processing happens locally without
screenshot uploads or telemetry. It works with screenshot files from web and
mobile applications.

![Diffglow before, after, and highlighted comparison](demo.png)

Diffglow compares existing files; use your preferred screenshot tools to capture
them. The alpha is intentionally small, with a documented command-line interface
and Apache-2.0 source.

Try the [npm alpha](https://www.npmjs.com/package/diffglow), browse the
[source and examples](https://github.com/M1chaelChen/diffglow), or share a minimal
reproduction through [GitHub issues](https://github.com/M1chaelChen/diffglow/issues).

---

Before posting, verify the package/repository links and attach the original demo
image. Do not claim device capture, agent integrations, baseline management, or
hosted services. A short terminal recording may show the command, printed result,
and highlighted image; use project-owned fixtures only.
