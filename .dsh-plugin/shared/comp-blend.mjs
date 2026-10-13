/**
 * Photoshop blend math for the preview renderer.
 *
 * All 24 Compositor blend modes, implemented on straight (unpremultiplied)
 * 8-bit RGBA buffers using the W3C compositing and blending model:
 *   Co = αs × (1−αb) × Cs + αs × αb × B(Cb, Cs)   (premultiplied result)
 *   αo = αs + αb × (1−αs)
 * Non-separable modes (Hue, Saturation, Color, Luminosity) use the standard
 * lum/sat clip functions. Inputs and outputs are 0–255 per channel; the
 * caller applies this per destination pixel over a source scan.
 */

const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t)
const divide = (a, b) => (b === 0 ? 1 : a / b)

// separable blend functions on 0–1 channels
const separable = {
  normal: (b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'linear-burn': (b, s) => clamp01(b + s - 1),
  'linear-dodge': (b, s) => clamp01(b + s),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  subtract: (b, s) => clamp01(b - s),
  divide: (b, s) => (s <= 0 ? 1 : clamp01(b / s)),
  'soft-light': (b, s) => {
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)
    return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b)
  },
  'vivid-light': (b, s) => (s < 0.5 ? (s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s))) : s >= 1 ? 1 : Math.min(1, b / (2 * (1 - s)))),
  'linear-light': (b, s) => clamp01(b + 2 * s - 1),
  'pin-light': (b, s) => (s < 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard-mix': (b, s) => (separable['vivid-light'](b, s) < 0.5 ? 0 : 1),
}

function hardLight(b, s) {
  return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)
}
separable['hard-light'] = hardLight

// non-separable: HSL helpers
function lum(r, g, b) {
  return 0.3 * r + 0.59 * g + 0.11 * b
}
function clipColor(r, g, b) {
  const l = lum(r, g, b)
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  if (min < 0) { r = l + ((r - l) * l) / (l - min); g = l + ((g - l) * l) / (l - min); b = l + ((b - l) * l) / (l - min) }
  if (max > 1) { r = l + ((r - l) * (1 - l)) / (max - l); g = l + ((g - l) * (1 - l)) / (max - l); b = l + ((b - l) * (1 - l)) / (max - l) }
  return [r, g, b]
}
function sat(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b)
}
function setLum([r, g, b], l) {
  const d = l - lum(r, g, b)
  return clipColor(r + d, g + d, b + d)
}
function setSat([r, g, b], s) {
  // order the channels, set the middle-to-max span to s, min stays 0
  const ordered = [r, g, b].map((c, i) => ({ c, i })).sort((a, b2) => a.c - b2.c)
  const out = [0, 0, 0]
  if (ordered[2].c > ordered[0].c) {
    out[ordered[1].i] = ((ordered[1].c - ordered[0].c) * s) / (ordered[2].c - ordered[0].c)
    out[ordered[2].i] = s
  }
  return out
}

const nonSeparable = {
  hue: (b, s) => setLum(setSat(s, sat(b[0], b[1], b[2])), lum(b[0], b[1], b[2])),
  saturation: (b, s) => setLum(setSat(b, sat(s[0], s[1], s[2])), lum(b[0], b[1], b[2])),
  color: (b, s) => setLum(s, lum(b[0], b[1], b[2])),
  luminosity: (b, s) => setLum(b, lum(s[0], s[1], s[2])),
}

// Compositor blend name → blending function; b and s are [r,g,b] in 0–1.
// Separable modes work per channel, so they are lifted to RGB-array form.
const separableMode = channelFn => (b, s) => [channelFn(b[0], s[0]), channelFn(b[1], s[1]), channelFn(b[2], s[2])]

const MODES = {
  Normal: separableMode(separable.normal),
  Multiply: separableMode(separable.multiply),
  Screen: separableMode(separable.screen),
  Overlay: separableMode(separable.overlay),
  Darken: separableMode(separable.darken),
  Lighten: separableMode(separable.lighten),
  'Color Dodge': separableMode(separable['color-dodge']),
  'Color Burn': separableMode(separable['color-burn']),
  'Linear Burn': separableMode(separable['linear-burn']),
  'Linear Dodge (Add)': separableMode(separable['linear-dodge']),
  Difference: separableMode(separable.difference),
  Exclusion: separableMode(separable.exclusion),
  Subtract: separableMode(separable.subtract),
  Divide: separableMode(separable.divide),
  'Soft Light': separableMode(separable['soft-light']),
  'Hard Light': separableMode(separable['hard-light']),
  'Vivid Light': separableMode(separable['vivid-light']),
  'Linear Light': separableMode(separable['linear-light']),
  'Pin Light': separableMode(separable['pin-light']),
  'Hard Mix': separableMode(separable['hard-mix']),
  Hue: nonSeparable.hue,
  Saturation: nonSeparable.saturation,
  Color: nonSeparable.color,
  Luminosity: nonSeparable.luminosity,
}

export function blendFunction(blendMode) {
  return MODES[blendMode] ?? null
}

export const SUPPORTED_BLEND_MODES = Object.keys(MODES)

/**
 * Composite one source pixel over one destination pixel (straight alpha,
 * 0–255 channels). `mode` is a Compositor blend name; anything unknown falls
 * back to Normal. `opacity` is the layer/coverage product in 0–1; the source
 * pixel's own alpha is applied here.
 */
export function compositePixel(dst, di, src, si, mode, opacity) {
  const sa = opacity * src[si + 3] / 255
  if (sa <= 0) return
  const br = dst[di] / 255, bg = dst[di + 1] / 255, bb = dst[di + 2] / 255, ba = dst[di + 3] / 255
  const sr = src[si] / 255, sg = src[si + 1] / 255, sb = src[si + 2] / 255
  const blend = MODES[mode] ?? MODES.Normal
  const mixed = blend([br, bg, bb], [sr, sg, sb])
  const alphaOut = sa + ba * (1 - sa)
  if (alphaOut <= 0) { dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0; return }
  // W3C simple alpha compositing: source-only ∪ blended intersection ∪ backdrop-only
  const channel = (s, m, b) => (sa * (1 - ba) * s + sa * ba * m + (1 - sa) * ba * b) / alphaOut
  dst[di] = Math.round(clamp01(channel(sr, mixed[0], br)) * 255)
  dst[di + 1] = Math.round(clamp01(channel(sg, mixed[1], bg)) * 255)
  dst[di + 2] = Math.round(clamp01(channel(sb, mixed[2], bb)) * 255)
  dst[di + 3] = Math.round(alphaOut * 255)
}
