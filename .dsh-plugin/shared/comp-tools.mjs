/**
 * Agent tool definitions contributed to Harness while the plugin is loaded
 * (only when the host provides the `tools` service). Plain objects in the
 * shape the tool registry accepts; no writes outside .comp packages and the
 * configured checkout, no network, no subprocesses.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { loadRepoDocs, publicDocs } from './comp-docs.mjs'
import { resolveCompPath, readGitState } from './comp-paths.mjs'
import { cleanPackage, autoFixManifest, newLayerId, readManifest, summarizeManifest, writeManifestAtomic } from './comp-project.mjs'
import { encodePngGray, encodePngRgba, generateGrayPixels, generatePixels } from './comp-png.mjs'
import { validateComp } from './comp-validate.mjs'
import { renderPreview } from './comp-preview.mjs'

const JSON_OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }] }
const pathParam = { type: 'string', description: 'Absolute path of the .comp folder (or its manifest.json).' }

function asObject(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function textArg(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function guardExecute(run) {
  try {
    return await run()
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** A .comp folder that may not have a manifest yet (brand-new project). */
async function resolvePackageDir(input) {
  const path = resolve(textArg(input) ?? '')
  if (!path) throw new Error('path is required')
  return { compDir: basename(path).toLowerCase() === 'manifest.json' ? resolve(path, '..') : path }
}

function docGuide(repoInfo) {
  return [
    `The Compositor checkout used as the source of truth: ${repoInfo.repoDir}`,
    repoInfo.git?.commit ? `git ${repoInfo.git.commit}${repoInfo.git.branch ? ` (${repoInfo.git.branch})` : ''}${repoInfo.git.subject ? ` — ${repoInfo.git.subject}` : ''}` : 'not a git checkout (no .git found)',
    'Ask the user to run `git pull` there when they want the newest upstream format changes.',
  ].join('\n')
}

