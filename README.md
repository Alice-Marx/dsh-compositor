# @ljwei-stak/dsh-compositor

A DeepSeek Harness (DSH Desktop / dsh CLI) plugin that lets Harness agents build and edit [Compositor](https://github.com/robbietilton/Compositor) image projects (`.comp`) directly.

Compositor is an open-source macOS image editor; a `.comp` project is a folder of PNG layers plus a `manifest.json` that anything which can write files — including AI agents — can construct, with the open canvas refreshing live as files change. This plugin hands that workflow to Harness agents and **freezes no format knowledge**: every format rule is parsed at runtime from the locally synced Compositor git checkout, so after upstream updates, a `git pull` is all it takes.

## Why a `git pull` is enough (compatibility design)

- **Docs are the source of truth**: the blend-mode list, adjustment kinds, max manifest version and all numeric limits are parsed live from `docs/writing-comp-files.md` / `docs/project-format.md` in the checkout, with a built-in fallback copy used only when parsing fails (and every value reports whether it came from `docs` or `fallback`).
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

## Install

### From a local pack

```sh
cd F:\everyAI\dsh-Compositor\dsh-compositor
npm pack --pack-destination dist
```

The `desktop` profile is reserved for the Electron app (the CLI rejects plugin management for it), so install by hand:

```sh
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add F:\everyAI\dsh-Compositor\dsh-compositor\dist\ljwei-stak-dsh-compositor-0.1.0.tgz
```

Then add `"@ljwei-stak/dsh-compositor"` to the `dsh.profile.bundles` array in `%USERPROFILE%\.dsh\profiles\desktop\package.json` (the profile runs `patchReload: live`, so it hot-reloads; restart DSH Desktop if not).

### After publishing to npm

Install from the DSH Desktop plugin manager, or for non-desktop profiles:

```sh
dsh plugin --profile <name> add @ljwei-stak/dsh-compositor
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| `repoDir` | `F:\everyAI\dsh-Compositor\Compositor` | Local Compositor git checkout (the single source of format knowledge) |
| `agentTools` | `true` | Register the compositor_* tools |
| `previewEnabled` | `true` | Enable compositor_preview |
| `docsMaxChars` | `200000` | Character cap for compositor_docs |

When sharp is missing, `compositor_preview` says so clearly; every other tool works with zero dependencies.

## The agent workflow (also written into the tool descriptions)

1. Read `compositor_docs` (file=writing) once;
2. `compositor_layer_png` for flat/gradient layers and masks (painterly content: generate PNGs with your own image tools and drop them into `images/`);
3. `compositor_write_manifest` for the atomic manifest write (refused when validation fails);
4. `compositor_preview` to eyeball the result, `compositor_validate` to confirm;
5. Whoever has the project open in Compositor on a Mac sees the canvas refresh within ~0.3s.

## Development

```sh
npm test        # node --test tests/
```

Plugin code is MIT. The `.comp` format knowledge belongs to the Compositor repository (MIT, Robbie Tilton); this plugin reads it at runtime and does not redistribute it.

## License

MIT — see [LICENSE](LICENSE).
