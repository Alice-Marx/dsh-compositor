/**
 * Forward-compatible validator for .comp manifests and packages.
 *
 * The rules implemented here are the invariants the Compositor docs state
 * (IDs name their files, exact blend-mode spellings, group tree shape,
 * numeric ranges, version gates, package limits) — the stable parts of a
* format whose history is purely additive. Vocabulary and limits come from
 * loadRepoDocs(), so a newer checkout loosens them automatically, and a
 * manifest whose version is newer than the checkout's docs only ever gets
 * warnings, never a hard error: new upstream features must not be blocked by
 * an older plugin.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isExrBuffer, readPngHeader } from './comp-png.mjs'

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const SAMPLINGS = new Set(['High quality', 'Smooth', 'Nearest'])
const IMAGE_EXTENSIONS = /\.(png|exr)$/i

const isNum = value => typeof value === 'number' && Number.isFinite(value)
const isInt = value => typeof value === 'number' && Number.isInteger(value)
const isBool = value => typeof value === 'boolean'
const isStr = value => typeof value === 'string' && value.length > 0

function colorRunsProblems(runs, contentLength, label) {
  const problems = []
  if (!Array.isArray(runs)) return [`${label} must be an array`]
  let cursor = -1
  for (const run of runs) {
    if (!run || typeof run !== 'object') { problems.push(`${label} entries must be objects`); continue }
    const { location, length } = run
    if (!isInt(location) || !isInt(length) || length <= 0) { problems.push(`${label} entries need integer location and positive length`); continue }
    if (location < 0 || location + length > contentLength) problems.push(`${label} run [${location}, ${location + length}) exceeds the content length ${contentLength} (UTF-16 units)`)
    if (location < cursor) problems.push(`${label} runs must be sorted and not overlap`)
    cursor = Math.max(cursor, location + length)
  }
  return problems
}

function effectRangeProblems(effects) {
  const problems = []
  const size = (record, key, field = 'size') => {
    if (record && isNum(record[field]) && (record[field] < 0 || record[field] > 500)) problems.push(`effects.${key}.${field} must be 0–500 layer pixels`)
    if (record && isNum(record.opacity) && (record.opacity < 0 || record.opacity > 1)) problems.push(`effects.${key}.opacity must be 0–1`)
  }
  if (!effects || typeof effects !== 'object') return problems
  size(effects.stroke, 'stroke')
  size(effects.shadow, 'shadow')
  size(effects.innerShadow, 'innerShadow')
  size(effects.outerGlow, 'outerGlow')
  size(effects.innerGlow, 'innerGlow')
  if (effects.colorOverlay && isNum(effects.colorOverlay.opacity) && (effects.colorOverlay.opacity < 0 || effects.colorOverlay.opacity > 1)) problems.push('effects.colorOverlay.opacity must be 0–1')
  return problems
}

function adjustmentProblems(adjustment, kinds) {
  const problems = []
  if (!adjustment || typeof adjustment !== 'object') return ['adjustment must be an object']
  if (!isStr(adjustment.kind)) problems.push('adjustment.kind is required')
  else if (!kinds.includes(adjustment.kind)) problems.push(`adjustment.kind "${adjustment.kind}" is not one of: ${kinds.join(', ')}`)
  const range = (key, min, max) => {
    if (adjustment[key] !== undefined && (!isNum(adjustment[key]) || adjustment[key] < min || adjustment[key] > max)) problems.push(`adjustment.${key} must be a finite number ${min}–${max}`)
  }
  range('hue', -360, 360)
  range('saturation', -100, 100)
  range('lightness', -100, 100)
  if (adjustment.levels) {
    const { ranges } = adjustment.levels
    if (!Array.isArray(ranges) || ranges.length !== 4) problems.push('adjustment.levels.ranges must have 4 channels (RGB, red, green, blue)')
    else for (const [index, r] of ranges.entries()) {
      for (const key of ['black', 'white', 'outputBlack', 'outputWhite']) if (!isNum(r[key])) problems.push(`levels.ranges[${index}].${key} must be a number`)
      if (isNum(r.black) && isNum(r.white) && r.black > r.white) problems.push(`levels.ranges[${index}].black must be ≤ white`)
      if (!isNum(r.gamma) || r.gamma <= 0) problems.push(`levels.ranges[${index}].gamma must be > 0`)
    }
  }
  if (adjustment.curves) {
    const { channels } = adjustment.curves
    if (!Array.isArray(channels) || channels.length !== 4) problems.push('adjustment.curves.channels must have 4 channels (RGB, red, green, blue)')
    else for (const [index, points] of channels.entries()) {
      if (!Array.isArray(points) || points.length < 2) { problems.push(`curves.channels[${index}] needs at least 2 points`); continue }
      let lastX = -1
      for (const point of points) {
        if (!isNum(point.x) || !isNum(point.y) || point.x < 0 || point.x > 255 || point.y < 0 || point.y > 255) { problems.push(`curves.channels[${index}] points must be numbers in 0–255`); break }
        if (point.x <= lastX) { problems.push(`curves.channels[${index}] x values must be strictly increasing from 0 to 255`); break }
        lastX = point.x
      }
    }
  }
  range('blurRadius', 0.1, 250)
  range('motionAngle', -90, 90)
  range('motionDistance', 1, 2000)
  range('noiseAmount', 0.1, 400)
  if (adjustment.colorBalanceSettings) {
    const settings = adjustment.colorBalanceSettings
    for (const key of ['shadowCyanRed', 'shadowMagentaGreen', 'shadowYellowBlue', 'midCyanRed', 'midMagentaGreen', 'midYellowBlue', 'highlightCyanRed', 'highlightMagentaGreen', 'highlightYellowBlue']) {
      if (settings[key] !== undefined && (!isNum(settings[key]) || Math.abs(settings[key]) > 100)) problems.push(`colorBalanceSettings.${key} must be −100–100`)
    }
  }
  return problems
}

/**
 * Validate a .comp package. `docs` is the loadRepoDocs() result.
 * Returns { ok, problems, warnings, info }.
 */
