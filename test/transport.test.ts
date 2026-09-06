import {describe, expect, it} from 'vitest'
import {FrameDecoder, NOTE_CMD} from '../src/frame.ts'
import {DeviceRefusedError, TimeoutError, TransportError, detectTransport, frameTransport, lineTransport} from '../src/transport.ts'
import {FakeWire, frameDevice, lineDevice} from './wire.ts'

const decoder = new TextDecoder()

describe('frameTransport', () => {
  it('round-trips a command and its reply', async () => {
    const wire = frameDevice(() => ({ok: true, fw_version: '1.2.3', note_count: 2}))
    const reply = await frameTransport(wire).request({cmd: 'get_info'}, 1_000)
    expect(reply).toEqual({ok: true, fw_version: '1.2.3', note_count: 2})
  })

  it('sends the command as a NOTE_CMD frame', async () => {
    const wire = frameDevice(() => ({ok: true}))
    await frameTransport(wire).request({cmd: 'get_info'}, 1_000)
    const frames = new FrameDecoder().push(wire.writtenBytes)
    expect(frames[0]!.type).toBe(NOTE_CMD)
    // plus the correlation tag the transport attaches to every command
    expect(JSON.parse(decoder.decode(frames[0]!.payload))).toMatchObject({cmd: 'get_info'})
  })

  it("reports the device's own NACK reason, not a guess", async () => {
    // Real firmware sends two very different reasons down this path: "locked"
    // is fixed by unlocking, while "use heartwood_note_* over the relay" means
    // the build never serves note commands over USB at all. A tool that
    // guessed "locked" would send you unlocking a device forever.
    const wire = frameDevice(() => ({ok: true}), {nack: true, nackReason: 'use heartwood_note_* over the relay'})
    await expect(frameTransport(wire).request({cmd: 'get_info'}, 1_000)).rejects.toThrow(
      /use heartwood_note_\* over the relay/
    )
  })

  it('still says something useful when the NACK carries no reason', async () => {
    const wire = frameDevice(() => ({ok: true}), {nack: true, nackReason: ''})
    await expect(frameTransport(wire).request({cmd: 'get_info'}, 1_000)).rejects.toThrow(/no reason given/)
  })

  it('times out when nothing answers', async () => {
    await expect(frameTransport(new FakeWire()).request({cmd: 'get_info'}, 50)).rejects.toThrow(TimeoutError)
  })

  it('paces a large frame into chunks rather than one burst', async () => {
    // A single big write overruns the firmware's receive ring and loses bytes.
    const wire = frameDevice(() => ({ok: true}))
    await frameTransport(wire).request({cmd: 'import_secret', label: 'x'.repeat(2_000)}, 5_000)
    expect(wire.written.length).toBeGreaterThan(1)
    expect(Math.max(...wire.written.map(chunk => chunk.length))).toBeLessThanOrEqual(64)
  })
})

describe('lineTransport', () => {
  it('round-trips a command and its reply', async () => {
    const wire = lineDevice(() => ({ok: true, fw_version: '26.06'}))
    expect(await lineTransport(wire).request({cmd: 'get_info'}, 1_000)).toEqual({ok: true, fw_version: '26.06'})
  })

  it('writes one JSON object per line', async () => {
    const wire = lineDevice(() => ({ok: true}))
    await lineTransport(wire).request({cmd: 'get_info'}, 1_000)
    const written = decoder.decode(wire.writtenBytes)
    expect(written.endsWith('\n')).toBe(true)
    expect(JSON.parse(written)).toMatchObject({cmd: 'get_info'})
  })

  it('skips log chatter before the reply', async () => {
    const wire = new FakeWire()
    const pending = lineTransport(wire).request({cmd: 'get_info'}, 1_000)
    wire.deliver(new TextEncoder().encode('booting\nstorage ok\n{"ok":true,"note_count":0}\n'))
    expect(await pending).toEqual({ok: true, note_count: 0})
  })

  it('reassembles a reply split across chunks', async () => {
    const wire = new FakeWire()
    const pending = lineTransport(wire).request({cmd: 'get_info'}, 1_000)
    wire.deliver(new TextEncoder().encode('{"ok":true,'))
    wire.deliver(new TextEncoder().encode('"note_count":3}\n'))
    expect(await pending).toEqual({ok: true, note_count: 3})
  })

  it('rejects a reply that is not JSON at all', async () => {
    const wire = new FakeWire()
    const pending = lineTransport(wire).request({cmd: 'get_info'}, 1_000)
    wire.deliver(new TextEncoder().encode('{not json}\n'))
    await expect(pending).rejects.toThrow(TransportError)
  })
})

