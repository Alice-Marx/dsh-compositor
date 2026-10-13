# @ljwei-stak/dsh-compositor

English | [中文](README.zh.md)

A DeepSeek Harness (DSH Desktop / dsh CLI) plugin that lets Harness agents build and edit [Compositor](https://github.com/robbietilton/Compositor) image projects (`.comp`) directly.

Compositor is an open-source macOS image editor; a `.comp` project is a folder of PNG layers plus a `manifest.json` that anything which can write files — including AI agents — can construct, with the open canvas refreshing live as files change. This plugin hands that workflow to Harness agents and **freezes no format knowledge**: every format rule is parsed at runtime from your locally synced Compositor git checkout, so after upstream updates, a `git pull` is all it takes.

## Why a `git pull` is enough (compatibility design)

- **Docs are the source of truth**: the blend-mode list, adjustment kinds, max manifest version and all numeric limits are parsed live from the checkout's `docs/writing-comp-files.md` / `docs/project-format.md`, with a built-in fallback copy used only when parsing fails (and every value reports whether it came from `docs` or `fallback`).
- **Forward compatible**: a manifest version newer than the checkout's docs (upstream shipped, you haven't pulled) automatically downgrades every version-gated check to a warning — a legitimate new-format project is never blocked.
- **Additive fields ignored**: the format's history (v1–13) is purely additive; the validator only enforces rules the docs state and lets unknown new fields through.
- **Cache invalidates by mtime**: the doc cache re-reads immediately after a pull.

## Agent tools (8)

| Tool | Purpose |
|---|---|
| `compositor_repo` | Checkout status: git commit, doc parse results, blend modes / adjustment kinds / max version / limits |
| `compositor_docs` | Read the format docs verbatim from the checkout (writing / format / both) |
| `compositor_validate` | Full package validation per the docs: naming rules, blend-mode spellings, group tree (cycles/depth/contiguity), clipping chains, adjustment ranges, version gates, image formats, package limits, unreferenced files |
| `compositor_manifest` | Token-efficient manifest read (one line per layer; full object when small; layerIndex for one record) |
| `compositor_write_manifest` | Safe writes: auto layer ids (UUIDs), filename normalization, validate-then-**atomic write** (temp + rename, so a watching Compositor never sees half a manifest); refuses to write on validation failure |
| `compositor_layer_png` | Generate layer/mask PNGs (solid, linear/radial gradients) named exactly `<id>.png` / `<id>.mask.png`; pure Node, no native deps |
| `compositor_preview` | No Mac needed: flatten the stack to a PNG (transforms, opacity, layer/folder masks, clipping masks, all 24 blend modes); adjustment layers and effects are not rendered and are listed in `skipped`. Needs the optional sharp package |
| `compositor_clean` | Delete unreferenced images and the stale QuickLook folder (the docs ask for this after every change); dry-run by default |

## Using it

There is no panel to open — the tools belong to the agent. Just ask in a DSH conversation, for example:

> Read compositor_docs, then create a 1920×1080 `.comp` project with a neon night skyline, and show me a preview.

The agent reads the docs, generates layer PNGs, writes the manifest atomically, and renders a preview you can check without a Mac. Whoever has the project open in Compositor sees the canvas refresh within ~0.3s.

## Install

From npm, in the DSH Desktop plugin manager, or for any non-desktop profile:

```sh
dsh plugin --profile <name> add @ljwei-stak/dsh-compositor
```

The `desktop` profile is reserved for the Electron app (the CLI rejects plugin management for it), so install there by hand:

```sh
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add @ljwei-stak/dsh-compositor
```

Then add `"@ljwei-stak/dsh-compositor"` to the `dsh.profile.bundles` array in that profile's `package.json` (the profile reloads live; restart DSH Desktop if it doesn't).

Developers installing from source: `npm pack` in the repo, then `pnpm add <path-to-the-tgz>` in the profile directory.

Point the `repoDir` setting at your local clone of the Compositor repository (the default ships with the author's path — change it to yours on first use, e.g. `D:\code\Compositor`).

## Settings

| Key | Default | Meaning |
|---|---|---|
| `repoDir` | author's checkout path | Path to your local Compositor git clone — the single source of format knowledge |
| `agentTools` | `true` | Register the compositor_* tools |
| `previewEnabled` | `true` | Enable compositor_preview |
| `docsMaxChars` | `200000` | Character cap for compositor_docs |

When sharp is missing, `compositor_preview` says so clearly; every other tool works with zero dependencies.

## Development

```sh
npm test        # node --test tests/
```

Plugin code is MIT. The `.comp` format knowledge belongs to the Compositor repository (MIT, Robbie Tilton); this plugin reads it at runtime and does not redistribute it.

## License

MIT — see [LICENSE](LICENSE).
