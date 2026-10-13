/**
 * Live documentation loader — the compatibility core of this plugin.
 *
 * Nothing about the .comp format is frozen here: blend modes, adjustment
 * kinds, the highest known manifest version and the numeric limits are all
 * parsed at runtime from the docs inside the synced Compositor git checkout
 * (github.com/robbietilton/Compositor). When upstream changes the format and
 * the checkout is pulled, the plugin follows automatically. The constants
 * below are only fallbacks for when a doc cannot be read or its wording has
 * drifted; every value also reports where it came from so an agent can tell.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readGitState } from './comp-paths.mjs'

export const DOCS = {
  writing: 'docs/writing-comp-files.md',
  format: 'docs/project-format.md',
}

export const FALLBACK = {
  // writing-comp-files.md "Blend modes are spelled exactly" (24 modes)
  blendModes: [
    'Normal', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn', 'Lighten', 'Screen',
    'Color Dodge', 'Linear Dodge (Add)', 'Overlay', 'Soft Light', 'Hard Light',
    'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Difference', 'Exclusion',
    'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity',
  ],
  // writing-comp-files.md "`kind` is one of ..." (13 kinds, versions 7 and 9)
  adjustmentKinds: [
    'Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain',
    'Invert', 'Black & White', 'Color Balance', 'Gaussian Blur', 'Motion Blur', 'Add Noise',
  ],
  maxVersion: 13,
  limits: { canvasSide: 30000, totalLayerPixels: 100_000_000, totalMaskPixels: 100_000_000, layers: 10000, manifestBytes: 4 * 1024 * 1024, assetBytes: 512 * 1024 * 1024, guideCount: 1000, guidePosition: 1_000_000, nestDepth: 64, maskSourceChain: 256 },
}

const backticked = line => {
  const values = []
  const pattern = /`([^`]+)`/g
  let match
  while ((match = pattern.exec(line))) values.push(match[1])
  return values
}

function parseBlendModes(writingText) {
  if (!writingText) return null
  const line = writingText.split('\n').find(text => text.includes('Blend modes are spelled exactly'))
  if (!line) return null
  const modes = backticked(line)
  return modes.length >= 8 ? modes : null
}

function parseAdjustmentKinds(writingText, formatText) {
  const sources = [writingText, formatText].filter(Boolean)
  const kinds = new Set()
  for (const text of sources) {
    for (const line of text.split('\n')) {
      // "`kind` is one of `Hue/Saturation`, `Levels`, ..."
      if (/`kind`\s+is one of/.test(line)) for (const kind of backticked(line)) if (kind !== 'kind') kinds.add(kind)
      // "... version 9 adds three adjustment kinds: `Gaussian Blur` (...), ..."
      if (/adds?\s+(?:three|new|\d+)\s+adjustment kinds/.test(line)) for (const kind of backticked(line)) kinds.add(kind)
    }
  }
  return kinds.size >= 8 ? [...kinds] : null
}

function parseMaxVersion(formatText) {
  if (!formatText) return null
  const title = formatText.split('\n', 1)[0] || ''
  // "# Compositor project format, versions 1–13" (also handles 1-13, 1—13)
  const match = /versions?\s*1\s*[–—\-]\s*(\d+)/i.exec(title)
  return match ? Number(match[1]) : null
}

function parseLimits(formatText, writingText) {
  const text = `${formatText ?? ''}\n${writingText ?? ''}`
  const out = {}
  // "30,000 pixels per canvas/image side" / "canvases up to 30,000 pixels on a side"
  for (const pattern of [/(\d[\d,]*)\s*pixels per canvas\/image side/, /up to (\d[\d,]*)\s*pixels on a side/]) {
    const match = pattern.exec(text)
    if (match) { out.canvasSide = Number(match[1].replace(/,/g, '')); break }
  }
  // "100 million total source pixels" / "Up to 100 million mask pixels"
  let match = /(\d+)\s*million total source pixels/.exec(text)
  if (match) out.totalLayerPixels = Number(match[1]) * 1e6
  match = /(\d+)\s*million mask pixels/.exec(text)
  if (match) out.totalMaskPixels = Number(match[1]) * 1e6
  match = /(\d[\d,]*)\s*layers/.exec(text)
  if (match) out.layers = Number(match[1].replace(/,/g, ''))
  match = /(\d[\d.]*)\s*MiB manifest/.exec(text)
  if (match) out.manifestBytes = Math.round(Number(match[1]) * 1024 * 1024)
  match = /(\d[\d.]*)\s*MiB per encoded asset/.exec(text)
  if (match) out.assetBytes = Math.round(Number(match[1]) * 1024 * 1024)
  return out
}

const cache = new Map()

async function readDocIfChanged(repoDir, relative, entry) {
  const path = join(repoDir, relative)
  const fileStat = await stat(path).catch(() => null)
  if (!fileStat || !fileStat.isFile()) {
    if (entry?.text !== undefined) return entry
    return { text: null, mtimeMs: 0, bytes: 0 }
  }
  if (entry && entry.mtimeMs === fileStat.mtimeMs && entry.size === fileStat.size) return entry
  const text = await readFile(path, 'utf8').catch(() => null)
  return { text, mtimeMs: fileStat.mtimeMs, size: fileStat.size, bytes: Buffer.byteLength(text ?? '') }
}

/**
 * Load docs and vocab from the checkout. Cached per repoDir; the cache is
 * keyed on doc mtimes so a `git pull` invalidates it immediately.
 */
