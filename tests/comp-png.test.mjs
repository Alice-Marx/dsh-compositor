import test from 'node:test'
import assert from 'node:assert/strict'
import { encodePngGray, encodePngRgba, generateGrayPixels, generatePixels, isExrBuffer, isPngBuffer, readPngHeader } from '../.dsh-plugin/shared/comp-png.mjs'

test('encodePngRgba produces a PNG header that decodes back', () => {
  const width = 7, height = 5
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 200; pixels[i + 1] = 100; pixels[i + 2] = 50; pixels[i + 3] = 255 }
  const png = encodePngRgba(width, height, pixels)
  assert.ok(isPngBuffer(png))
  const header = readPngHeader(png)
  assert.equal(header.width, width)
  assert.equal(header.height, height)
  assert.equal(header.bitDepth, 8)
  assert.equal(header.colorType, 6)
})

test('encodePngGray produces an 8-bit grayscale header (mask format)', () => {
  const png = encodePngGray(3, 4, Buffer.alloc(12, 200))
  assert.ok(isPngBuffer(png))
  const header = readPngHeader(png)
  assert.equal(header.colorType, 0)
  assert.equal(header.bitDepth, 8)
})

test('readPngHeader rejects non-PNG buffers and EXR is recognized', () => {
  assert.equal(readPngHeader(Buffer.from('hello world this is definitely long enough!!')), null)
  const exr = Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0])
  assert.ok(isExrBuffer(exr))
  assert.ok(!isPngBuffer(exr))
})

test('generatePixels solid and gradient endpoints', () => {
  const solid = generatePixels({ width: 4, height: 4, mode: 'solid', color: [10, 20, 30, 255] })
  assert.equal(solid[0], 10)
  assert.equal(solid[1], 20)
  assert.equal(solid[2], 30)
  assert.equal(solid[3], 255)
  // vertical gradient: first row near `from`, last row near `to` (pixel
  // centers sit a half-pixel in, so endpoints are close but not exact)
  const gradient = generatePixels({ width: 2, height: 4, mode: 'linear', from: [0, 0, 0, 255], to: [255, 255, 255, 255], angle: 90 })
  assert.ok(gradient[0] <= 64, `top of the gradient should be near black, got ${gradient[0]}`)
  const lastRow = gradient[gradient.length - 4]
  assert.ok(lastRow >= 192, `bottom of the gradient should be near white, got ${lastRow}`)
})

test('generatePixels radial darkens toward the corners', () => {
  const width = 64, height = 64
  const pixels = generatePixels({ width, height, mode: 'radial', from: [255, 255, 255, 255], to: [0, 0, 0, 255] })
  const at = (x, y) => pixels[(y * width + x) * 4]
  assert.ok(at(32, 32) > 240, 'center should stay white')
  assert.ok(at(0, 0) < 60, 'corner should be near black')
})

test('generateGrayPixels mirrors the red channel', () => {
  const gray = generateGrayPixels({ width: 8, height: 8, mode: 'linear', from: 255, to: 0, angle: 0 })
  assert.ok(gray[0] >= 216, `left end near 255, got ${gray[0]}`)
  assert.ok(gray[gray.length - 1] <= 40, `right end near 0, got ${gray[gray.length - 1]}`)
})

test('dimension and buffer guards', () => {
  assert.throws(() => encodePngRgba(0, 5, Buffer.alloc(0)))
  assert.throws(() => encodePngRgba(2, 2, Buffer.alloc(3)))
  assert.throws(() => generatePixels({ width: -1, height: 4 }))
})
