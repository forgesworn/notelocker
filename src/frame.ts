// The binary framing a heartwood-class device speaks on its serial link.
//
//   [0x48 0x57] [type u8] [length u16 BE] [payload] [crc32 u32 BE]
//
// The CRC covers the type byte, the length bytes and the payload, but NOT the
// magic. heartwood-esp32's `common/src/frame.rs` is the authority for this;
// keep the two in step. An lnurl-vault needs none of it - see `line.ts` - so
// nothing here is imported on that path.

export const MAGIC = Uint8Array.of(0x48, 0x57)
export const FRAME_HEADER_SIZE = 5
export const FRAME_OVERHEAD = FRAME_HEADER_SIZE + 4
export const MAX_PAYLOAD_SIZE = 32_768

export const NOTE_CMD = 0x70
export const NOTE_RESP = 0x71
export const NACK = 0x15

export class FrameError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE, reflected) - the same one `crc32fast` computes device-side. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new FrameError(`payload is ${payload.length} bytes, the device accepts at most ${MAX_PAYLOAD_SIZE}`)
  }
  const checked = new Uint8Array(3 + payload.length)
  checked[0] = type
  checked[1] = (payload.length >> 8) & 0xff
  checked[2] = payload.length & 0xff
  checked.set(payload, 3)

  const crc = crc32(checked)
  const frame = new Uint8Array(FRAME_OVERHEAD + payload.length)
  frame.set(MAGIC, 0)
  frame.set(checked, MAGIC.length)
  const tail = MAGIC.length + checked.length
  frame[tail] = (crc >>> 24) & 0xff
  frame[tail + 1] = (crc >>> 16) & 0xff
  frame[tail + 2] = (crc >>> 8) & 0xff
  frame[tail + 3] = crc & 0xff
  return frame
}

export type DecodedFrame = {
  type: number
  payload: Uint8Array
  /** False when the trailing CRC did not match what we computed. */
  crcOk: boolean
}

/**
 * Incremental reader: serial data arrives in arbitrary chunks, so a frame can
 * straddle several `push` calls and one call can carry several frames.
 *
 * A bad CRC is reported on the frame rather than thrown. Throwing would kill
 * the read loop on one corrupt byte, and silently dropping would turn a real
 * wire fault into an unexplained timeout - neither is debuggable at 3am on a
 * bench. The caller decides what a `crcOk: false` frame is worth.
 */
export class FrameDecoder {
  #buffer = new Uint8Array(0)

  push(chunk: Uint8Array): DecodedFrame[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length)
    merged.set(this.#buffer, 0)
    merged.set(chunk, this.#buffer.length)
    this.#buffer = merged

    const frames: DecodedFrame[] = []
    for (;;) {
      const start = indexOfMagic(this.#buffer)
      if (start === -1) {
        // Keep only a trailing byte that could be the first half of the magic.
        const keep = this.#buffer.length > 0 && this.#buffer[this.#buffer.length - 1] === MAGIC[0] ? 1 : 0
        this.#buffer = this.#buffer.subarray(this.#buffer.length - keep)
        return frames
      }
      if (start > 0) this.#buffer = this.#buffer.subarray(start)
      if (this.#buffer.length < FRAME_HEADER_SIZE) return frames

      const type = this.#buffer[2]!
      const length = (this.#buffer[3]! << 8) | this.#buffer[4]!
      if (length > MAX_PAYLOAD_SIZE) {
        // Not a real header - resynchronise past this magic and keep looking.
        this.#buffer = this.#buffer.subarray(1)
        continue
      }
      const total = FRAME_OVERHEAD + length
      if (this.#buffer.length < total) return frames

      const payload = this.#buffer.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length)
      const checked = this.#buffer.subarray(2, FRAME_HEADER_SIZE + length)
      const at = FRAME_HEADER_SIZE + length
      const stated =
        ((this.#buffer[at]! << 24) | (this.#buffer[at + 1]! << 16) | (this.#buffer[at + 2]! << 8) | this.#buffer[at + 3]!) >>> 0

      frames.push({type, payload, crcOk: crc32(checked) === stated})
      this.#buffer = this.#buffer.subarray(total)
    }
  }
}

function indexOfMagic(buffer: Uint8Array): number {
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1]) return i
  }
  return -1
}
