import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadRepoDocs, publicDocs, FALLBACK } from '../.dsh-plugin/shared/comp-docs.mjs'

// The real synced checkout, when present: these tests double as a live
// compatibility check against the current upstream docs.
const REPO = 'F:\\everyAI\\dsh-Compositor\\Compositor'
const repoAvailable = existsSync(join(REPO, 'docs', 'writing-comp-files.md'))

test('fallback vocabulary is complete', () => {
  assert.equal(FALLBACK.blendModes.length, 24)
  assert.ok(FALLBACK.blendModes.includes('Linear Dodge (Add)'))
  assert.equal(FALLBACK.adjustmentKinds.length, 12)
  assert.equal(typeof FALLBACK.maxVersion, 'number')
})

test('docs are parsed live from the real checkout', { skip: !repoAvailable }, async () => {
  const entry = await loadRepoDocs(REPO)
  assert.equal(entry.repoExists, true)
  assert.deepEqual(entry.warnings, [])
  assert.equal(entry.vocab.blendModesSource, 'docs')
  assert.equal(entry.vocab.adjustmentKindsSource, 'docs')
  assert.equal(entry.vocab.maxVersionSource, 'docs')
  assert.ok(entry.vocab.blendModes.length >= 24, `blend modes parsed: ${entry.vocab.blendModes.length}`)
  assert.ok(entry.vocab.adjustmentKinds.includes('Curves'))
  assert.ok(entry.vocab.adjustmentKinds.includes('Gaussian Blur'))
  assert.ok(entry.vocab.maxVersion >= 13)
  assert.equal(entry.vocab.limits.canvasSide, 30000)
  assert.equal(entry.vocab.limits.layers, 10000)
  assert.equal(entry.vocab.limits.manifestBytes, 4 * 1024 * 1024)
  assert.equal(entry.vocab.limits.assetBytes, 512 * 1024 * 1024)
  assert.equal(entry.vocab.limits.totalLayerPixels, 100_000_000)
  // git state without running git (subject may be null when the commit
  // object is packed — that is a normal best-effort miss)
  assert.ok(entry.git, 'git state read')
  assert.match(entry.git.commit, /^[0-9a-f]{12}$/)
  assert.ok(entry.git.subject === null || typeof entry.git.subject === 'string')
})

test('vocab survives doc wording drift (synthetic docs)', async () => {
  // Simulate an upstream doc update: new blend mode + new adjustment kind +
  // version bump. The plugin must follow without code changes.
  const { writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'docs-'))
  try {
    await mkdir(join(root, 'docs'), { recursive: true })
    const writing = [
      '# Writing',
      '- **Blend modes are spelled exactly** as Compositor names them: `Normal`, `Multiply`, `Screen`, `Phosphor`, `Luminosity`, `Darken`, `Lighten`, `Overlay`, `Difference`.',
      '- `kind` is one of `Curves`, `Gaussian Blur`, `Chrome Bloom`, `Levels`, `Exposure`, `Grain`, `Invert`, `Black & White`, `Color Balance`, `Hue/Saturation`, `Motion Blur`, `Add Noise`.',
    ].join('\n')
    const format = '# Compositor project format, versions 1–14\n\nLimits: 30,000 pixels per canvas/image side, 100 million total source pixels, 10,000 layers, 4 MiB manifest, 512 MiB per encoded asset.'
    await writeFile(join(root, 'docs', 'writing-comp-files.md'), writing)
    await writeFile(join(root, 'docs', 'project-format.md'), format)
    const entry = await loadRepoDocs(root)
    assert.equal(entry.vocab.maxVersion, 14)
    assert.ok(entry.vocab.blendModes.includes('Phosphor'))
    assert.ok(entry.vocab.adjustmentKinds.includes('Chrome Bloom'))
    assert.equal(entry.vocab.blendModesSource, 'docs')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing repo falls back with warnings, never throws', async () => {
  const entry = await loadRepoDocs('Z:\\definitely\\not\\a\\repo')
  assert.equal(entry.repoExists, false)
  assert.ok(entry.warnings.length >= 2)
  assert.equal(entry.vocab.blendModesSource, 'fallback')
  assert.equal(entry.vocab.maxVersion, FALLBACK.maxVersion)
  const pub = publicDocs(entry)
  assert.equal(pub.vocab.blendModes.length, FALLBACK.blendModes.length)
  assert.equal(pub.texts, undefined, 'publicDocs omits text unless asked')
})

test('publicDocs includes text when requested', async () => {
  if (!repoAvailable) return
  const entry = await loadRepoDocs(REPO)
  const pub = publicDocs(entry, { includeText: true })
  assert.ok(pub.texts.writing.includes('manifest.json'))
})
