/**
 * Reading, atomically writing and cleaning .comp packages.
 *
 * The write path follows the rule the Compositor docs prescribe for editing
 * a project while it is open: PNGs land in images/ first (the agent's job),
 * then the manifest is written to a temporary file inside the package and
 * renamed over manifest.json — a rename is atomic, so the open app only ever
 * sees a complete manifest.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveCompPath } from './comp-paths.mjs'

const MANIFEST_READ_LIMIT = 128 * 1024

export { resolveCompPath }

export function newLayerId() {
  return randomUUID().toUpperCase()
}

export async function readManifest(target) {
  const text = await readFile(target.manifestPath, 'utf8')
  return { manifest: JSON.parse(text), text, bytes: Buffer.byteLength(text) }
}

function layerOneLiner(layer, index) {
  const bits = [`#${index}`]
  if (layer.isGroup === true) bits.push('group')
  if (layer.adjustment) bits.push(`adjustment:${layer.adjustment.kind ?? '?'}`)
  if (layer.text) bits.push('text')
  bits.push(layer.name ?? layer.id)
  if (layer.isVisible === false) bits.push('hidden')
  if (typeof layer.opacity === 'number' && layer.opacity !== 1) bits.push(`opacity ${layer.opacity}`)
  if (layer.blendMode && layer.blendMode !== 'Normal') bits.push(layer.blendMode)
  if (layer.parentID) bits.push(`in ${layer.parentID}`)
  if (layer.maskFile) bits.push('masked')
  if (layer.maskSourceID) bits.push(`clips ${layer.maskSourceID}`)
  const transform = layer.transform
  if (transform?.size) bits.push(`at ${transform.origin ?? [0, 0]} size ${transform.size}`)
  if (layer.imageFile) bits.push(layer.imageFile)
  return bits.join(' | ')
}

/** Summarize a manifest for token-efficient reading; full only when small. */
export function summarizeManifest(manifest, text, { layerIndex = null } = {}) {
  const layers = Array.isArray(manifest.layers) ? manifest.layers : []
  if (layerIndex !== null) {
    const layer = layers[layerIndex]
    return { layer: layer ?? null, layerCount: layers.length }
  }
  const full = text.length <= MANIFEST_READ_LIMIT
  return {
    canvas: { width: manifest.width, height: manifest.height, resolution: manifest.resolution, colorSpace: manifest.colorSpace },
    version: manifest.version,
    documentID: manifest.documentID,
    activeLayerID: manifest.activeLayerID ?? null,
    layerCount: layers.length,
    guides: Array.isArray(manifest.guides) ? manifest.guides.length : 0,
    stack: 'bottom to top — layers[0] paints first, the last layer paints on top',
    layerLines: layers.map((layer, index) => layerOneLiner(layer, index)),
    ...(full ? { manifest } : { note: `manifest is ${text.length} bytes; ask with layerIndex for one layer's full record` }),
  }
}

/**
 * Fill in what an agent usually forgets, without changing intent:
 * missing layer ids get fresh UUIDs; imageFile/maskFile are normalized to
 * `<id>.png` / `<id>.mask.png`; a few top-level defaults are added when absent.
 * Returns { manifest, fixes: [...] }.
 */
