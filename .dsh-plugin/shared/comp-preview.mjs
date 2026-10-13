/**
 * Best-effort flattened preview of a .comp project.
 *
 * Decodes layer images with sharp (an optional dependency — when it is not
 * installed the tool reports that instead of failing) and composites the
 * stack in JavaScript: transforms (origin/size/rotation/flips/sampling),
 * opacity with folder pass-through, raster masks, unlinked maskPlacement,
 * folder masks, clipping masks (maskSourceID) and all 24 blend modes.
 * Adjustment layers and layer effects are NOT rendered — they are listed in
 * `skipped` so nobody mistakes the preview for the app's output.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compositePixel } from './comp-blend.mjs'
import { isExrBuffer } from './comp-png.mjs'

const MAX_PLACED_PIXELS = 96_000_000

async function loadSharp() {
  try {
    const module = await import('sharp')
    return module.default ?? module
  } catch {
    return null
  }
}

async function decodeRgba(sharp, buffer) {
  // → { width, height, data: Buffer RGBA 8-bit } or null (unsupported)
  const image = sharp(buffer, { failOn: 'none' }).ensureAlpha().toColourspace('srgb')
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  if (info.channels === 4 && info.depth === 'uchar') return { width: info.width, height: info.height, data }
  // normalize 16-bit or odd channel counts to 8-bit RGBA
  const out = Buffer.alloc(info.width * info.height * 4)
  const depthMax = info.depth === 'ushort' ? 65535 : 255
  for (let p = 0, q = 0; p < info.width * info.height; p++, q += info.channels) {
    out[p * 4] = Math.round((data[q] / depthMax) * 255)
    out[p * 4 + 1] = Math.round((data[q + 1] / depthMax) * 255)
    out[p * 4 + 2] = Math.round((data[q + 2] / depthMax) * 255)
    out[p * 4 + 3] = Math.round(((data[q + 3] ?? 255) / depthMax) * 255)
  }
  return { width: info.width, height: info.height, data: out }
}

function bilinear(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width - 1 || y >= image.height - 1) {
    const px = Math.min(image.width - 1, Math.max(0, Math.round(x)))
    const py = Math.min(image.height - 1, Math.max(0, Math.round(y)))
    const i = (py * image.width + px) * 4
    return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]]
  }
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = x - x0, fy = y - y0
  const at = (px, py) => (py * image.width + px) * 4
  const mix4 = (channel) => {
    const top = image.data[at(x0, y0) + channel] * (1 - fx) + image.data[at(x0 + 1, y0) + channel] * fx
    const bottom = image.data[at(x0, y0 + 1) + channel] * (1 - fx) + image.data[at(x0 + 1, y0 + 1) + channel] * fx
    return top * (1 - fy) + bottom * fy
  }
  return [mix4(0), mix4(1), mix4(2), mix4(3)]
}

function rotatedBounds(transform) {
  const [ox, oy] = transform.origin ?? [0, 0]
  const [w, h] = transform.size
  const theta = ((transform.rotation ?? 0) * Math.PI) / 180
  const cx = ox + w / 2, cy = oy + h / 2
  const cos = Math.abs(Math.cos(theta)), sin = Math.abs(Math.sin(theta))
  const bw = w * cos + h * sin, bh = w * sin + h * cos
  return { x0: Math.floor(cx - bw / 2), y0: Math.floor(cy - bh / 2), x1: Math.ceil(cx + bw / 2), y1: Math.ceil(cy + bh / 2) }
}

/**
 * Sample a mask (grayscale PNG decoded to RGBA; red channel used) at
 * document coordinates through an optional document-space rectangle.
 */
function sampleMask(maskImage, docX, docY, placement) {
  let u = docX, v = docY
  if (placement) {
    const [px, py, pw, ph] = placement
    u = (docX - px) / (pw || 1)
    v = (docY - py) / (ph || 1)
  } else {
    // linked mask: reuse the caller's layer UV
    return null
  }
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0
  const [r] = bilinear(maskImage, u * (maskImage.width - 1), v * (maskImage.height - 1))
  return r
}

/**
 * Render the flattened stack. manifest/target from resolveCompPath + read.
 * Returns { ok, png: Buffer, width, height, skipped: [...], warnings: [...] }
 * or { ok: false, reason }.
 */