export function buildCompositorTools({ config } = {}) {
  const repoDir = () => config.repoDir?.trim() || 'F:\\everyAI\\dsh-Compositor\\Compositor'
  const maxChars = () => Number(config.docsMaxChars) > 0 ? Number(config.docsMaxChars) : 200_000

  return [
    {
      name: 'compositor_repo',
      description:
        'Report the local Compositor (github.com/robbietilton/Compositor) checkout this plugin reads its format knowledge from: git commit, which docs were found, the parsed blend-mode list, adjustment kinds, max manifest version and package limits. Compositor is a macOS image editor whose .comp projects are folders of PNG layers plus manifest.json; this plugin follows the synced checkout, so its knowledge matches whatever version the user pulled. Use this first to see how fresh the checkout is.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_OUTPUT,
      timeoutMs: 10_000,
      async execute() {
        return guardExecute(async () => {
          const docs = await loadRepoDocs(repoDir())
          const info = publicDocs(docs)
          return { ok: true, ...info, guide: docGuide(info) }
        })
      },
    },
    {
      name: 'compositor_docs',
      description:
        "Read the .comp format documentation straight from the synced Compositor checkout (never a frozen copy): file 'writing' = docs/writing-comp-files.md (how to build/edit projects: package layout, naming rules, atomic writes, masks, adjustment layers), file 'format' = docs/project-format.md (the full version history 1–13, groups, text, effects, guides, limits). Read 'writing' before creating your first .comp project.",
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          file: { type: 'string', enum: ['writing', 'format', 'both'], description: "Which doc to return (default 'writing')." },
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 10_000,
      async execute(args) {
        return guardExecute(async () => {
          const file = asObject(args).file ?? 'writing'
          const docs = await loadRepoDocs(repoDir())
          const pick = {}
          if (file === 'writing' || file === 'both') pick.writing = docs.texts.writing
          if (file === 'format' || file === 'both') pick.format = docs.texts.format
          const limit = maxChars()
          let total = Object.values(pick).reduce((sum, text) => sum + (text?.length ?? 0), 0)
          const truncated = total > limit
          if (truncated) for (const key of Object.keys(pick)) pick[key] = (pick[key] ?? '').slice(0, Math.floor(limit / Object.keys(pick).length))
          return {
            ok: true,
            repo: { dir: docs.repoDir, git: docs.git },
            vocab: { blendModes: docs.vocab.blendModes, adjustmentKinds: docs.vocab.adjustmentKinds, maxVersion: docs.vocab.maxVersion, limits: docs.vocab.limits },
            docs: pick,
            ...(truncated ? { truncated: true, note: `text capped at ${limit} chars — read the file directly for the rest` } : {}),
          }
        })
      },
    },
    {
      name: 'compositor_validate',
      description:
        'Validate a .comp package the way Compositor will judge it: manifest JSON, layer/file naming (<layer id>.png, <layer id>.mask.png), exact blend-mode spellings, group tree (cycles, depth, contiguity), clipping-mask chains, adjustment settings and numeric ranges, version gates, image formats (RGBA PNG, 8-bit gray masks, 16-bit needs v12, EXR needs v13), package limits, unreferenced images. The app refuses a broken file silently — the canvas just does not update — so validate before and after every write. A manifest newer than the checkout docs only produces warnings (forward compatible).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: { path: pathParam },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      async execute(args) {
        return guardExecute(async () => {
          const target = await resolveCompPath(asObject(args).path)
          const docs = await loadRepoDocs(repoDir())
          const result = await validateComp(target, docs)
          return { ok: result.ok, ...result }
        })
      },
    },
    {
      name: 'compositor_manifest',
      description:
        'Read a .comp manifest without dumping megabytes: canvas size, version, and one line per layer (kind, name, visibility, opacity, blend, group, transform, files) bottom-to-top. Returns the full manifest object only when it is small; pass layerIndex to get one layer record verbatim. Use this to plan edits; edit by calling compositor_write_manifest with the updated object.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: pathParam,
          layerIndex: { type: 'integer', description: 'Return just this layer record (0-based, bottom of the stack).' },
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 15_000,
      async execute(args) {
        return guardExecute(async () => {
          const value = asObject(args)
          const target = await resolveCompPath(value.path)
          const { manifest, text } = await readManifest(target)
          return { ok: true, manifestPath: target.manifestPath, ...summarizeManifest(manifest, text, { layerIndex: Number.isInteger(value.layerIndex) ? value.layerIndex : null }) }
        })
      },
    },
    {
      name: 'compositor_write_manifest',
      description:
        'Write a .comp manifest the safe way: fills in missing layer ids (fresh UUIDs) and normalizes imageFile/maskFile to <id>.png/<id>.mask.png, validates the result against the package, and only then writes it atomically (temp file + rename) so the open Compositor app never sees a half-written manifest. Works on a brand-new folder (no manifest yet) as well as an existing project. Write order for a project being watched: PNGs into images/ FIRST (compositor_layer_png), then this call. Refuses to write when validation fails and returns the problems. removeUnused also deletes images no longer referenced plus the stale QuickLook folder.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'manifest'],
        properties: {
          path: pathParam,
          manifest: { type: 'object', description: 'The complete manifest object to write (layers bottom-to-top).' },
          fixIds: { type: 'boolean', description: 'Generate UUIDs for layers without ids (default true).' },
          fixFilenames: { type: 'boolean', description: 'Normalize imageFile/maskFile naming (default true).' },
          removeUnused: { type: 'boolean', description: 'Also delete unreferenced images and QuickLook/ (default false).' },
          skipValidation: { type: 'boolean', description: 'Write even when validation fails (default false — avoid).' },
          defaultVersion: { type: 'integer', description: 'Version used when the manifest has none (default 11).' },
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute(args, exec) {
        return guardExecute(async () => {
          const value = asObject(args)
          if (!value.manifest || typeof value.manifest !== 'object') return { ok: false, error: 'manifest object is required' }
          const { compDir } = await resolvePackageDir(value.path)
          const docs = await loadRepoDocs(repoDir())
          const { manifest, fixes } = autoFixManifest(value.manifest, {
            fixIds: value.fixIds !== false,
            fixFilenames: value.fixFilenames !== false,
            defaultVersion: Number.isInteger(value.defaultVersion) ? value.defaultVersion : 11,
          })
          // Validate the new manifest as it would sit on disk: stage it in a
          // temp file inside the package (invisible to the watching app,
          // which only reloads manifest.json), run the full validator, remove.
          const imagesDir = join(compDir, 'images')
          await mkdir(imagesDir, { recursive: true })
          const stagingPath = join(compDir, `.manifest.check.${process.pid}.${Date.now()}.json.tmp`)
          await writeFile(stagingPath, JSON.stringify(manifest, null, 2))
          let validation
          try {
            validation = await validateComp({ compDir, manifestPath: stagingPath, imagesDir }, docs)
          } finally {
            await rm(stagingPath, { force: true })
          }
          if (!validation.ok && value.skipValidation !== true) {
            return { ok: false, written: false, fixes, validation, note: 'nothing was written; fix the problems or pass skipValidation: true deliberately' }
          }
          const target = { compDir, manifestPath: join(compDir, 'manifest.json'), imagesDir }
          await writeManifestAtomic(target, manifest)
          let cleaned = null
          if (value.removeUnused === true) cleaned = await cleanPackage(target, manifest, { apply: true })
          return { ok: true, written: true, manifestPath: target.manifestPath, fixes, validation, cleaned }
        })
      },
    },
    {
      name: 'compositor_layer_png',
      description:
        'Create a layer image or mask PNG inside a .comp package, named exactly <id>.png or <id>.mask.png as the format requires: solid colors, linear gradients (angle in degrees) or radial gradients, any size. kind "image" writes 8-bit RGBA (colors are [r,g,b,(a)] 0–255 or #rrggbb); kind "mask" writes 8-bit grayscale (from/to are gray levels 0–255; white reveals, black hides). Returns the id and filename to reference in the manifest. For anything painterly, generate the PNG with your own image tools instead — this tool is for flat fills, gradients and masks.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path', 'width', 'height'],
        properties: {
          path: { type: 'string', description: 'Absolute path of the .comp folder (created if missing, manifest not required yet).' },
          id: { type: 'string', description: 'Existing layer id to name the file after; a fresh uppercase UUID is generated when omitted.' },
          kind: { type: 'string', enum: ['image', 'mask'], description: 'Layer image (RGBA) or mask (grayscale); default image.' },
          width: { type: 'integer', description: 'Pixel width.' },
          height: { type: 'integer', description: 'Pixel height.' },
          mode: { type: 'string', enum: ['solid', 'linear', 'radial'], description: 'Fill mode (default solid).' },
          color: { type: 'object', description: 'Solid color: [r,g,b,(a)] 0–255 or "#rrggbb".' },
          from: { type: 'object', description: 'Gradient start (color array, or gray level for masks).' },
          to: { type: 'object', description: 'Gradient end.' },
          angle: { type: 'number', description: 'Linear gradient angle in degrees (0 = rightwards, 90 = downwards); default 90.' },
          center: { type: 'array', description: 'Radial center [x, y]; default the middle.' },
          radius: { type: 'number', description: 'Radial radius in pixels; default the farthest corner.' },
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 60_000,
      async execute(args) {
        return guardExecute(async () => {
          const value = asObject(args)
          const width = Number(value.width), height = Number(value.height)
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return { ok: false, error: 'width and height must be positive integers' }
          if (width > 30000 || height > 30000) return { ok: false, error: 'images are limited to 30,000 pixels per side' }
          const { compDir } = await resolvePackageDir(value.path)
          const id = textArg(value.id) ?? newLayerId()
          if (!/^[0-9A-Fa-f-]{36}$/.test(id)) return { ok: false, error: `id "${id}" is not a UUID` }
          const normalizedId = id.toUpperCase()
          const kind = value.kind === 'mask' ? 'mask' : 'image'
          const options = {
            width, height,
            mode: ['solid', 'linear', 'radial'].includes(value.mode) ? value.mode : 'solid',
            color: value.color ?? undefined, from: value.from ?? undefined, to: value.to ?? undefined,
            angle: Number(value.angle) || 90, center: Array.isArray(value.center) ? value.center : undefined, radius: Number(value.radius) || undefined,
          }
          const imagesDir = join(compDir, 'images')
          await mkdir(imagesDir, { recursive: true })
          const fileName = kind === 'mask' ? `${normalizedId}.mask.png` : `${normalizedId}.png`
          const buffer = kind === 'mask' ? encodePngGray(width, height, generateGrayPixels(options)) : encodePngRgba(width, height, generatePixels(options))
          const filePath = join(imagesDir, fileName)
          await writeFile(filePath, buffer)
          return { ok: true, id: normalizedId, kind, file: fileName, path: filePath, width, height, bytes: buffer.length, nextStep: `reference it in the manifest as ${kind === 'mask' ? 'maskFile' : 'imageFile'} and write with compositor_write_manifest` }
        })
      },
    },
    {
      name: 'compositor_preview',
      description:
        'Flatten a .comp project to a PNG you can look at without the macOS app: transforms, opacity (folders pass through), raster and folder masks, unlinked maskPlacement, clipping masks and all 24 blend modes, rendered in pure JavaScript from the decoded layer PNGs. Adjustment layers and layer effects are NOT rendered and are listed in "skipped" — treat the result as a layout/compositing check, not a color check. Writes the PNG next to the .comp folder (default <name>.preview.png). Needs the optional sharp package; reports clearly when it is missing.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: pathParam,
          out: { type: 'string', description: 'Output PNG path (default: sibling <compname>.preview.png, outside the package).' },
          maxWidth: { type: 'integer', description: 'Downscale to at most this width (default 1600).' },
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 120_000,
      async execute(args, exec) {
        return guardExecute(async () => {
          const value = asObject(args)
          const target = await resolveCompPath(value.path)
          const { manifest } = await readManifest(target)
          const result = await renderPreview(target, manifest, { maxWidth: Number.isInteger(value.maxWidth) ? value.maxWidth : 1600, signal: exec?.signal })
          if (!result.ok) return result
          const out = textArg(value.out) ?? `${target.compDir}.preview.png`
          await writeFile(out, result.png)
          return { ok: true, out, width: result.width, height: result.height, canvas: result.canvas, skipped: result.skipped, warnings: result.warnings, bytes: result.png.length }
        })
      },
    },
    {
      name: 'compositor_clean',
      description:
        'Remove what a .comp package no longer needs: image files in images/ that the manifest does not reference, and the QuickLook folder (the docs say to delete it after every change so the macOS Finder preview does not go stale). Dry-run by default — it lists what it would remove; pass apply: true to delete.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: pathParam,
          apply: { type: 'boolean', description: 'Actually delete (default false: dry-run).' },
        },
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute(args) {
        return guardExecute(async () => {
          const value = asObject(args)
          const target = await resolveCompPath(value.path)
          const { manifest } = await readManifest(target)
          const result = await cleanPackage(target, manifest, { apply: value.apply === true })
          return { ok: true, ...result, note: value.apply === true ? undefined : 'dry run — pass apply: true to delete' }
        })
      },
    },
  ]
}