describe('detectTransport', () => {
  it('finds a heartwood', async () => {
    const transport = await detectTransport(frameDevice(() => ({ok: true})), 200)
    expect(transport.kind).toBe('frame')
  })

  it('finds an lnurl-vault', async () => {
    // The vault ignores the framed probe entirely, so detection has to fall
    // through to the newline framing rather than give up.
    const transport = await detectTransport(lineDevice(() => ({ok: true})), 200)
    expect(transport.kind).toBe('line')
  })

  it('probes the framed protocol first, because that failure is the recoverable one', async () => {
    // Measured on hardware: a line probe wedges a heartwood's frame reader for
    // the whole session, while a frame probe only poisons a vault until the
    // next newline. So the frame probe goes first and a flush repairs the
    // vault before the line probe. Pin the order; getting it wrong costs a
    // bench session.
    const wire = lineDevice(() => ({ok: true}))
    const transport = await detectTransport(wire, 200)
    expect(transport.kind).toBe('line')
    const written = decoder.decode(wire.writtenBytes)
    expect(written.indexOf('HW')).toBeLessThan(written.indexOf('{"cmd":"get_info"'))
    // the flush newline, then the line probe and nothing after it
    const [flushed, probe] = [written.lastIndexOf('\n{'), written.slice(written.lastIndexOf('\n{') + 1)]
    expect(flushed).toBeGreaterThan(0)
    expect(JSON.parse(probe)).toMatchObject({cmd: 'get_info'})
  })

  it('does not wedge a heartwood by probing the wrong framing first', async () => {
    const wire = frameDevice(() => ({ok: true, fw_version: '0.0.9'}))
    const transport = await detectTransport(wire, 200)
    expect(transport.kind).toBe('frame')
    // Nothing but frames reached the device, so its reader is still alive.
    expect(await transport.request({cmd: 'get_info'}, 200)).toMatchObject({ok: true})
  })

  it('stops on a NACK instead of blaming the cable', async () => {
    // A locked heartwood is found, not absent. Falling through to the line
    // framing would report "nothing answered" and send you after a cable
    // fault when the fix is to unlock the device. Seen on real hardware.
    const wire = frameDevice(() => ({ok: true}), {nack: true})
    await expect(detectTransport(wire, 200)).rejects.toThrow(DeviceRefusedError)
  })

  it('says so when nothing is listening', async () => {
    await expect(detectTransport(new FakeWire(), 50)).rejects.toThrow(/no note locker answered/)
  })
})

// ---- the correlation tag ----
//
// Both devices echo a command's `tag` on whatever answers it. Without one, a
// reply that is never coming is indistinguishable from a slow one, and a late
// reply from the reply to the next command - which is why a timeout had to be
// fatal on both sides of this link.

describe('the correlation tag', () => {
  it('tags every command, and never twice with the same one', async () => {
    const seen: unknown[] = []
    const wire = lineDevice(command => {
      seen.push(command.tag)
      return {ok: true}
    })
    const transport = lineTransport(wire)
    await transport.request({cmd: 'get_info'}, 1_000)
    await transport.request({cmd: 'get_info'}, 1_000)
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    for (const tag of seen) {
      expect(typeof tag).toBe('string')
      expect(new TextEncoder().encode(tag as string).length).toBeGreaterThan(0)
      expect(new TextEncoder().encode(tag as string).length).toBeLessThanOrEqual(32)
    }
  })

  it('does not hand the tag up to the caller', async () => {
    // Correlation plumbing. A field that changes on every request has no
    // business in what a command returns.
    const wire = lineDevice(() => ({ok: true, note_count: 0}))
    expect(await lineTransport(wire).request({cmd: 'get_info'}, 1_000)).toEqual({ok: true, note_count: 0})
  })

  it('skips a straggler from a command that already timed out', async () => {
    // The whole point. The first reply carries a tag from a command this
    // request never sent, so it is not this request's answer and the wait
    // continues - where before it would have been taken for one and returned
    // the wrong note's worth of information.
    const wire = new FakeWire()
    const encode = new TextEncoder()
    let ours: string | undefined
    wire.onWrite = bytes => {
      ours = JSON.parse(decoder.decode(bytes)).tag
      wire.deliver(encode.encode('{"ok":true,"note_count":99,"tag":"stale"}\n'))
      wire.deliver(encode.encode(`{"ok":true,"note_count":3,"tag":${JSON.stringify(ours)}}\n`))
    }
    expect(await lineTransport(wire).request({cmd: 'get_info'}, 1_000)).toEqual({ok: true, note_count: 3})
  })

  it('still accepts an untagged reply, for firmware that predates the echo', async () => {
    // Older firmware ignores the field and answers as it always did. Refusing
    // that reply would turn a working device into a broken one on upgrade of
    // the CLI alone.
    const wire = lineDevice(() => ({ok: true, fw_version: '26.06'}), {echoTag: false})
    expect(await lineTransport(wire).request({cmd: 'get_info'}, 1_000)).toEqual({ok: true, fw_version: '26.06'})
  })

  it('accepts an untagged reply over the framing too', async () => {
    const wire = frameDevice(() => ({ok: true, fw_version: '0.0.9'}), {echoTag: false})
    expect(await frameTransport(wire).request({cmd: 'get_info'}, 1_000)).toEqual({ok: true, fw_version: '0.0.9'})
  })

  it("refuses a caller's own tag that the device would reject", async () => {
    // Caught here rather than arriving as a bare bad_request from a device
    // that never ran the command: both refuse a tag they cannot echo as given.
    const wire = lineDevice(() => ({ok: true}))
    const transport = lineTransport(wire)
    for (const bad of ['', 't'.repeat(33), '🔑'.repeat(9)]) {
      // Named rather than by class: TimeoutError is a TransportError too, so
      // `toThrow(TransportError)` would pass on the exact bug this guards -
      // a tag sent but never matched, waiting out the clock.
      await expect(transport.request({cmd: 'get_info', tag: bad}, 1_000)).rejects.toThrow(
        /tag must be a non-empty string of at most 32 bytes/
      )
    }
    // and one that fits is sent through untouched
    const seen: unknown[] = []
    const echo = lineDevice(command => {
      seen.push(command.tag)
      return {ok: true}
    })
    await lineTransport(echo).request({cmd: 'get_info', tag: 'mine'}, 1_000)
    expect(seen).toEqual(['mine'])
  })
})
