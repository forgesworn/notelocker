// The two framings a note locker can speak, behind one request/response
// interface. Everything above this file works in commands, not bytes.

import {FrameDecoder, encodeFrame, NACK, NOTE_CMD, NOTE_RESP} from './frame.ts'

/** The bytes-in, bytes-out half of a serial port, injectable so tests need no hardware. */
export type Wire = {
  write(bytes: Uint8Array): Promise<void>
  /** Register a data listener; the returned function removes it. */
  subscribe(listener: (chunk: Uint8Array) => void): () => void
}

export type Response = Record<string, unknown>

export type Transport = {
  readonly kind: 'frame' | 'line'
  request(command: Record<string, unknown>, timeoutMs: number): Promise<Response>
}

export class TransportError extends Error {}
export class TimeoutError extends TransportError {}
/**
 * The device answered, and refused. Distinct from the other two because it is
 * a positive identification: only a heartwood NACKs, so detection must stop
 * here and say so rather than shrug and try the other framing.
 *
 * `reason` is the device's own words, carried in the NACK payload. Do not
 * guess it: the two reasons seen on real firmware mean opposite things.
 * "locked" is fixed by unlocking, while "use heartwood_note_* over the relay"
 * means this build never serves note commands over USB at all and no amount
 * of unlocking will change that.
 */
export class DeviceRefusedError extends TransportError {
  readonly reason: string

