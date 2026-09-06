import {describe, expect, it} from 'vitest'
import {
  FrameDecoder,
  FrameError,
  MAX_PAYLOAD_SIZE,
  NOTE_CMD,
  NOTE_RESP,
  crc32,
  encodeFrame
} from '../src/frame.ts'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The CRC-32 (IEEE) check vector. If this ever drifts, the device stops
    // accepting our frames, so it is worth pinning rather than round-tripping
    // against ourselves.
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for no input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('encodeFrame', () => {
  it('lays the frame out as the firmware expects', () => {
    const frame = encodeFrame(NOTE_CMD, bytes('hi'))
    expect(frame.length).toBe(9 + 2)
    expect([...frame.subarray(0, 5)]).toEqual([0x48, 0x57, 0x70, 0x00, 0x02])
    expect([...frame.subarray(5, 7)]).toEqual([...bytes('hi')])
  })

  it('covers type and length in the CRC but not the magic', () => {
    const payload = bytes('hi')
    const frame = encodeFrame(NOTE_CMD, payload)
    const checked = new Uint8Array([NOTE_CMD, 0x00, 0x02, ...payload])
    const view = new DataView(frame.buffer, frame.byteOffset)
    expect(view.getUint32(frame.length - 4)).toBe(crc32(checked))
  })

  it('refuses a payload the device could not hold', () => {
    expect(() => encodeFrame(NOTE_CMD, new Uint8Array(MAX_PAYLOAD_SIZE + 1))).toThrow(FrameError)
  })
})

describe('FrameDecoder', () => {
  it('reads back what encodeFrame wrote', () => {
    const decoder = new FrameDecoder()
    const frames = decoder.push(encodeFrame(NOTE_RESP, bytes('{"ok":true}')))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(NOTE_RESP)
    expect(frames[0]!.crcOk).toBe(true)
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe('{"ok":true}')
  })

  it('reassembles a frame split across chunks', () => {
    const frame = encodeFrame(NOTE_RESP, bytes('{"ok":true}'))
    const decoder = new FrameDecoder()
    for (const byte of frame.subarray(0, frame.length - 1)) {
      expect(decoder.push(Uint8Array.of(byte))).toHaveLength(0)
    }
    expect(decoder.push(frame.subarray(frame.length - 1))).toHaveLength(1)
  })

  it('returns several frames arriving in one chunk', () => {
    const a = encodeFrame(NOTE_RESP, bytes('{"a":1}'))
    const b = encodeFrame(NOTE_RESP, bytes('{"b":2}'))
    const together = new Uint8Array(a.length + b.length)
    together.set(a, 0)
    together.set(b, a.length)
    expect(new FrameDecoder().push(together)).toHaveLength(2)
  })

  it('resynchronises past leading junk', () => {
    // Boot chatter and log lines share the link, so the reader has to skip to
    // the magic rather than give up on the first byte that is not one.
    const frame = encodeFrame(NOTE_RESP, bytes('{"ok":true}'))
    const noisy = new Uint8Array(bytes('boot: ready\n').length + frame.length)
    noisy.set(bytes('boot: ready\n'), 0)
    noisy.set(frame, bytes('boot: ready\n').length)
    expect(new FrameDecoder().push(noisy)).toHaveLength(1)
  })

  it('flags a corrupt frame rather than dropping or throwing', () => {
    const frame = encodeFrame(NOTE_RESP, bytes('{"ok":true}'))
    frame[frame.length - 1] = (frame[frame.length - 1]! ^ 0xff) & 0xff
    const frames = new FrameDecoder().push(frame)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.crcOk).toBe(false)
  })

  it('does not stall on a false magic inside noise', () => {
    // 0x48 0x57 with an absurd length is not a header; skipping it must not
    // consume the real frame that follows.
    const frame = encodeFrame(NOTE_RESP, bytes('{"ok":true}'))
    const decoy = Uint8Array.of(0x48, 0x57, 0x70, 0xff, 0xff)
    const noisy = new Uint8Array(decoy.length + frame.length)
    noisy.set(decoy, 0)
    noisy.set(frame, decoy.length)
    expect(new FrameDecoder().push(noisy)).toHaveLength(1)
  })

  it('keeps a trailing half-magic for the next chunk', () => {
    const frame = encodeFrame(NOTE_RESP, bytes('{"ok":true}'))
    const decoder = new FrameDecoder()
    expect(decoder.push(frame.subarray(0, 1))).toHaveLength(0)
    expect(decoder.push(frame.subarray(1))).toHaveLength(1)
  })
})