export async function renderPreview(target, manifest, { maxWidth = 1600, onlyLayerIds = null, signal } = {}) {
  const sharp = await loadSharp()
  if (!sharp) return { ok: false, reason: 'sharp is not installed in this profile; the preview needs it for PNG decode/encode (pnpm add sharp in the profile, or install the plugin with its optionalDependencies)' }
  const canvasW = manifest.width, canvasH = manifest.height
  if (!Number.isInteger(canvasW) || !Number.isInteger(canvasH) || canvasW <= 0 || canvasH <= 0) return { ok: false, reason: 'manifest.width/height are not usable' }
  const layers = Array.isArray(manifest.layers) ? manifest.layers : []
  const byId = new Map(layers.filter(layer => layer?.id).map(layer => [layer.id, layer]))
  const ancestors = id => {
    const chain = []
    let cursor = byId.get(id)
    const seen = new Set([id])
    while (cursor?.parentID && !seen.has(cursor.parentID)) { seen.add(cursor.parentID); chain.push(byId.get(cursor.parentID)); cursor = byId.get(cursor.parentID) }
    return chain.filter(Boolean)
  }
  const isVisible = layer => {
    if (layer?.isVisible === false) return false
    return ancestors(layer.id).every(group => group.isVisible !== false)
  }
  const groupOpacity = layer => ancestors(layer.id).reduce((product, group) => product * (typeof group.opacity === 'number' ? group.opacity : 1), 1)

  const warnings = []
  const skipped = []
  const imageCache = new Map()
  const alphaFieldCache = new Map()
  let placedPixels = 0

  const loadImage = async layer => {
    if (!layer?.imageFile) return null
    if (imageCache.has(layer.id)) return imageCache.get(layer.id)
    let entry = null
    try {
      const buffer = await readFile(join(target.imagesDir, layer.imageFile))
      if (isExrBuffer(buffer)) { skipped.push(`adjustment/EXR layer "${layer.name ?? layer.id}" image not decoded (EXR needs the app)`); entry = { unsupported: true } }
      else {
        const decoded = await decodeRgba(sharp, buffer)
        entry = decoded
        placedPixels += decoded.width * decoded.height
      }
    } catch (error) {
      warnings.push(`cannot decode ${layer.imageFile}: ${error.message}`)
      entry = { unsupported: true }
    }
    imageCache.set(layer.id, entry)
    return entry
  }

  const loadMask = async layer => {
    if (!layer?.maskFile || layer.maskEnabled === false) return null
    if (imageCache.has(`mask:${layer.id}`)) return imageCache.get(`mask:${layer.id}`)
    let entry = null
    try {
      entry = await decodeRgba(sharp, await readFile(join(target.imagesDir, layer.maskFile)))
      placedPixels += entry.width * entry.height
    } catch (error) {
      warnings.push(`cannot decode mask ${layer.maskFile}: ${error.message}`)
      entry = null
    }
    imageCache.set(`mask:${layer.id}`, entry)
    return entry
  }

  /** Alpha field (coverage) of a layer in document space, for clipping. */
  const alphaField = async layer => {
    if (alphaFieldCache.has(layer.id)) return alphaFieldCache.get(layer.id)
    const field = new Uint8Array(canvasW * canvasH)
    const image = await loadImage(layer)
    const mask = await loadMask(layer)
    if (image && !image.unsupported && layer.transform?.size) {
      const transform = layer.transform
      const bounds = rotatedBounds(transform)
      const theta = ((transform.rotation ?? 0) * Math.PI) / 180
      const cos = Math.cos(theta), sin = Math.sin(theta)
      const [ox, oy] = transform.origin ?? [0, 0]
      const [sw, sh] = transform.size
      const opacity = (typeof layer.opacity === 'number' ? layer.opacity : 1)
      for (let y = Math.max(0, bounds.y0); y < Math.min(canvasH, bounds.y1); y++) {
        for (let x = Math.max(0, bounds.x0); x < Math.min(canvasW, bounds.x1); x++) {
          const lx = x + 0.5 - ox - sw / 2, ly = y + 0.5 - oy - sh / 2
          const rx = lx * cos + ly * sin, ry = -lx * sin + ly * cos
          let u = (rx + sw / 2) / sw, v = (ry + sh / 2) / sh
          if (transform.flipX) u = 1 - u
          if (transform.flipY) v = 1 - v
          if (u < 0 || v < 0 || u >= 1 || v >= 1) continue
          let coverage = bilinear(image, u * (image.width - 1), v * (image.height - 1))[3] / 255
          coverage *= opacity
          if (mask && layer.maskLinked !== false) coverage *= bilinear(mask, u * (mask.width - 1), v * (mask.height - 1))[0] / 255
          else if (mask && layer.maskPlacement) coverage *= sampleMask(mask, x + 0.5, y + 0.5, layer.maskPlacement) / 255
          field[y * canvasW + x] = Math.round(Math.min(1, Math.max(0, coverage)) * 255)
        }
      }
    }
    // clipping chain: the source's own maskSourceID contributes too
    if (layer.maskSourceID && byId.has(layer.maskSourceID)) {
      const upstream = await alphaField(byId.get(layer.maskSourceID))
      for (let p = 0; p < field.length; p++) field[p] = Math.round((field[p] / 255) * (upstream[p] / 255) * 255)
    }
    alphaFieldCache.set(layer.id, field)
    return field
  }

  const canvas = Buffer.alloc(canvasW * canvasH * 4)
  const groupMasks = new Map()
  const loadGroupMask = async group => {
    if (!group.maskFile || group.maskEnabled === false) return null
    if (groupMasks.has(group.id)) return groupMasks.get(group.id)
    let entry = null
    try {
      entry = { image: await decodeRgba(sharp, await readFile(join(target.imagesDir, group.maskFile))), placement: group.transform?.size ? group.transform.origin ?? [0, 0] : [0, 0], size: group.transform?.size ?? [canvasW, canvasH] }
    } catch (error) { warnings.push(`cannot decode group mask ${group.maskFile}: ${error.message}`) }
    groupMasks.set(group.id, entry)
    return entry
  }

  for (const layer of layers) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    if (onlyLayerIds && !onlyLayerIds.includes(layer.id)) continue
    if (layer.adjustment) { skipped.push(`adjustment layer "${layer.name ?? layer.id}" (${layer.adjustment.kind}) not rendered`); continue }
    if (layer.isGroup === true) continue // folders contribute opacity/masks via their children
    if (layer.effects && Object.keys(layer.effects).length) skipped.push(`layer effects on "${layer.name ?? layer.id}" not rendered`)
    if (!isVisible(layer)) continue
    const image = await loadImage(layer)
    if (!image) continue // blank layer
    if (image.unsupported) continue
    const transform = layer.transform
    if (!transform?.size) { warnings.push(`layer "${layer.name ?? layer.id}" has no usable transform; skipped`); continue }
    if (placedPixels > MAX_PLACED_PIXELS) { warnings.push('pixel budget reached; remaining layers skipped'); break }

    const bounds = rotatedBounds(transform)
    const theta = ((transform.rotation ?? 0) * Math.PI) / 180
    const cos = Math.cos(theta), sin = Math.sin(theta)
    const [ox, oy] = transform.origin ?? [0, 0]
    const [sw, sh] = transform.size
    const opacity = (typeof layer.opacity === 'number' ? layer.opacity : 1) * groupOpacity(layer)
    const blendMode = layer.blendMode ?? 'Normal'
    const mask = await loadMask(layer)
    const ancestorMasks = []
    for (const group of ancestors(layer.id)) {
      const groupMask = await loadGroupMask(group)
      if (groupMask) ancestorMasks.push(groupMask)
    }
    let clipField = null
    if (layer.maskSourceID && byId.has(layer.maskSourceID)) clipField = await alphaField(byId.get(layer.maskSourceID))

    for (let y = Math.max(0, bounds.y0); y < Math.min(canvasH, bounds.y1); y++) {
      for (let x = Math.max(0, bounds.x0); x < Math.min(canvasW, bounds.x1); x++) {
        const lx = x + 0.5 - ox - sw / 2, ly = y + 0.5 - oy - sh / 2
        const rx = lx * cos + ly * sin, ry = -lx * sin + ly * cos
        let u = (rx + sw / 2) / sw, v = (ry + sh / 2) / sh
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue
        if (transform.flipX) u = 1 - u
        if (transform.flipY) v = 1 - v
        const nearest = transform.sampling === 'Nearest'
        const px = nearest ? Math.min(image.width - 1, Math.max(0, Math.round(u * (image.width - 1)))) : u * (image.width - 1)
        const py = nearest ? Math.min(image.height - 1, Math.max(0, Math.round(v * (image.height - 1)))) : v * (image.height - 1)
        const rgba = bilinear(image, px, py)
        if (rgba[3] <= 0) continue
        let coverage = opacity
        if (mask && layer.maskLinked !== false) coverage *= bilinear(mask, u * (mask.width - 1), v * (mask.height - 1))[0] / 255
        else if (mask && layer.maskPlacement) coverage *= sampleMask(mask, x + 0.5, y + 0.5, layer.maskPlacement) / 255
        for (const groupMask of ancestorMasks) {
          const [gx, gy, gw, gh] = [groupMask.placement[0], groupMask.placement[1], groupMask.size[0], groupMask.size[1]]
          coverage *= sampleMask(groupMask.image, x + 0.5, y + 0.5, [gx, gy, gw, gh]) / 255
        }
        if (clipField) coverage *= clipField[y * canvasW + x] / 255
        if (coverage <= 0) continue
        // compositePixel applies the source pixel's own alpha to `coverage`
        scratch[0] = Math.round(rgba[0]); scratch[1] = Math.round(rgba[1]); scratch[2] = Math.round(rgba[2]); scratch[3] = Math.round(rgba[3])
        compositePixel(canvas, (y * canvasW + x) * 4, scratch, 0, blendMode, Math.min(1, coverage))
      }
    }
  }

  let png = sharp(canvas, { raw: { width: canvasW, height: canvasH, channels: 4 } })
  if (maxWidth && canvasW > maxWidth) png = png.resize({ width: maxWidth })
  const output = await png.png().toBuffer()
  const meta = await sharp(output).metadata()
  return { ok: true, png: output, width: meta.width, height: meta.height, canvas: [canvasW, canvasH], skipped, warnings }
}

const scratch = Buffer.alloc(4)
