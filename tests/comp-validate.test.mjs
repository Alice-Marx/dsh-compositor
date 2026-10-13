import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveCompPath } from '../.dsh-plugin/shared/comp-paths.mjs'
import { validateComp } from '../.dsh-plugin/shared/comp-validate.mjs'
import { autoFixManifest, cleanPackage, newLayerId, readManifest, summarizeManifest, writeManifestAtomic } from '../.dsh-plugin/shared/comp-project.mjs'
import { baseManifest, cleanup, DOCS_STUB, makeCompPackage, makeTempDir } from './helpers.mjs'

let dir
test.before(async () => { dir = await makeTempDir() })
test.after(async () => { await cleanup(dir) })

const validate = async (manifest, options = {}) => {
  const compDir = await makeCompPackage(dir, manifest, options)
  const target = await resolveCompPath(compDir)
  return { result: await validateComp(target, DOCS_STUB), target, manifest }
}

test('a correct minimal project validates', async () => {
  const { result } = await validate(baseManifest())
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.equal(result.info.layers.images, 1)
  assert.equal(result.info.version, 11)
})

test('bad JSON is reported without throwing', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const broken = join(dir, 'broken.comp')
  await mkdir(join(broken, 'images'), { recursive: true })
  await writeFile(join(broken, 'manifest.json'), '{ "layers": [')
  const target = await resolveCompPath(broken)
  const result = await validateComp(target, DOCS_STUB)
  assert.equal(result.ok, false)
  assert.ok(result.problems[0].includes('not valid JSON'))
})

test('image files must be named after the layer id', async () => {
  const manifest = baseManifest()
  manifest.layers[0].imageFile = 'wrong-name.png'
  const { result } = await validate(manifest, { images: [{ name: 'wrong-name.png', content: Buffer.alloc(64) }] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some(p => p.includes('imageFile must be')))
})

test('missing image file is an error (the app refuses silently)', async () => {
  // valid package first, then reference a layer whose image was never written
  const manifest = baseManifest()
  const { target } = await validate(manifest)
  const ghostId = newLayerId()
  manifest.layers.push({ ...manifest.layers[0], id: ghostId, name: 'Ghost', imageFile: `${ghostId}.png` })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(target.manifestPath, JSON.stringify(manifest, null, 2))
  const result = await validateComp(target, DOCS_STUB)
  assert.ok(result.problems.some(p => p.includes('is missing from images/')))
})

test('blend mode spelling is enforced from the live list', async () => {
  const manifest = baseManifest()
  manifest.layers[0].blendMode = 'multiply' // lowercase typo
  const { result } = await validate(manifest)
  assert.ok(result.problems.some(p => p.includes('blendMode "multiply"')))
  manifest.layers[0].blendMode = 'Multiply'
  const again = await validate(manifest)
  assert.equal(again.result.ok, true, JSON.stringify(again.result.problems))
})

test('masks: naming, grayscale format and version gate', async () => {
  const manifest = baseManifest()
  manifest.layers[0].maskFile = '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.mask.png'
  manifest.layers[0].maskEnabled = true
  const { result } = await validate(manifest)
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  // mask on version 3 is rejected
  const old = baseManifest({ version: 3 })
  old.layers[0].maskFile = manifest.layers[0].maskFile
  const gated = await validate(old)
  assert.ok(gated.result.problems.some(p => p.includes('version 4')))
})

test('groups: contiguity, cycles, group opacity gate', async () => {
  const child = id => ({ id, name: `child ${id}`, isGroup: false, opacity: 1, blendMode: 'Normal', imageFile: `${id}.png`, transform: { origin: [0, 0], size: [64, 64], rotation: 0 } })
  const group = { id: '11111111-2222-4333-8444-555555555555', name: 'Folder', isGroup: true, opacity: 1, blendMode: 'Normal', transform: { origin: [0, 0], size: [64, 64], rotation: 0 } }
  // valid: group followed by its child
  const good = baseManifest()
  const childId = newLayerId()
  good.layers = [good.layers[0], group, child(childId)]
  good.layers[2].parentID = group.id
  const okCase = await validate(good)
  assert.equal(okCase.result.ok, true, JSON.stringify(okCase.result.problems))
  // invalid: child of a group that closed earlier
  const scattered = baseManifest()
  const otherChild = newLayerId()
  scattered.layers = [group, good.layers[0], child(otherChild)]
  scattered.layers[2].parentID = group.id
  const bad = await validate(scattered)
  assert.ok(bad.result.problems.some(p => p.includes('not contiguous')))
  // cycle: group inside its own child
  const cyclic = baseManifest()
  cyclic.layers = [group, child(newLayerId())]
  cyclic.layers[0].parentID = cyclic.layers[1].id
  cyclic.layers[1].parentID = group.id
  const cycle = await validate(cyclic)
  assert.ok(cycle.result.problems.some(p => p.includes('cycle') || p.includes('not a group') || p.includes('does not exist')))
  // folder opacity before v8
  const oldOpacity = baseManifest({ version: 7 })
  const g8 = { ...group, opacity: 0.5 }
  oldOpacity.layers = [oldOpacity.layers[0], g8]
  const gated = await validate(oldOpacity)
  assert.ok(gated.result.problems.some(p => p.includes('version 8')))
})

test('adjustment layers: kind list, numeric ranges, no imageFile', async () => {
  const manifest = baseManifest()
  const id = newLayerId()
  manifest.layers.push({
    id, name: 'Warm', isGroup: false, opacity: 1, blendMode: 'Normal',
    transform: { origin: [0, 0], size: [64, 64], rotation: 0 },
    adjustment: { kind: 'Curves', curves: { channels: [[{ x: 0, y: 0 }, { x: 255, y: 255 }], [{ x: 0, y: 0 }, { x: 120, y: 300 }], [{ x: 0, y: 0 }, { x: 255, y: 255 }], [{ x: 0, y: 0 }, { x: 255, y: 255 }]] } },
  })
  const { result } = await validate(manifest)
  assert.ok(result.problems.some(p => p.includes('curves') && p.includes('0–255')))
  manifest.layers[1].adjustment.curves.channels[1][1].y = 147
  manifest.layers[1].adjustment.kind = 'Chromatic Aberration'
  const unknown = await validate(manifest)
  assert.ok(unknown.result.problems.some(p => p.includes('adjustment.kind')))
})

test('clipping masks: chain cycles and version gate', async () => {
  const manifest = baseManifest({ version: 11 })
  const top = newLayerId()
  manifest.layers.push({ ...manifest.layers[0], id: top, name: 'Top', imageFile: `${top}.png`, maskSourceID: manifest.layers[0].id })
  const { result } = await validate(manifest)
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  // self reference
  manifest.layers[1].maskSourceID = top
  const selfRef = await validate(manifest)
  assert.ok(selfRef.result.problems.some(p => p.includes('itself')))
  // v4 project cannot use clipping
  manifest.layers[1].maskSourceID = manifest.layers[0].id
  const old = baseManifest({ version: 4 })
  old.layers.push({ ...old.layers[0], id: top, imageFile: `${top}.png`, maskSourceID: old.layers[0].id })
  const gated = await validate(old)
  assert.ok(gated.result.problems.some(p => p.includes('version 5')))
})

test('unknown future version downgrades version-gated errors to warnings', async () => {
  const manifest = baseManifest({ version: 99 })
  manifest.layers[0].maskFile = '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.mask.png' // v4 gate
  const { result } = await validate(manifest)
  assert.equal(result.ok, true, 'future versions only warn')
  assert.ok(result.warnings.some(w => w.includes('newer than the checkout docs')))
  assert.ok(result.info.relaxed)
})

test('unreferenced images and QuickLook are warnings', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const manifest = baseManifest()
  const { result, target } = await validate(manifest, { images: [{ name: 'AAAA1111-2222-4333-8444-555555555555.png' }] })
  assert.ok(result.warnings.some(w => w.includes('not referenced')))
  await mkdir(join(target.compDir, 'QuickLook'))
  await writeFile(join(target.compDir, 'QuickLook', 'Preview.jpg'), Buffer.alloc(4))
  const again = await validateComp(target, DOCS_STUB)
  assert.ok(again.warnings.some(w => w.includes('QuickLook')))
})

