import { deflateSync } from 'node:zlib'

/**
 * Minimal PNG encoder for 8-bit RGB images (docs/adr/1511-*): no dependency, node:zlib for the
 * deflate stream. Deterministic: no time or text chunks, so the same pixels give the same bytes
 * (tool output stays cache-friendly, docs/adr/0937-*).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length)
  return out
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Encode `rgb` (width × height × 3 bytes, row-major) as PNG. Each row takes the filter (None, Sub
 * or Up) with the smallest sum of absolute byte values, the usual cheap heuristic.
 */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3
  if (rgb.length !== stride * height) throw new Error('encodePng: buffer size does not match the dimensions')
  const raw = Buffer.alloc((stride + 1) * height)
  const sub = new Uint8Array(stride)
  const up = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const prev = row - stride
    let sNone = 0
    let sSub = 0
    let sUp = 0
    for (let i = 0; i < stride; i++) {
      const v = rgb[row + i]
      const a = i >= 3 ? rgb[row + i - 3] : 0
      const b = y > 0 ? rgb[prev + i] : 0
      const s = (v - a) & 0xff
      const u = (v - b) & 0xff
      sub[i] = s
      up[i] = u
      sNone += v < 128 ? v : 256 - v
      sSub += s < 128 ? s : 256 - s
      sUp += u < 128 ? u : 256 - u
    }
    const o = y * (stride + 1)
    if (sUp <= sSub && sUp <= sNone) {
      raw[o] = 2
      raw.set(up, o + 1)
    } else if (sSub <= sNone) {
      raw[o] = 1
      raw.set(sub, o + 1)
    } else {
      raw[o] = 0
      raw.set(rgb.subarray(row, row + stride), o + 1)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}
