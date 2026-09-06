// Finding a device and turning its serial port into a `Wire`.
//
// `serialport` is a native module, so it is imported lazily: the codecs and the
// command table stay usable (and testable) on a machine that never built it.

import type {Wire} from './transport.ts'

export const BAUD_RATE = 115_200

/**
 * USB vendor IDs worth offering as a note locker.
 *
 * dni's web console filters on Espressif's native-USB VID alone, which is
 * right for a vault. It is too narrow here: a Heltec V3 reaches the host
 * through a CP210x and a good many ESP32 boards through a CH340, so a
 * heartwood on one of those would simply not appear.
 */
export const CANDIDATE_VENDOR_IDS: Readonly<Record<string, string>> = {
  '303a': 'Espressif (native USB)',
  '10c4': 'Silicon Labs CP210x',
  '1a86': 'QinHeng CH340/CH9102',
  '0403': 'FTDI'
}

export type PortInfo = {
  path: string
  vendorId?: string
  productId?: string
  manufacturer?: string
  serialNumber?: string
}

export class PortError extends Error {}

async function serialport() {
  try {
    return await import('serialport')
  } catch (err) {
    throw new PortError(
      `cannot load the serialport native module (${err instanceof Error ? err.message : String(err)}). ` +
        'It ships prebuilt binaries for current Node on macOS, Linux and Windows; on anything else it needs a toolchain to build.'
    )
  }
}

export async function listPorts(): Promise<PortInfo[]> {
  const {SerialPort} = await serialport()
  const ports = await SerialPort.list()
  return ports.map(port => ({
    path: port.path,
    ...(port.vendorId === undefined ? {} : {vendorId: port.vendorId.toLowerCase()}),
    ...(port.productId === undefined ? {} : {productId: port.productId.toLowerCase()}),
    ...(port.manufacturer === undefined ? {} : {manufacturer: port.manufacturer}),
    ...(port.serialNumber === undefined ? {} : {serialNumber: port.serialNumber})
  }))
}

export function candidates(ports: readonly PortInfo[]): PortInfo[] {
  return ports.filter(port => port.vendorId !== undefined && port.vendorId in CANDIDATE_VENDOR_IDS)
}

/**
 * Pick the port to talk to. An explicit `--port` always wins; otherwise there
 * must be exactly one candidate, because guessing between two attached boards
 * is how you drive a command into the wrong device.
 */
export function choosePort(ports: readonly PortInfo[], requested?: string): string {
  if (requested !== undefined && requested !== '') return requested
  const found = candidates(ports)
  if (found.length === 1) return found[0]!.path
  if (found.length === 0) {
    throw new PortError('no candidate device found - plug one in, or name the port with --port')
  }
  const paths = found.map(port => port.path).join(', ')
  throw new PortError(`${found.length} candidate devices attached (${paths}) - name one with --port`)
}

export type OpenPort = Wire & {close(): Promise<void>}

/**
 * Opening through node-serialport does not reset a native-USB S3, unlike the
 * Rust flashing tools, so this is safe against an unlocked device mid-session.
 */
export async function openPort(path: string): Promise<OpenPort> {
  const {SerialPort} = await serialport()
  const port: any = await new Promise((resolve, reject) => {
    const opening = new (SerialPort as any)({path, baudRate: BAUD_RATE}, (err: Error | null) => {
      if (err) reject(new PortError(`cannot open ${path}: ${err.message}`))
      else resolve(opening)
    })
  })

  return {
    write: bytes =>
      new Promise<void>((resolve, reject) => {
        port.write(Buffer.from(bytes), (err: Error | null | undefined) => (err ? reject(err) : resolve()))
      }),
    subscribe(listener) {
      const onData = (chunk: Buffer) => listener(new Uint8Array(chunk))
      port.on('data', onData)
      return () => port.off('data', onData)
    },
    close: () =>
      new Promise<void>(resolve => {
        port.close(() => resolve())
      })
  }
}