export function autoFixManifest(manifest, { fixIds = true, fixFilenames = true, defaultVersion = 11 } = {}) {
  const fixes = []
  const out = structuredClone(manifest)
  if (out.format === undefined) { out.format = 'com.compositor.project'; fixes.push('set format = "com.compositor.project"') }
  if (out.version === undefined) { out.version = defaultVersion; fixes.push(`set version = ${defaultVersion} (newest conservative version; raise it only for 16-bit/EXR layers)`) }
  if (out.colorSpace === undefined) { out.colorSpace = 'sRGB'; fixes.push('set colorSpace = "sRGB"') }
  if (out.resolution === undefined) { out.resolution = 72; fixes.push('set resolution = 72') }
  if (!Array.isArray(out.layers)) out.layers = []
  for (const layer of out.layers) {
    if (!layer || typeof layer !== 'object') continue
    if (fixIds && !layer.id) {
      layer.id = newLayerId()
      fixes.push(`gave layer "${layer.name ?? '(unnamed)'}" the id ${layer.id}`)
    }
    if (!layer.id) continue
    if (fixFilenames && layer.imageFile !== undefined && layer.imageFile !== `${layer.id}.png` && layer.imageFile !== `${layer.id}.exr`) {
      const extension = /\.(png|exr)$/i.exec(layer.imageFile)?.[1]?.toLowerCase() ?? 'png'
      fixes.push(`layers "${layer.name ?? layer.id}": imageFile "${layer.imageFile}" → "${layer.id}.${extension}" — image files must be named after their layer id`)
      layer.imageFile = `${layer.id}.${extension}`
    }
    if (fixFilenames && layer.maskFile !== undefined && layer.maskFile !== `${layer.id}.mask.png`) {
      fixes.push(`layer "${layer.name ?? layer.id}": maskFile "${layer.maskFile}" → "${layer.id}.mask.png"`)
      layer.maskFile = `${layer.id}.mask.png`
    }
  }
  if (out.activeLayerID === undefined && out.layers.length) {
    out.activeLayerID = out.layers[out.layers.length - 1]?.id ?? null
    if (out.activeLayerID) fixes.push(`set activeLayerID = ${out.activeLayerID} (top layer)`)
  }
  return { manifest: out, fixes }
}

/**
 * Write the manifest atomically: temp file inside the package, then rename.
 * `docs`-validated manifests only — pass skipValidation to override.
 */
export async function writeManifestAtomic(target, manifest, { validate, tempPrefix = '.manifest' } = {}) {
  const text = JSON.stringify(manifest, null, 2) + '\n'
  const tempPath = join(target.compDir, `${tempPrefix}.json.tmp-${process.pid}-${Date.now()}`)
  await mkdir(target.imagesDir, { recursive: true })
  await writeFile(tempPath, text, 'utf8')
  // prove the round-trip parses before swapping it in
  JSON.parse(await readFile(tempPath, 'utf8'))
  await rename(tempPath, target.manifestPath)
  return { manifestPath: target.manifestPath, bytes: Buffer.byteLength(text) }
}

/**
 * Remove what the project no longer needs: image files in images/ the
 * manifest does not reference, and the QuickLook folder (the docs ask for
 * this after every change so Finder does not preview a stale picture).
 */
export async function cleanPackage(target, manifest, { apply = false } = {}) {
  const referenced = new Set()
  for (const layer of Array.isArray(manifest.layers) ? manifest.layers : []) {
    if (typeof layer?.imageFile === 'string') referenced.add(layer.imageFile)
    if (typeof layer?.maskFile === 'string') referenced.add(layer.maskFile)
  }
  const unusedImages = []
  const entries = await readdir(target.imagesDir).catch(() => [])
  for (const name of entries) {
    if (referenced.has(name) || !/\.(png|exr)$/i.test(name)) continue
    const fileStat = await stat(join(target.imagesDir, name)).catch(() => null)
    if (fileStat?.isFile()) unusedImages.push({ name, bytes: fileStat.size })
  }
  const quickLook = await stat(join(target.compDir, 'QuickLook')).catch(() => null)
  const hasQuickLook = quickLook?.isDirectory() === true
  const result = { unusedImages, quickLook: hasQuickLook, applied: apply, removed: [] }
  if (apply) {
    for (const image of unusedImages) {
      await rm(join(target.imagesDir, image.name), { force: true })
      result.removed.push(`images/${image.name}`)
    }
    if (hasQuickLook) {
      await rm(join(target.compDir, 'QuickLook'), { recursive: true, force: true })
      result.removed.push('QuickLook/')
    }
  }
  return result
}
