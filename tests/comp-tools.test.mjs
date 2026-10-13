import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCompositorTools } from '../.dsh-plugin/shared/comp-tools.mjs'
import { baseManifest, cleanup, makeTempDir } from './helpers.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const REPO = 'F:\\everyAI\\dsh-Compositor\\Compositor'
const repoAvailable = existsSync(join(REPO, 'docs', 'writing-comp-files.md'))

let dir
const tools = buildCompositorTools({ config: { repoDir: repoAvailable ? REPO : 'Z:\\missing' } })
const tool = name => {
  const found = tools.find(entry => entry.name === name)
  assert.ok(found, `tool ${name} registered`)
  return found
}

test.before(async () => { dir = await makeTempDir() })
test.after(async () => { await cleanup(dir) })

test('eight tools are registered with JSON-schema parameters', () => {
  assert.equal(tools.length, 8)
  assert.deepEqual(tools.map(t => t.name).sort(), ['compositor_clean', 'compositor_docs', 'compositor_layer_png', 'compositor_manifest', 'compositor_preview', 'compositor_repo', 'compositor_validate', 'compositor_write_manifest'])
  for (const entry of tools) {
    assert.equal(entry.parameters.type, 'object', entry.name)
    assert.equal(typeof entry.execute, 'function', entry.name)
  }
})

test('compositor_repo reports the checkout', async () => {
  const result = await tool('compositor_repo').execute({})
  assert.equal(result.ok, true)
  if (repoAvailable) {
    assert.equal(result.vocab.blendModesSource, 'docs')
    assert.ok(result.git.commit)
  } else {
    assert.equal(result.vocab.blendModesSource, 'fallback')
  }
})

test('compositor_docs returns live doc text', async () => {
  const result = await tool('compositor_docs').execute({ file: 'writing' })
  assert.equal(result.ok, true)
  if (repoAvailable) assert.ok(result.docs.writing.includes('manifest.json'))
})

test('layer_png → write_manifest → validate end-to-end on a fresh project', async () => {
  const projectDir = join(dir, 'e2e.comp')
  // background layer
  const background = await tool('compositor_layer_png').execute({
    path: projectDir, width: 32, height: 32, mode: 'radial',
    from: [20, 40, 90, 255], to: [0, 0, 10, 255],
  })
  assert.equal(background.ok, true, JSON.stringify(background))
  assert.match(background.file, /^[0-9A-F-]{36}\.png$/)
  // a top layer with a gradient mask
  const topId = (await tool('compositor_layer_png').execute({ path: projectDir, width: 32, height: 32 })).id
  const topMask = await tool('compositor_layer_png').execute({ path: projectDir, id: topId, width: 32, height: 32, mode: 'linear', kind: 'mask', from: 255, to: 0 })
  assert.ok(topMask.file.endsWith('.mask.png'))
  const manifest = baseManifest()
  manifest.width = 32
  manifest.height = 32
  manifest.activeLayerID = topId
  manifest.layers = [
    { id: background.id, name: 'Night', imageFile: background.file, isVisible: true, isGroup: false, opacity: 1, blendMode: 'Normal', transform: { origin: [0, 0], size: [32, 32], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' } },
    { id: topId, name: 'Fade', imageFile: `${topId}.png`, isVisible: true, isGroup: false, opacity: 1, blendMode: 'Screen', maskFile: topMask.file, maskEnabled: true, transform: { origin: [0, 0], size: [32, 32], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' } },
  ]
  // fresh bootstrap: no manifest.json exists yet, write creates it
  assert.equal(existsSync(join(projectDir, 'manifest.json')), false)
  const written = await tool('compositor_write_manifest').execute({ path: projectDir, manifest })
  assert.equal(written.ok, true, JSON.stringify(written.validation?.problems ?? written))
  assert.ok(existsSync(join(projectDir, 'manifest.json')))

  const validated = await tool('compositor_validate').execute({ path: projectDir })
  assert.equal(validated.ok, true, JSON.stringify(validated.problems))
  assert.equal(validated.info.layers.images, 2)

  const summary = await tool('compositor_manifest').execute({ path: projectDir })
  assert.equal(summary.layerCount, 2)
  assert.ok(summary.layerLines.some(line => line.includes('Screen')))
})

test('write_manifest refuses broken manifests', async () => {
  const projectDir = join(dir, 'refuse.comp')
  const background = await tool('compositor_layer_png').execute({ path: projectDir, width: 8, height: 8 })
  const manifest = baseManifest({ width: 8, height: 8 })
  manifest.layers[0] = { ...manifest.layers[0], id: background.id, imageFile: 'totally-wrong.png' }
  const result = await tool('compositor_write_manifest').execute({ path: projectDir, manifest, fixFilenames: false })
  assert.equal(result.ok, false)
  assert.equal(result.written, false)
  assert.ok(result.validation.problems.some(p => p.includes('imageFile must be')))
  assert.equal(existsSync(join(projectDir, 'manifest.json')), false, 'nothing written on refusal')
  // with filename autoFix it renames and succeeds
  const fixed = await tool('compositor_write_manifest').execute({ path: projectDir, manifest })
  assert.equal(fixed.ok, true, JSON.stringify(fixed.validation?.problems ?? fixed))
  assert.ok(fixed.fixes.some(f => f.includes('totally-wrong.png')))
})

test('compositor_clean dry-run and apply', async () => {
  const projectDir = join(dir, 'clean.comp')
  const layer = await tool('compositor_layer_png').execute({ path: projectDir, width: 8, height: 8 })
  const manifest = baseManifest({ width: 8, height: 8 })
  manifest.layers[0] = { ...manifest.layers[0], id: layer.id, imageFile: layer.file }
  await tool('compositor_write_manifest').execute({ path: projectDir, manifest })
  const stray = await tool('compositor_layer_png').execute({ path: projectDir, width: 8, height: 8 })
  const dry = await tool('compositor_clean').execute({ path: projectDir })
  assert.equal(dry.ok, true)
  assert.equal(dry.applied, false)
  assert.equal(dry.unusedImages.length, 1)
  assert.equal(dry.unusedImages[0].name, stray.file)
  const applied = await tool('compositor_clean').execute({ path: projectDir, apply: true })
  assert.equal(applied.removed.length, 1)
  const after = await tool('compositor_validate').execute({ path: projectDir })
  assert.equal(after.ok, true, JSON.stringify(after.problems))
})

test('compositor_preview works when sharp is present, reports when not', async () => {
  const projectDir = join(dir, 'preview.comp')
  const layer = await tool('compositor_layer_png').execute({ path: projectDir, width: 16, height: 16, mode: 'linear', from: [0, 0, 0, 255], to: [255, 255, 255, 255] })
  const manifest = baseManifest({ width: 16, height: 16 })
  manifest.layers[0] = { ...manifest.layers[0], id: layer.id, imageFile: layer.file }
  await tool('compositor_write_manifest').execute({ path: projectDir, manifest })
  const result = await tool('compositor_preview').execute({ path: projectDir, maxWidth: 16 })
  if (result.ok) {
    assert.ok(result.out.endsWith('.preview.png'))
    const bytes = await readFile(result.out)
    assert.ok(bytes.length > 100)
  } else {
    assert.ok(result.reason.includes('sharp'), result.reason)
  }
})