test('autoFixManifest: ids, filenames, defaults', () => {
  const layer = { name: 'No id', imageFile: 'photo.png' }
  const { manifest, fixes } = autoFixManifest({ layers: [layer], width: 10, height: 10 })
  assert.ok(manifest.layers[0].id)
  assert.equal(manifest.layers[0].imageFile, `${manifest.layers[0].id}.png`)
  assert.equal(manifest.format, 'com.compositor.project')
  assert.equal(manifest.version, 11)
  assert.equal(manifest.colorSpace, 'sRGB')
  assert.ok(fixes.length >= 4)
  assert.equal(manifest.activeLayerID, manifest.layers[0].id)
})

test('writeManifestAtomic writes atomically and round-trips', async () => {
  const manifest = baseManifest()
  const { target } = await validate(manifest)
  manifest.layers[0].name = 'Renamed'
  await writeManifestAtomic(target, manifest)
  const { manifest: read } = await readManifest(target)
  assert.equal(read.layers[0].name, 'Renamed')
  // change detection note: same manifest bytes would not trigger an app
  // reload, but a rename does (docs: contents change)
})

test('cleanPackage removes only unreferenced images and QuickLook', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const manifest = baseManifest()
  const { target } = await validate(manifest, { images: [{ name: 'BBBB1111-2222-4333-8444-555555555555.png' }] })
  const dry = await cleanPackage(target, manifest, { apply: false })
  assert.equal(dry.applied, false)
  assert.equal(dry.unusedImages.length, 1)
  await mkdir(join(target.compDir, 'QuickLook'))
  await writeFile(join(target.compDir, 'QuickLook', 'Preview.jpg'), Buffer.alloc(4))
  const applied = await cleanPackage(target, manifest, { apply: true })
  assert.deepEqual(applied.removed.sort(), ['QuickLook/', 'images/BBBB1111-2222-4333-8444-555555555555.png'].sort())
  // referenced image survives
  const { readFile } = await import('node:fs/promises')
  const kept = await readFile(join(target.imagesDir, manifest.layers[0].imageFile))
  assert.ok(kept.length > 0)
})

test('summarizeManifest is compact and layer-aware', async () => {
  const manifest = baseManifest()
  const { target } = await validate(manifest)
  const { text } = await readManifest(target)
  const summary = summarizeManifest(manifest, text)
  assert.equal(summary.layerCount, 1)
  assert.ok(summary.layerLines[0].includes('Background'))
  assert.ok(summary.manifest, 'small manifests come back whole')
  const one = summarizeManifest(manifest, text, { layerIndex: 0 })
  assert.equal(one.layer.name, 'Background')
})
