/**
 * Minimal PNG support for .comp projects, pure Node (zlib only).
 *
 * encodePngRgba / encodePngGray write 8-bit PNGs exactly as the Compositor
 * format expects (layer images RGBA, masks 8-bit grayscale). readPngHeader
 * decodes just the IHDR so validation can check bit depth and color type
 * without a full decode. Layer PNG generation (solid / linear / radial) is
 * built on the encoders.
 */
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(...buffers) {
  let c = 0xffffffff
  for (const buffer of buffers) for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeBuffer, data))
  return Buffer.concat([length, typeBuffer, data, crc])
}

function ihdr(width, height, bitDepth, colorType) {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data.writeUInt8(bitDepth, 8)
  data.writeUInt8(colorType, 9)
  // compression 0 (deflate), filter 0, interlace 0 (progressive not written)
  return data
}

function encode(width, height, rawRows, bitDepth, colorType) {
  // rawRows already includes the per-scanline filter byte (0) where needed
  const idat = deflateSync(rawRows, { level: 6 })
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr(width, height, bitDepth, colorType)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Encode 8-bit RGBA pixels (Buffer of width*height*4) as a PNG layer image. */
export function encodePngRgba(width, height, pixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`invalid PNG dimensions ${width}x${height}`)
  if (pixels.length !== width * height * 4) throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${width * height * 4}`)
  const stride = width * 4
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0
    pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return encode(width, height, rows, 8, 6)
}

/** Encode 8-bit grayscale pixels (Buffer of width*height) as a PNG mask. */
export function encodePngGray(width, height, pixels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`invalid PNG dimensions ${width}x${height}`)
  if (pixels.length !== width * height) throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${width * height}`)
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0
    pixels.copy(rows, y * (width + 1) + 1, y * width, (y + 1) * width)
  }
  return encode(width, height, rows, 8, 0)
}

/** Decode the IHDR of a PNG buffer. Returns null when it is not a PNG. */
export function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorType: buffer.readUInt8(25),
    compression: buffer.readUInt8(26),
    filter: buffer.readUInt8(27),
    interlace: buffer.readUInt8(28),
  }
}

export function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

/** OpenEXR magic: 0x76 0x2f 0x31 0x01 followed by a version dword. */
export function isExrBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer[0] === 0x76 && buffer[1] === 0x2f && buffer[2] === 0x31 && buffer[3] === 0x01
}

export const PNG_COLOR_TYPES = { 0: 'grayscale', 2: 'truecolor', 3: 'palette', 4: 'grayscale+alpha', 6: 'truecolor+alpha' }

export function describeImage(buffer, expected) {
  if (isExrBuffer(buffer)) return { format: 'exr', note: 'OpenEXR (HDR) image' }
  const header = readPngHeader(buffer)
  if (!header) return { format: 'unknown', note: 'neither PNG nor EXR' }
  const color = PNG_COLOR_TYPES[header.colorType] ?? `color type ${header.colorType}`
  return {
    format: 'png',
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    colorType: header.colorType,
    interlace: header.interlace,
    note: `${header.bitDepth}-bit ${color}${header.interlace ? ' interlaced' : ''} PNG`,
    ...(expected === 'mask' && (header.colorType !== 0 || header.bitDepth !== 8) ? { maskWarning: 'masks must be 8-bit grayscale' } : {}),
  }
}


function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

function parseColor(input, fallback) {
  if (Array.isArray(input)) {
    const [r, g, b, a] = input
    return {
      r: clamp255(Number(r ?? fallback[0])),
      g: clamp255(Number(g ?? fallback[1])),
      b: clamp255(Number(b ?? fallback[2])),
      a: clamp255(Number(a ?? 255)),
    }
  }
  if (typeof input === 'number') return { r: clamp255(input), g: clamp255(input), b: clamp255(input), a: 255 }
  if (typeof input === 'string') {
    const hex = input.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
      }
    }
  }
  return { r: fallback[0], g: fallback[1], b: fallback[2], a: 255 }
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Generate a layer image or mask buffer. mode: 'solid' | 'linear' | 'radial'.
 * For kind 'image' colors are [r,g,b,(a)] 0-255; for kind 'mask' from/to are
 * gray levels 0-255 (white reveals, black hides).
 */
export function generatePixels({ width, height, mode = 'solid', color, from, to, angle = 90, center, radius }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('width and height must be positive integers')
  if (width * height > 100_000_000) throw new Error('refusing to generate more than 100 million pixels')
  const start = parseColor(from ?? color, [0, 0, 0])
  const end = parseColor(to ?? color, [255, 255, 255])
  const pixels = Buffer.alloc(width * height * 4)
  // the gradient travels along (cos, sin) of `angle` in screen coordinates
  // (y grows downward): 0° = left→right, 90° = top→bottom
  const radians = ((Number(angle) || 0) * Math.PI) / 180
  const dx = Math.cos(radians)
  const dy = Math.sin(radians)
  const extent = Math.abs((width / 2) * dx) + Math.abs((height / 2) * dy)
  const span = 2 * extent || 1
  const cx = Number(center?.[0]) || width / 2
  const cy = Number(center?.[1]) || height / 2
  const maxR = Number(radius) || Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))
  let i = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let t = 0
      if (mode === 'radial') t = Math.min(1, Math.max(0, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / maxR))
      else if (mode === 'linear') {
        const px = x + 0.5 - width / 2
        const py = y + 0.5 - height / 2
        t = Math.min(1, Math.max(0, (px * dx + py * dy + extent) / span))
      }
      pixels[i] = clamp255(lerp(start.r, end.r, t))
      pixels[i + 1] = clamp255(lerp(start.g, end.g, t))
      pixels[i + 2] = clamp255(lerp(start.b, end.b, t))
      pixels[i + 3] = clamp255(lerp(start.a, end.a, t))
      i += 4
    }
  }
  return pixels
}

/** 8-bit grayscale variant used for masks (from/to are gray levels). */
export function generateGrayPixels({ width, height, mode = 'solid', color, from, to, angle = 90, center, radius }) {
  const rgba = generatePixels({ width, height, mode, color, from: from ?? color, to: to ?? color, angle, center, radius })
  const gray = Buffer.alloc(width * height)
  for (let p = 0, g = 0; p < rgba.length; p += 4, g++) gray[g] = rgba[p] // use the red channel
  return gray
}