  constructor(reason: string) {
    super(reason === '' ? 'device refused the command (no reason given)' : `device refused the command: ${reason}`)
    this.reason = reason
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// A frame larger than the firmware's receive ring, burst in one host write,
// loses bytes. heartwoodd/src/serial.rs paces those writes and this mirrors it:
// past 512 bytes, go 64 at a time, slowly until the firmware has drained its
// first 3 KiB and is sitting in its blocking frame reader, then faster.
const PACE_THRESHOLD = 512
const PACE_CHUNK = 64
const PACE_HEAD_BYTES = 3_072
const PACE_HEAD_GAP_MS = 24
const PACE_GAP_MS = 6

// Long enough for a vault to consume the flush newline and resynchronise
// before the next command lands on its input buffer.
const FLUSH_SETTLE_MS = 150

// How many times the framed probe is tried before the line probe - the
// unrecoverable one - gets a turn. See detectTransport.
const FRAME_PROBE_ATTEMPTS = 2

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Both devices accept a `tag` on any command and echo it verbatim on whatever
// answers it: lnurl-vault since dni/lnurl-vault#127, heartwood since its own
// port of the same change. A non-empty string of at most 32 BYTES, which is
// the vault's fixed buffer and therefore the smaller of the two limits.
//
// The wire carries no request ids otherwise, so a reply that is never coming
// is indistinguishable from a slow one, and a late reply from the reply to the
// next command. That is why detectTransport's probes are ordered around which
// framing's failure is repairable rather than around which is likelier: a
// straggler had no way of being recognised as one. With a tag it does.
//
// Kept short deliberately - it is only ever compared to itself, never
// displayed, and every byte of it crosses a serial link that is slow enough
// for the size to matter on the paced path.
const TAG_MAX_BYTES = 32
let tagCounter = 0
const nextTag = (): string => `n${(tagCounter = (tagCounter + 1) % 1_000_000).toString(36)}`

/**
 * Whether `reply` answers the command sent under `tag`.
 *
 * An untagged reply is accepted, and has to be: firmware older than the tag
 * echo ignores the field entirely and answers as it always did, and so does
 * either device when the line it received could not be parsed as JSON at all.
 * For those the old rule stands - one command in flight, a timeout is fatal -
 * which is no worse than before tags existed.
 *
 * A reply carrying a DIFFERENT tag is a straggler from a command that already
 * timed out. That is the whole point: it is skipped rather than mistaken for
 * this command's answer, and the wait continues.
 */
const answersTag = (reply: Response, tag: string): boolean =>
  typeof reply.tag !== 'string' || reply.tag === tag

/**
 * The echoed tag, removed before the reply goes up.
 *
 * It is correlation plumbing and nothing else: this layer attached it, this
 * layer has now used it, and everything above works in commands rather than
 * bytes. Leaving it on would put a field in every response that no caller
 * asked for and that changes on every request - the sort of thing that ends up
 * in a snapshot test or, worse, on a screen.
 */
const withoutTag = (reply: Response): Response => {
  if (!('tag' in reply)) return reply
  const {tag: _tag, ...rest} = reply
  return rest
}

/**
 * The command as it goes on the wire, and the tag the reply must carry.
 *
 * Returned together on purpose: a caller may set its own `tag`, and matching
 * the reply against a generated one that was never sent would discard the
 * right answer and wait for a reply nobody is going to send. One value,
 * decided in one place.
 *
 * A caller's own tag has to survive the round trip to be worth anything, and
 * both devices refuse one they cannot echo as given rather than echoing it
 * truncated. Caught here so the message names the rule, instead of arriving as
 * a bare `bad_request` from a device that never ran the command.
 */
const tagged = (
  command: Record<string, unknown>,
  generated: string
): {command: Record<string, unknown>; tag: string} => {
  const own = command.tag
  if (own === undefined) return {command: {...command, tag: generated}, tag: generated}
  if (typeof own !== 'string' || own.length === 0 || encoder.encode(own).length > TAG_MAX_BYTES) {
    throw new TransportError(
      `tag must be a non-empty string of at most ${TAG_MAX_BYTES} bytes - the device refuses any other`
    )
  }
  return {command, tag: own}
}

async function writePaced(wire: Wire, bytes: Uint8Array): Promise<void> {
  if (bytes.length <= PACE_THRESHOLD) {
    await wire.write(bytes)
    return
  }
  for (let offset = 0; offset < bytes.length; offset += PACE_CHUNK) {
    await wire.write(bytes.subarray(offset, offset + PACE_CHUNK))
    if (offset + PACE_CHUNK < bytes.length) {
      await sleep(offset < PACE_HEAD_BYTES ? PACE_HEAD_GAP_MS : PACE_GAP_MS)
    }
  }
}

/**
 * Wait for the first thing `extract` turns into a response, or time out.
 * Both transports share this shape; only the parsing differs.
 */
function awaitReply(
  wire: Wire,
  timeoutMs: number,
  extract: (chunk: Uint8Array) => Response | undefined
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      unsubscribe()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new TimeoutError(`no reply in ${timeoutMs}ms`))),
      timeoutMs
    )
    const unsubscribe = wire.subscribe(chunk => {
      let found: Response | undefined
      try {
        found = extract(chunk)
      } catch (err) {
        finish(() => reject(err))
        return
      }
      if (found !== undefined) finish(() => resolve(found))
    })
  })
}

/** heartwood-class: one NOTE_CMD frame out, one NOTE_RESP frame back. */
export function frameTransport(wire: Wire): Transport {
  return {
    kind: 'frame',
    async request(raw, timeoutMs) {
      const {command, tag} = tagged(raw, nextTag())
      const decode = new FrameDecoder()
      const reply = awaitReply(wire, timeoutMs, chunk => {
        for (const frame of decode.push(chunk)) {
          if (frame.type === NACK) {
            throw new DeviceRefusedError(decoder.decode(frame.payload).trim())
          }
          if (frame.type !== NOTE_RESP) continue
          if (!frame.crcOk) throw new TransportError('reply failed its CRC - the serial link is corrupting bytes')
          const parsed = parseJson(decoder.decode(frame.payload))
          if (answersTag(parsed, tag)) return withoutTag(parsed)
        }
        return undefined
      })
      await writePaced(wire, encodeFrame(NOTE_CMD, encoder.encode(JSON.stringify(command))))
      return reply
    }
  }
}

