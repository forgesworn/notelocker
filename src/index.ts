// The library surface, for anything that would rather drive a locker in
// process than shell out. The CLI is the primary interface; this is the same
// pieces without the argument parsing.

export {
  FrameDecoder,
  FrameError,
  MAGIC,
  MAX_PAYLOAD_SIZE,
  NACK,
  NOTE_CMD,
  NOTE_RESP,
  crc32,
  encodeFrame,
  type DecodedFrame
} from './frame.ts'

export {
  DeviceRefusedError,
  TimeoutError,
  TransportError,
  detectTransport,
  frameTransport,
  lineTransport,
  type Response,
  type Transport,
  type Wire
} from './transport.ts'

export {
  COMMANDS,
  DEFAULT_TIMEOUT_MS,
  GATED_TIMEOUT_MS,
  UsageError,
  lookup,
  timeoutFor,
  type CommandSpec,
  type Flags
} from './protocol.ts'

export {
  BAUD_RATE,
  CANDIDATE_VENDOR_IDS,
  PortError,
  candidates,
  choosePort,
  listPorts,
  openPort,
  type OpenPort,
  type PortInfo
} from './port.ts'
