# Changelog

## 0.1.1 (2026-10-13)

- READMEs (English + Chinese) no longer contain machine-specific paths; added a language switcher linking the two, a usage section (the plugin is agent-tools-only, no panel) and generic install instructions including `dsh plugin` and source packs.

## 0.1.0 (2026-10-13)

Initial release.

- Live format knowledge: blend modes, adjustment kinds, max manifest version and limits parsed at runtime from the synced Compositor checkout's docs, with built-in fallbacks; cache invalidates by mtime so `git pull` is enough to follow upstream.
- Forward-compatible validator: version-gated checks downgrade to warnings for manifests newer than the checkout docs; unknown additive fields pass.
- 8 agent tools: `compositor_repo`, `compositor_docs`, `compositor_validate`, `compositor_manifest`, `compositor_write_manifest` (validate-first, atomic temp+rename write, works on brand-new projects), `compositor_layer_png` (pure-Node solid/gradient layer and mask PNGs), `compositor_preview` (optional sharp; transforms, opacity, masks, clipping, all 24 blend modes; adjustments/effects reported as skipped), `compositor_clean` (unreferenced images + stale QuickLook, dry-run by default).
- 41 unit tests including live parsing against the real checkout and an end-to-end fresh-project flow.