/** lnurl-vault: one JSON object per line in, one per line out. */
export function lineTransport(wire: Wire): Transport {
  return {
    kind: 'line',
    async request(raw, timeoutMs) {
      const {command, tag} = tagged(raw, nextTag())
      let pending = ''
      const reply = awaitReply(wire, timeoutMs, chunk => {
        pending += decoder.decode(chunk, {stream: true})
        for (;;) {
          const at = pending.search(/[\r\n]/)
          if (at === -1) return undefined
          const line = pending.slice(0, at).trim()
          pending = pending.slice(at + 1)
          // The device logs to the same link on some builds, so skip anything
          // that is not a JSON object rather than failing on the first one.
          if (!line.startsWith('{')) continue
          const parsed = parseJson(line)
          if (answersTag(parsed, tag)) return withoutTag(parsed)
        }
      })
      await writePaced(wire, encoder.encode(`${JSON.stringify(command)}\n`))
      return reply
    }
  }
}

function parseJson(text: string): Response {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new TransportError(`device replied with something that is not JSON: ${text.slice(0, 120)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TransportError(`device replied with ${Array.isArray(value) ? 'an array' : typeof value}, expected an object`)
  }
  return value as Response
}

/**
 * Work out which framing is on the other end by asking for `get_info` each way.
 *
 * Frame first, and the order is not a preference - it is the only safe one.
 * Measured on real hardware 2026-08-27:
 *
 * - A heartwood that receives newline-delimited JSON stops answering framed
 *   commands **for the rest of the session**. Two further frame probes after
 *   one line probe both timed out; only reopening the port recovered it. So a
 *   line probe sent first does not just fail, it destroys the fallback.
 * - A vault that receives a frame is only poisoned until the next newline,
 *   because it reads to one and resynchronises. That damage is repairable, so
 *   this sends a flush newline between the probes to repair it.
 *
 * Unrecoverable beats recoverable: probe the framing whose failure can be
 * cleaned up after, second.
 */
export async function detectTransport(wire: Wire, probeMs = 1_500): Promise<Transport> {
  const frame = frameTransport(wire)
  // Twice, before the line probe gets a turn. Measured on hardware
  // 2026-09-06: a heartwood that has just been unlocked spends a while
  // finishing its boot, and one probe of 1.5 s times out against a device that
  // is merely busy. That timeout is not the expensive part - the LINE probe
  // behind it is, because a heartwood that receives newline-delimited JSON
  // stops answering framed commands for the rest of the session. So a device
  // that only needed another second answers "no note locker answered on either
  // framing" and stays wedged until the port is reopened, which is exactly
  // what happened on the bench and exactly the wrong story to tell.
  //
  // The frame probe is the safe one to repeat: a vault ignores a frame and
  // resynchronises on the next newline, and a heartwood answers it. So it gets
  // its second chance before anything unrecoverable is sent.
  for (let attempt = 0; attempt < FRAME_PROBE_ATTEMPTS; attempt += 1) {
    try {
      await frame.request({cmd: 'get_info'}, probeMs)
      return frame
    } catch (err) {
      // A NACK means we found the device and it declined. Falling through
      // would replace its own explanation with "nothing answered", which sends
      // you hunting for a cable fault when the device already told you the
      // reason. Retrying would be just as wrong: it declined, it will decline
      // again.
      if (err instanceof DeviceRefusedError) throw err
      if (!(err instanceof TransportError)) throw err
    }
  }

  // Terminate the line the frame probe left dangling in a vault's buffer, and
  // give it a moment to drain before asking anything real.
  await wire.write(encoder.encode('\n'))
  await sleep(FLUSH_SETTLE_MS)

  const line = lineTransport(wire)
  try {
    await line.request({cmd: 'get_info'}, probeMs)
    return line
  } catch (err) {
    if (!(err instanceof TransportError)) throw err
  }

  throw new TransportError(
    'no note locker answered get_info on either framing - check the port, that the device is unlocked, and that nothing else holds the port'
  )
}
