import {FRAME_HEADER_SIZE, FRAME_OVERHEAD, MAGIC, NACK, NOTE_CMD, NOTE_RESP, encodeFrame} from '../src/frame.ts'
import type {Wire} from '../src/transport.ts'

/**
 * A wire with no device on the far end. Tests drive it with `deliver`, and
 * read what the code under test wrote from `written`.
 */
export class FakeWire implements Wire {
  readonly written: Uint8Array[] = []
  #listeners = new Set<(chunk: Uint8Array) => void>()

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(bytes.slice())
    await this.onWrite?.(bytes)
  }

  subscribe(listener: (chunk: Uint8Array) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Push bytes towards the code under test, as if the device had spoken. */
  deliver(bytes: Uint8Array): void {
    for (const listener of [...this.#listeners]) listener(bytes)
  }

  onWrite?: (bytes: Uint8Array) => void | Promise<void>

  get writtenBytes(): Uint8Array {
    const total = this.written.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Uint8Array(total)
    let at = 0
    for (const chunk of this.written) {
      merged.set(chunk, at)
      at += chunk.length
    }
    return merged
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * What both real devices now do with a command's `tag`: echo it verbatim on
 * whatever answers, a success or an error alike. Modelled here because the
 * transport filters replies by it, and a fake that answered untagged would
 * exercise only the compatibility path - the one for firmware too old to know
 * about tags - and never the correlation this exists for.
 *
 * `echoTag: false` is that older firmware, and there are tests for it.
 */
const withEchoedTag = (
  command: Record<string, unknown>,
  answer: unknown,
  echoTag: boolean
): unknown =>
  echoTag && typeof command.tag === 'string' && answer !== null && typeof answer === 'object'
    ? {...(answer as Record<string, unknown>), tag: command.tag}
    : answer

/**
 * A wire backed by a device that answers over the heartwood framing.
 *
 * It models the real firmware's intolerance: anything that is not the start of
 * a frame wedges its reader for the rest of the session. Measured 2026-08-27 -
 * after one newline-delimited probe, two further frame probes both timed out
 * and only reopening the port recovered it. A forgiving fake is what let a
 * detection-order bug reach the bench, so this one is deliberately strict.
 *
 * Note it accumulates across writes: a paced frame arrives in 64-byte chunks
 * and a chunk boundary means nothing to a device reading a byte stream.
 */
export function frameDevice(
  reply: (command: Record<string, unknown>) => unknown,
  options: {nack?: boolean; nackReason?: string; echoTag?: boolean} = {}
): FakeWire {
  const wire = new FakeWire()
  let buffer = new Uint8Array(0)
  let wedged = false

  wire.onWrite = bytes => {
    if (wedged) return
    const merged = new Uint8Array(buffer.length + bytes.length)
    merged.set(buffer, 0)
    merged.set(bytes, buffer.length)
    buffer = merged

    for (;;) {
      if (buffer.length === 0) return
      if (buffer[0] !== MAGIC[0]) {
        // Not the start of a frame, so somebody is talking the other protocol.
        wedged = true
        buffer = new Uint8Array(0)
        return
      }
      if (buffer.length < FRAME_HEADER_SIZE) return
      const length = (buffer[3]! << 8) | buffer[4]!
      const total = FRAME_OVERHEAD + length
      if (buffer.length < total) return

      const type = buffer[2]!
      const payload = buffer.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length)
      buffer = buffer.slice(total)
      if (type !== NOTE_CMD) continue
      if (options.nack === true) {
        wire.deliver(encodeFrame(NACK, encoder.encode(options.nackReason ?? 'locked')))
        continue
      }
      const command = JSON.parse(decoder.decode(payload)) as Record<string, unknown>
      const answer = withEchoedTag(command, reply(command), options.echoTag !== false)
      wire.deliver(encodeFrame(NOTE_RESP, encoder.encode(JSON.stringify(answer))))
    }
  }
  return wire
}

/** A wire backed by a device that answers over lnurl-vault's newline framing. */
export function lineDevice(
  reply: (command: Record<string, unknown>) => unknown,
  options: {echoTag?: boolean} = {}
): FakeWire {
  const wire = new FakeWire()
  let pending = ''
  wire.onWrite = bytes => {
    pending += decoder.decode(bytes)
    for (;;) {
      const at = pending.indexOf('\n')
      if (at === -1) return
      const line = pending.slice(0, at).trim()
      pending = pending.slice(at + 1)
      if (line === '') continue
      let command: Record<string, unknown>
      try {
        command = JSON.parse(line) as Record<string, unknown>
      } catch {
        // A vault resynchronises on the newline and ignores junk, so a stray
        // binary frame reaching it produces nothing at all.
        continue
      }
      const answer = withEchoedTag(command, reply(command), options.echoTag !== false)
      wire.deliver(encoder.encode(`${JSON.stringify(answer)}\n`))
    }
  }
  return wire
}
