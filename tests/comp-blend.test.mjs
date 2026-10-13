import test from 'node:test'
import assert from 'node:assert/strict'
import { blendFunction, compositePixel, SUPPORTED_BLEND_MODES } from '../.dsh-plugin/shared/comp-blend.mjs'

test('all 24 Compositor blend modes have math', () => {
  assert.equal(SUPPORTED_BLEND_MODES.length, 24)
  for (const mode of ['Normal', 'Multiply', 'Screen', 'Hue', 'Luminosity', 'Hard Mix', 'Linear Dodge (Add)']) assert.ok(blendFunction(mode), mode)
  assert.equal(blendFunction('NotAMode'), null)
})

test('Normal over transparent = source; over opaque = source replaces', () => {
  const dst = Buffer.from([10, 20, 30, 0])
  const src = Buffer.from([200, 100, 50, 255])
  compositePixel(dst, 0, src, 0, 'Normal', 1)
  assert.deepEqual([...dst], [200, 100, 50, 255])

  const opaque = Buffer.from([0, 0, 0, 255])
  compositePixel(opaque, 0, src, 0, 'Normal', 1)
  assert.deepEqual([...opaque], [200, 100, 50, 255])
})

test('Multiply darkens; Screen lightens', () => {
  const backdrop = Buffer.from([128, 128, 128, 255])
  const multiply = Buffer.from(backdrop)
  compositePixel(multiply, 0, Buffer.from([128, 128, 128, 255]), 0, 'Multiply', 1)
  assert.ok(multiply[0] < 128, `multiply(0.5,0.5)=0.25 → ${multiply[0]}`)
  const screen = Buffer.from(backdrop)
  compositePixel(screen, 0, Buffer.from([128, 128, 128, 255]), 0, 'Screen', 1)
  assert.ok(screen[0] > 128, `screen(0.5,0.5)=0.75 → ${screen[0]}`)
})

test('opacity 0 leaves the backdrop untouched', () => {
  const dst = Buffer.from([1, 2, 3, 4])
  const before = Buffer.from(dst)
  compositePixel(dst, 0, Buffer.from([255, 255, 255, 255]), 0, 'Normal', 0)
  assert.deepEqual([...dst], [...before])
})

test('half-opacity over white lands between', () => {
  const dst = Buffer.from([255, 255, 255, 255])
  compositePixel(dst, 0, Buffer.from([0, 0, 0, 255]), 0, 'Normal', 0.5)
  for (const channel of [dst[0], dst[1], dst[2]]) assert.ok(channel > 100 && channel < 155, `expected mid gray, got ${channel}`)
})

test('non-separable Luminosity: backdrop colors at the source luminance', () => {
  // W3C/PPhotoshop Luminosity = SetLum(Cb, Lum(Cs)): keep the backdrop's hue
  // and saturation, take the source's luminance. A red source (lum 0.3) over
  // a white backdrop desaturates to ≈77 gray.
  const dst = Buffer.from([255, 255, 255, 255])
  compositePixel(dst, 0, Buffer.from([255, 0, 0, 255]), 0, 'Luminosity', 1)
  const [r, g, b] = [dst[0], dst[1], dst[2]]
  assert.ok(Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2, `gray expected, got ${[r, g, b]}`)
  assert.ok(r > 60 && r < 95, `lum(red)=76.5 expected, got ${r}`)
})

test('transparent source pixels do not disturb the backdrop', () => {
  const dst = Buffer.from([50, 60, 70, 255])
  const before = Buffer.from(dst)
  compositePixel(dst, 0, Buffer.from([255, 0, 0, 0]), 0, 'Difference', 1)
  assert.deepEqual([...dst], [...before])
})