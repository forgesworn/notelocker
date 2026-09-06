#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {COMMANDS, UsageError, lookup, timeoutFor, type Flags} from './protocol.ts'
import {CANDIDATE_VENDOR_IDS, PortError, candidates, choosePort, listPorts, openPort} from './port.ts'
import {TransportError, detectTransport, frameTransport, lineTransport, type Transport} from './transport.ts'

const HELP = `notelocker - drive an LNURLcash bearer-note locker over USB

  notelocker ports                     list attached candidate devices
  notelocker raw '<json>'              send one raw protocol command

${Object.entries(COMMANDS)
  .map(([name, spec]) => `  ${spec.usage.padEnd(62)}${spec.gated ? 'needs the button' : ''}`.trimEnd())
  .join('\n')}

Options
  --port <path>        serial port; required only when more than one candidate is attached
  --transport <kind>   auto (default), frame (heartwood) or line (lnurl-vault)
  --timeout <ms>       override the reply timeout
  --json               print the device's reply verbatim as JSON
  --help

The command set is lnurl-vault's docs/PROTOCOL.md. A heartwood implements the
same commands over a different framing, which --transport auto works out for
itself. Only "reset" is lnurl-vault specific; a heartwood answers bad_request.

Commands marked "needs the button" raise a card on the device and wait up to
30s for a physical confirmation, so they use a longer timeout.`

async function main(argv: string[]): Promise<number> {
  const {values, positionals} = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: {type: 'string'},
      transport: {type: 'string'},
      timeout: {type: 'string'},
      json: {type: 'boolean'},
      help: {type: 'boolean'},
      label: {type: 'string'},
      parents: {type: 'string'},
      offset: {type: 'string'},
      limit: {type: 'string'},
      amount: {type: 'string'},
      host: {type: 'string'},
      sig: {type: 'string'},
      secret: {type: 'string'}
    }
  })

  const [name, ...rest] = positionals
  if (values.help === true || name === undefined) {
    console.log(HELP)
    return name === undefined && values.help !== true ? 2 : 0
  }

  if (name === 'ports') {
    const ports = await listPorts()
    const found = candidates(ports)
    if (values.json === true) {
      console.log(JSON.stringify(found, null, 2))
      return found.length > 0 ? 0 : 1
    }
    if (found.length === 0) {
      console.log('No candidate devices attached.')
      console.log(`Looked for: ${Object.values(CANDIDATE_VENDOR_IDS).join(', ')}.`)
      return 1
    }
    for (const port of found) {
      const vendor = port.vendorId === undefined ? 'unknown' : (CANDIDATE_VENDOR_IDS[port.vendorId] ?? port.vendorId)
      console.log(`${port.path}  ${vendor}${port.serialNumber === undefined ? '' : `  ${port.serialNumber}`}`)
    }
    return 0
  }

  const command = name === 'raw' ? rawCommand(rest) : lookup(name).build(rest, values as Flags)
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout)
  if (timeout !== undefined && !Number.isFinite(timeout)) throw new UsageError('--timeout must be a number of milliseconds')

  const path = choosePort(await listPorts(), values.port)
  const wire = await openPort(path)
  try {
    const transport = await pickTransport(wire, values.transport)
    const reply = await transport.request(command, timeout ?? (name === 'raw' ? 40_000 : timeoutFor(lookup(name))))
    render(name, reply, values.json === true)
    return reply['ok'] === false ? 1 : 0
  } finally {
    await wire.close()
  }
}

function rawCommand(rest: readonly string[]): Record<string, unknown> {
  const text = rest[0]
  if (text === undefined) throw new UsageError(`usage: notelocker raw '{"cmd":"get_info"}'`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new UsageError(`that is not valid JSON: ${text}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError('a raw command must be a JSON object')
  }
  if (typeof (value as Record<string, unknown>)['cmd'] !== 'string') {
    throw new UsageError('a raw command needs a "cmd" string')
  }
  return value as Record<string, unknown>
}

async function pickTransport(wire: Awaited<ReturnType<typeof openPort>>, requested?: string): Promise<Transport> {
  switch (requested) {
    case undefined:
    case 'auto':
      return detectTransport(wire)
    case 'frame':
      return frameTransport(wire)
    case 'line':
      return lineTransport(wire)
    default:
      throw new UsageError(`--transport must be auto, frame or line, got ${requested}`)
  }
}

function render(name: string, reply: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(reply, null, 2))
    return
  }
  if (reply['ok'] === false) {
    const message = reply['message']
    console.error(`${reply['error'] ?? 'error'}${typeof message === 'string' ? ` - ${message}` : ''}`)
    return
  }
  if (name === 'list') {
    const notes = reply['notes']
    if (!Array.isArray(notes) || notes.length === 0) {
      console.log('No notes.')
      return
    }
    const rows = (notes as Record<string, unknown>[]).map(note => [
      String(note['id'] ?? '-'),
      String(note['state'] ?? '-'),
      typeof note['amount_msat'] === 'number' ? `${(note['amount_msat'] / 1000).toFixed(3)} sat` : '-',
      String(note['label'] || '-'),
      String(note['host'] || '-')
    ])
    const widths = rows.reduce(
      (widest, row) => row.map((cell, at) => Math.max(widest[at] ?? 0, cell.length)),
      [] as number[]
    )
    for (const row of rows) {
      console.log(row.map((cell, at) => (at === row.length - 1 ? cell : cell.padEnd(widths[at]!))).join('  '))
    }
    // The device sends next_offset only when there is more to fetch, so use
    // that rather than comparing counts: on the last page total still exceeds
    // the rows shown, and offering to page there reads like a bug.
    const total = reply['total']
    const next = reply['next_offset']
    if (typeof next === 'number') {
      const of = typeof total === 'number' ? ` of ${total}` : ''
      console.log(`(${notes.length}${of} - more with --offset ${next})`)
    }
    return
  }
  const keys = Object.keys(reply).filter(key => key !== 'ok')
  // Pad to the widest key actually present, not a guessed constant: a vault
  // answers get_info with last_boot_unexpected, which ran straight into its
  // value at any fixed width.
  const width = Math.max(0, ...keys.map(key => key.length)) + 2
  for (const key of keys) {
    const value = reply[key]
    console.log(`${key.padEnd(width)}${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  if (err instanceof UsageError || err instanceof PortError || err instanceof TransportError) {
    console.error(err.message)
    process.exitCode = 2
  } else {
    throw err
  }
}