export async function loadRepoDocs(repoDir) {
  const cached = cache.get(repoDir)
  const [writing, format] = await Promise.all([
    readDocIfChanged(repoDir, DOCS.writing, cached?.writing),
    readDocIfChanged(repoDir, DOCS.format, cached?.format),
  ])

  const warnings = []
  if (writing.text === null) warnings.push(`cannot read ${DOCS.writing} in ${repoDir}`)
  if (format.text === null) warnings.push(`cannot read ${DOCS.format} in ${repoDir}`)

  const parsedBlend = parseBlendModes(writing.text)
  const parsedKinds = parseAdjustmentKinds(writing.text, format.text)
  const parsedMaxVersion = parseMaxVersion(format.text)
  const parsedLimits = parseLimits(format.text, writing.text)

  const blendModes = parsedBlend ?? FALLBACK.blendModes
  const adjustmentKinds = parsedKinds ?? FALLBACK.adjustmentKinds
  const maxVersion = parsedMaxVersion ?? FALLBACK.maxVersion
  const limits = { ...FALLBACK.limits, ...parsedLimits }
  if (!parsedBlend) warnings.push('blend mode list fell back to the built-in copy; the doc wording may have changed')
  if (!parsedKinds) warnings.push('adjustment kind list fell back to the built-in copy')
  if (!parsedMaxVersion) warnings.push('max manifest version fell back to the built-in value')

  const git = await readGitState(repoDir)
  const entry = {
    repoDir,
    repoExists: writing.text !== null || format.text !== null,
    git,
    docs: { writing: { path: join(repoDir, DOCS.writing), found: writing.text !== null, bytes: writing.bytes }, format: { path: join(repoDir, DOCS.format), found: format.text !== null, bytes: format.bytes } },
    texts: { writing: writing.text, format: format.text },
    vocab: {
      blendModes,
      blendModesSource: parsedBlend ? 'docs' : 'fallback',
      adjustmentKinds,
      adjustmentKindsSource: parsedKinds ? 'docs' : 'fallback',
      maxVersion,
      maxVersionSource: parsedMaxVersion ? 'docs' : 'fallback',
      limits,
      limitsSource: Object.keys(parsedLimits).length ? 'docs+fallback' : 'fallback',
    },
    warnings,
    writingEntry: writing,
    formatEntry: format,
  }
  cache.set(repoDir, entry)
  return entry
}

/** Public shape without internal cache entries or huge text blobs. */
export function publicDocs(entry, { includeText = false } = {}) {
  const out = {
    repoDir: entry.repoDir,
    repoExists: entry.repoExists,
    git: entry.git,
    docs: entry.docs,
    vocab: {
      blendModeCount: entry.vocab.blendModes.length,
      blendModes: entry.vocab.blendModes,
      blendModesSource: entry.vocab.blendModesSource,
      adjustmentKinds: entry.vocab.adjustmentKinds,
      adjustmentKindsSource: entry.vocab.adjustmentKindsSource,
      maxManifestVersion: entry.vocab.maxVersion,
      maxVersionSource: entry.vocab.maxVersionSource,
      limits: entry.vocab.limits,
    },
    warnings: entry.warnings,
  }
  if (includeText) out.texts = entry.texts
  return out
}