export async function validateComp(target, docs, { readImages = true } = {}) {
  const problems = []
  const warnings = []
  const { compDir, manifestPath, imagesDir } = target
  const vocab = docs.vocab

  const manifestStat = await stat(manifestPath).catch(() => null)
  if (!manifestStat) return { ok: false, problems: [`manifest.json missing at ${manifestPath}`], warnings, info: { compDir } }
  if (manifestStat.size > vocab.limits.manifestBytes) problems.push(`manifest.json is ${manifestStat.size} bytes, over the ${vocab.limits.manifestBytes} byte limit`)

  const manifestText = await readFile(manifestPath, 'utf8').catch(error => null)
  if (manifestText === null) return { ok: false, problems: [`manifest.json cannot be read: ${errorNote(manifestPath)}`], warnings, info: { compDir } }
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    return { ok: false, problems: [`manifest.json is not valid JSON: ${error.message}`], warnings, info: { compDir } }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, problems: ['manifest.json must contain a JSON object'], warnings, info: { compDir } }

  const version = manifest.version
  const knownMax = vocab.maxVersion
  const relaxed = isInt(version) && version > knownMax
  if (!isInt(version)) problems.push('manifest.version must be an integer')
  else if (relaxed) warnings.push(`manifest version ${version} is newer than the checkout docs (1–${knownMax}); version-gated checks are warnings only — features unknown to this plugin may be present`)
  else if (version < 1) problems.push('manifest.version must be ≥ 1')
  // "gated": hard error while the version is known, warning once upstream runs ahead
  const gate = (min, message) => {
    if (!isInt(version)) return
    if (version < min) (relaxed ? warnings : problems).push(message)
  }

  if (manifest.format !== 'com.compositor.project') problems.push(`manifest.format must be "com.compositor.project", got ${JSON.stringify(manifest.format)}`)
  if (manifest.colorSpace !== undefined && manifest.colorSpace !== 'sRGB') warnings.push(`colorSpace is ${JSON.stringify(manifest.colorSpace)}; the documented working space is sRGB`)
  if (!isStr(manifest.documentID)) warnings.push('documentID is missing (keep it when editing an existing project)')
  else if (!UUID_RE.test(manifest.documentID)) warnings.push('documentID is not a UUID')
  for (const key of ['width', 'height']) {
    const value = manifest[key]
    if (!isInt(value) || value < 1) problems.push(`manifest.${key} must be a positive integer`)
    else if (value > vocab.limits.canvasSide) problems.push(`manifest.${key} is ${value}, over the ${vocab.limits.canvasSide} pixel per-side limit`)
  }
  if (manifest.resolution !== undefined && (!isInt(manifest.resolution) || manifest.resolution < 1 || manifest.resolution > 9600)) problems.push('manifest.resolution must be an integer 1–9600 pixels/inch')

  const layers = manifest.layers
  if (!Array.isArray(layers)) return { ok: false, problems: [...problems, 'manifest.layers must be an array'], warnings, info: { compDir, version } }
  if (layers.length > vocab.limits.layers) problems.push(`${layers.length} layers, over the ${vocab.limits.layers} limit`)
  if (!layers.length) warnings.push('the layer list is empty')

  const byId = new Map()
  for (const [index, layer] of layers.entries()) {
    if (!layer || typeof layer !== 'object') { problems.push(`layers[${index}] must be an object`); continue }
    if (!isStr(layer.id)) { problems.push(`layers[${index}] is missing a string id`); continue }
    if (byId.has(layer.id)) problems.push(`duplicate layer id ${layer.id}`)
    byId.set(layer.id, layer)
    if (!UUID_RE.test(layer.id)) warnings.push(`layer id ${layer.id} is not a UUID`)
    else if (layer.id !== layer.id.toUpperCase()) warnings.push(`layer id ${layer.id} has lowercase hex; the docs write IDs in uppercase`)
    if (layer.name === undefined) warnings.push(`layer ${layer.id} has no name`)
  }

  // active layer reference
  if (manifest.activeLayerID !== undefined && manifest.activeLayerID !== null) {
    if (!byId.has(manifest.activeLayerID)) warnings.push(`activeLayerID ${manifest.activeLayerID} does not match any layer`)
  }

  // ---- group tree: parents exist, are groups, no cycles, depth, contiguity
  const parentOf = id => byId.get(id)?.parentID ?? null
  for (const layer of byId.values()) {
    if (layer.parentID === undefined) continue
    if (!isStr(layer.parentID)) { problems.push(`layer ${layer.id}: parentID must be a string`); continue }
    const parent = byId.get(layer.parentID)
    if (!parent) { problems.push(`layer ${layer.id}: parentID ${layer.parentID} does not exist`); continue }
    if (parent.isGroup !== true) { problems.push(`layer ${layer.id}: parent ${layer.parentID} is not a group`); continue }
    // cycle + depth by walking ancestors
    const seen = new Set([layer.id])
    let depth = 0
    let cursor = layer.parentID
    let cyclic = false
    while (cursor) {
      if (seen.has(cursor)) { cyclic = true; break }
      seen.add(cursor)
      depth++
      if (depth > vocab.limits.nestDepth) break
      cursor = parentOf(cursor)
    }
    if (cyclic) problems.push(`layer ${layer.id}: parentID chain contains a cycle`)
    else if (depth > vocab.limits.nestDepth) problems.push(`layer ${layer.id}: nested ${depth} group levels deep, over the ${vocab.limits.nestDepth} limit`)
  }
  // contiguity: renderers traverse each group as a contiguous subtree, so the
  // array must read parent followed by its children (stack discipline)
  {
    const stack = []
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object' || !isStr(layer.id)) continue
      const parentID = layer.parentID ?? null
      if (parentID === null) {
        stack.length = 0
      } else if (stack.includes(parentID)) {
        while (stack.length && stack[stack.length - 1] !== parentID) stack.pop()
      } else {
        problems.push(`layer ${layer.id}: group ${parentID} is not contiguous — each group's children must follow it directly in the array`)
        stack.length = 0
      }
      if (layer.isGroup === true) stack.push(layer.id)
    }
  }

  // ---- per-layer appearance and assets
  let imageCount = 0, groupCount = 0, adjustmentCount = 0, textCount = 0, blankCount = 0
  let layerPixels = 0, maskPixels = 0
  const referenced = new Set()
  const imagesDirStat = await stat(imagesDir).catch(() => null)
  const readAsset = async name => {
    const path = join(imagesDir, name)
    const fileStat = await stat(path).catch(() => null)
    if (!fileStat) return { exists: false, path }
    if (fileStat.size > vocab.limits.assetBytes) problems.push(`${name} is ${fileStat.size} bytes, over the ${vocab.limits.assetBytes} byte per-asset limit`)
    if (!readImages) return { exists: true, path, header: null, bytes: fileStat.size }
    const handle = await readFile(path).catch(() => null)
    if (handle === null) return { exists: true, path, unreadable: true, bytes: fileStat.size }
    return { exists: true, path, buffer: handle, header: readPngHeader(handle), exr: isExrBuffer(handle), bytes: fileStat.size }
  }

  for (const [index, layer] of layers.entries()) {
    if (!layer || typeof layer !== 'object' || !isStr(layer.id)) continue
    const where = `layers[${index}] (${layer.name ?? layer.id})`
    const isGroup = layer.isGroup === true

    if (isGroup) {
      groupCount++
      if (isStr(layer.imageFile)) problems.push(`${where}: a group cannot carry an imageFile`)
      if (layer.adjustment) problems.push(`${where}: an adjustment layer cannot be a group`)
      if (layer.opacity !== undefined && layer.opacity !== 1) gate(8, `${where}: folders carry their own opacity only from version 8`)
      if (layer.blendMode !== undefined && layer.blendMode !== 'Normal') warnings.push(`${where}: folders are pass-through; blend modes other than Normal are ignored`)
    }

    if (layer.opacity !== undefined) {
      if (!isNum(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) problems.push(`${where}: opacity must be 0–1`)
    }
    if (layer.blendMode !== undefined) {
      if (!vocab.blendModes.includes(layer.blendMode)) {
        const message = `${where}: blendMode "${layer.blendMode}" is not one of: ${vocab.blendModes.join(', ')}`
        // hard error only when the list came from the current checkout docs
        // and the manifest version is within the documented range
        if (vocab.blendModesSource === 'docs' && !relaxed) problems.push(message)
        else warnings.push(message)
      }
    }
    if (layer.isVisible !== undefined && !isBool(layer.isVisible)) problems.push(`${where}: isVisible must be a boolean`)

    // transform
    const transform = layer.transform
    if (transform !== undefined) {
      if (!transform || typeof transform !== 'object') problems.push(`${where}: transform must be an object`)
      else {
        const point = (key, axis) => {
          const value = transform[key]
          if (!Array.isArray(value) || value.length !== 2 || !isNum(value[0]) || !isNum(value[1])) problems.push(`${where}: transform.${key} must be two finite numbers (x, y${axis ?? ''})`)
        }
        point('origin')
        if (Array.isArray(transform.size) && transform.size.length === 2 && isNum(transform.size[0]) && isNum(transform.size[1])) {
          if (transform.size[0] <= 0 || transform.size[1] <= 0) problems.push(`${where}: transform.size must be positive`)
        } else problems.push(`${where}: transform.size must be two positive numbers (width, height)`)
        if (!isNum(transform.rotation)) problems.push(`${where}: transform.rotation must be a number`)
        if (transform.sampling !== undefined && !SAMPLINGS.has(transform.sampling)) warnings.push(`${where}: sampling "${transform.sampling}" is not one of ${[...SAMPLINGS].join(', ')}`)
        if (transform.flipX !== undefined && !isBool(transform.flipX)) problems.push(`${where}: transform.flipX must be a boolean`)
        if (transform.flipY !== undefined && !isBool(transform.flipY)) problems.push(`${where}: transform.flipY must be a boolean`)
      }
    }

    // adjustment
    if (layer.adjustment !== undefined) {
      if (isStr(layer.imageFile)) problems.push(`${where}: an adjustment layer has no imageFile`)
      adjustmentCount++
      for (const message of adjustmentProblems(layer.adjustment, vocab.adjustmentKinds)) problems.push(`${where}: ${message}`)
      gate(7, `${where}: adjustment layers exist only from version 7`)
    }

    // text metadata
    if (layer.text !== undefined) {
      textCount++
      if (!isStr(layer.text.content)) problems.push(`${where}: text.content must be a string`)
      else {
        if (layer.text.colorRuns !== undefined) {
          for (const message of colorRunsProblems(layer.text.colorRuns, layer.text.content.length, 'colorRuns')) problems.push(`${where}: ${message}`)
          gate(10, `${where}: colorRuns exist only from version 10`)
        }
        if (layer.text.fontRuns !== undefined) {
          for (const message of colorRunsProblems(layer.text.fontRuns, layer.text.content.length, 'fontRuns')) problems.push(`${where}: ${message}`)
          for (const run of Array.isArray(layer.text.fontRuns) ? layer.text.fontRuns : []) if (run && !isStr(run.fontName)) problems.push(`${where}: fontRuns entries need fontName`)
          gate(11, `${where}: fontRuns exist only from version 11`)
        }
      }
    }

    // effects
    if (layer.effects !== undefined) {
      if (!layer.effects || typeof layer.effects !== 'object') problems.push(`${where}: effects must be an object`)
      else for (const message of effectRangeProblems(layer.effects)) problems.push(`${where}: ${message}`)
    }

    // shape metadata
    if (layer.shape !== undefined && layer.shape && typeof layer.shape === 'object') {
      for (const key of ['red', 'green', 'blue']) {
        const value = layer.shape[key]
        if (value !== undefined && (!isNum(value) || value < 0 || value > 1)) problems.push(`${where}: shape.${key} must be 0–1`)
      }
      if (layer.shape.cornerRadius !== undefined && !isNum(layer.shape.cornerRadius) && layer.shape.cornerRadius < 0) problems.push(`${where}: shape.cornerRadius must be ≥ 0`)
    }

    // mask
    const hasMask = isStr(layer.maskFile)
    if (layer.maskEnabled !== undefined && !isBool(layer.maskEnabled)) problems.push(`${where}: maskEnabled must be a boolean`)
    if (hasMask) {
      const expectedMask = `${layer.id}.mask.png`
      if (layer.maskFile !== expectedMask) problems.push(`${where}: maskFile must be "${expectedMask}", got "${layer.maskFile}"`)
      if (isGroup) gate(6, `${where}: groups can carry masks only from version 6`)
      else gate(4, `${where}: layer masks exist only from version 4`)
      if (imagesDirStat) {
        const asset = await readAsset(layer.maskFile)
        if (!asset.exists) problems.push(`${where}: mask file ${layer.maskFile} is missing from images/`)
        else if (asset.header) {
          if (asset.header.colorType !== 0 || asset.header.bitDepth !== 8) problems.push(`${where}: mask ${layer.maskFile} must be 8-bit grayscale (got ${asset.header.bitDepth}-bit color type ${asset.header.colorType})`)
          maskPixels += asset.header.width * asset.header.height
        }
        referenced.add(layer.maskFile)
      }
    }
    if (layer.maskPlacement !== undefined || layer.maskLinked !== undefined) {
      if (!hasMask) problems.push(`${where}: maskPlacement/maskLinked require a maskFile`)
      if (layer.maskPlacement !== undefined && (!Array.isArray(layer.maskPlacement) || layer.maskPlacement.length !== 4 || layer.maskPlacement.some(v => !isNum(v)))) problems.push(`${where}: maskPlacement must be four numbers (x, y, width, height)`)
      if (layer.maskLinked !== undefined && !isBool(layer.maskLinked)) problems.push(`${where}: maskLinked must be a boolean`)
    }

    // live mask (clipping)
    if (layer.maskSourceID !== undefined) {
      gate(5, `${where}: maskSourceID (clipping masks) exists only from version 5`)
      const source = byId.get(layer.maskSourceID)
      if (!source) problems.push(`${where}: maskSourceID ${layer.maskSourceID} does not exist`)
      else if (source.isGroup === true) problems.push(`${where}: maskSourceID cannot point at a group`)
      else if (layer.maskSourceID === layer.id) problems.push(`${where}: maskSourceID cannot reference itself`)
    }

    // image
    if (isStr(layer.imageFile)) {
      imageCount++
      const expectedPng = `${layer.id}.png`
      const expectedExr = `${layer.id}.exr`
      if (layer.imageFile !== expectedPng && layer.imageFile !== expectedExr) {
        problems.push(`${where}: imageFile must be "${expectedPng}"${isInt(version) && version >= 13 ? ` or "${expectedExr}"` : ''}, got "${layer.imageFile}"`)
      } else if (layer.imageFile === expectedExr) {
        gate(13, `${where}: EXR images exist only from version 13`)
      }
      if (imagesDirStat) {
        const asset = await readAsset(layer.imageFile)
        if (!asset.exists) problems.push(`${where}: image file ${layer.imageFile} is missing from images/`)
        else if (asset.exr) { /* EXR magic verified */ }
        else if (asset.unreadable) warnings.push(`${where}: ${layer.imageFile} could not be read`)
        else if (!asset.header) problems.push(`${where}: ${layer.imageFile} is not a PNG`)
        else {
          if (asset.header.bitDepth === 16) gate(12, `${where}: 16-bit PNG images exist only from version 12`)
          if (asset.header.colorType !== 6) warnings.push(`${where}: ${layer.imageFile} is ${asset.header.bitDepth}-bit color type ${asset.header.colorType}; layer images are documented as RGBA (color type 6)`)
          if (asset.header.interlace) warnings.push(`${where}: ${layer.imageFile} is interlaced`)
          if (isInt(asset.header.width) && isInt(asset.header.height)) {
            const pixels = asset.header.width * asset.header.height
            layerPixels += pixels
            if (asset.header.width > vocab.limits.canvasSide || asset.header.height > vocab.limits.canvasSide) problems.push(`${where}: ${layer.imageFile} is ${asset.header.width}x${asset.header.height}, over the ${vocab.limits.canvasSide} pixel per-side limit`)
          }
        }
        referenced.add(layer.imageFile)
      }
    } else if (!isGroup && !layer.adjustment) {
      blankCount++
    }
  }

  // maskSourceID cycles and chain length (functional graph)
  for (const layer of byId.values()) {
    if (layer.maskSourceID === undefined || !isStr(layer.maskSourceID)) continue
    const seen = new Set([layer.id])
    let cursor = layer.maskSourceID
    let chain = 1
    while (cursor) {
      if (seen.has(cursor)) { problems.push(`layer ${cursor}: maskSourceID chain contains a cycle`); break }
      seen.add(cursor)
      if (++chain > vocab.limits.maskSourceChain) { problems.push(`layer ${layer.id}: maskSourceID chain is longer than ${vocab.limits.maskSourceChain} nodes`); break }
      cursor = byId.get(cursor)?.maskSourceID ?? null
    }
  }

  // guides
  if (manifest.guides !== undefined) {
    gate(8, 'guides exist only from version 8')
    if (!Array.isArray(manifest.guides)) problems.push('guides must be an array')
    else {
      if (manifest.guides.length > vocab.limits.guideCount) problems.push(`${manifest.guides.length} guides, over the ${vocab.limits.guideCount} limit`)
      for (const [index, guide] of manifest.guides.entries()) {
        if (!guide || !isStr(guide.id) || !isStr(guide.axis) || !['horizontal', 'vertical'].includes(guide.axis) || !isNum(guide.position)) { problems.push(`guides[${index}] needs id, axis (horizontal|vertical) and a numeric position`); continue }
        if (Math.abs(guide.position) > vocab.limits.guidePosition) problems.push(`guides[${index}].position is out of range (±${vocab.limits.guidePosition})`)
      }
    }
  }

  // pixel budgets
  if (layerPixels > vocab.limits.totalLayerPixels) problems.push(`layers total ${layerPixels.toLocaleString()} pixels, over the ${vocab.limits.totalLayerPixels.toLocaleString()} budget`)
  if (maskPixels > vocab.limits.totalMaskPixels) problems.push(`masks total ${maskPixels.toLocaleString()} pixels, over the ${vocab.limits.totalMaskPixels.toLocaleString()} budget`)

  // package leftovers
  if (imagesDirStat) {
    const entries = await readdir(imagesDir).catch(() => [])
    const orphaned = []
    for (const name of entries) {
      if (referenced.has(name)) continue
      if (!IMAGE_EXTENSIONS.test(name)) continue
      const fileStat = await stat(join(imagesDir, name)).catch(() => null)
      orphaned.push({ name, bytes: fileStat?.size ?? 0 })
    }
    if (orphaned.length) warnings.push(`${orphaned.length} image file(s) in images/ are not referenced by the manifest (run compositor_clean): ${orphaned.slice(0, 5).map(o => o.name).join(', ')}${orphaned.length > 5 ? ' …' : ''}`)
  }
  const quickLook = await stat(join(compDir, 'QuickLook')).catch(() => null)
  if (quickLook?.isDirectory()) warnings.push('a QuickLook folder exists; delete it after changing the project so Finder does not preview a stale picture (compositor_clean does)')

  const info = {
    compDir,
    manifestPath,
    version: isInt(version) ? version : null,
    knownMaxVersion: knownMax,
    relaxed,
    canvas: isInt(manifest.width) && isInt(manifest.height) ? [manifest.width, manifest.height] : null,
    layers: { total: layers.length, images: imageCount, groups: groupCount, adjustments: adjustmentCount, text: textCount, blank: blankCount },
    layerPixels, maskPixels,
    manifestBytes: manifestStat.size,
    stackOrder: 'layers[0] is the BOTTOM of the stack; the last layer draws on top',
  }

  return { ok: problems.length === 0, problems, warnings, info }
}

function errorNote(path) {
  return `could not read ${path}`
}
