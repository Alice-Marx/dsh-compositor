import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A tiny docs vocabulary for tests, mimicking loadRepoDocs() output. */
export const TEST_VOCAB = {
  blendModes: ['Normal', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn', 'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)', 'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity'],
  blendModesSource: 'docs',
  adjustmentKinds: ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Invert', 'Black & White', 'Color Balance', 'Gaussian Blur', 'Motion Blur', 'Add Noise'],
  adjustmentKindsSource: 'docs',
  maxVersion: 13,
  maxVersionSource: 'docs',
  limits: { canvasSide: 30000, totalLayerPixels: 100_000_000, totalMaskPixels: 100_000_000, layers: 10000, manifestBytes: 4 * 1024 * 1024, assetBytes: 512 * 1024 * 1024, guideCount: 1000, guidePosition: 1_000_000, nestDepth: 64, maskSourceChain: 256 },
}

export const DOCS_STUB = { repoDir: 'test', repoExists: true, vocab: TEST_VOCAB, warnings: [] }

export async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-compositor-test-'))
}

/**
 * Build a .comp package fixture with valid tiny PNG layers. IDs default to
 * well-formed uppercase UUIDs so the naming rule holds.
 */
export async function makeCompPackage(dir, manifest, { images = [] } = {}) {
  const { encodePngRgba, encodePngGray } = await import('../.dsh-plugin/shared/comp-png.mjs')
  const compDir = join(dir, `project-${Math.random().toString(36).slice(2, 8)}.comp`)
  const imagesDir = join(compDir, 'images')
  await mkdir(imagesDir, { recursive: true })
  for (const layer of manifest.layers ?? []) {
    if (layer.imageFile) await writeFile(join(imagesDir, layer.imageFile), encodePngRgba(4, 4, Buffer.alloc(4 * 4 * 4, 128)))
    if (layer.maskFile) await writeFile(join(imagesDir, layer.maskFile), encodePngGray(4, 4, Buffer.alloc(16, 255)))
  }
  for (const extra of images) await writeFile(join(imagesDir, extra.name), Buffer.from(extra.content ?? 'not a png'))
  await writeFile(join(compDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return compDir
}

export const baseManifest = (overrides = {}) => ({
  format: 'com.compositor.project',
  version: 11,
  colorSpace: 'sRGB',
  documentID: '0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D',
  width: 64,
  height: 64,
  resolution: 72,
  activeLayerID: '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F',
  layers: [
    {
      id: '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F',
      name: 'Background',
      imageFile: '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png',
      isVisible: true,
      isGroup: false,
      opacity: 1,
      blendMode: 'Normal',
      transform: { origin: [0, 0], size: [64, 64], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' },
    },
  ],
  ...overrides,
})

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}
