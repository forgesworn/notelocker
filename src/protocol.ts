// The command set both devices share.
//
// lnurl-vault's docs/PROTOCOL.md is the specification. A heartwood implements
// the same JSON in common/src/note_cmd.rs, so every command here works on both
// with one exception, flagged `vaultOnly` below.

export class UsageError extends Error {}

export type CommandSpec = {
  /** The `cmd` field the device sees. */
  readonly cmd: string
  readonly summary: string
  /** Raises a card on the device and waits for a physical confirmation. */
  readonly gated: boolean
  /** Present on an lnurl-vault but not on a heartwood. */
  readonly vaultOnly?: boolean
  /**
   * Present on a heartwood but not on an lnurl-vault: LUD-25 seed-recoverable
   * note secrets, which the vault has the arithmetic for (`derive.c`, from
   * `dni/lnurl-vault#134`) but has not wired to a command. If it grows one,
   * expect this to become shared rather than a second spelling - the point of
   * this tool is that one command set drives both.
   */
  readonly heartwoodOnly?: boolean
  readonly usage: string
  build(args: readonly string[], flags: Flags): Record<string, unknown>
}

export type Flags = Record<string, string | boolean | undefined>

/** Gated commands wait on a 30s on-device confirmation, so allow for it. */
export const GATED_TIMEOUT_MS = 40_000
export const DEFAULT_TIMEOUT_MS = 5_000

const text = (flags: Flags, name: string): string | undefined => {
  const value = flags[name]
  if (value === undefined || value === false) return undefined
  if (value === true) throw new UsageError(`--${name} needs a value`)
  return value
}

function requireId(args: readonly string[], usage: string): string {
  const id = args[0]
  if (id === undefined || id === '') throw new UsageError(`usage: ${usage}`)
  return id
}

function requireMsat(flags: Flags, name: string): number {
  const raw = text(flags, name)
  if (raw === undefined) throw new UsageError(`--${name} is required, in millisatoshis`)
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number of millisatoshis, got ${raw}`)
  return Number(raw)
}

function requireHost(flags: Flags): string {
  const host = text(flags, 'host')
  if (host === undefined || host === '') throw new UsageError('--host is required, the mint this note is drawn on')
  return host
}

/// The 64 bytes a mint's LUD-25 subtree is: a 32-byte key then a 32-byte
/// chain code, hex. Checked here rather than left to the device, because the
/// device answers a malformed one with a bare `bad_request` and the operator
/// is standing at a cable wondering which of two arguments was wrong.
function requireNode(flags: Flags): string {
  const node = text(flags, 'node')
  if (node === undefined || node === '') {
    throw new UsageError("--node is required: the mint's domain node, 64 bytes of hex")
  }
  const cleaned = node.trim().toLowerCase()
  if (!/^[0-9a-f]{128}$/.test(cleaned)) {
    throw new UsageError(
      `--node must be 64 bytes of hex (128 characters), got ${cleaned.length}`
    )
  }
  return cleaned
}

function parents(flags: Flags): string[] | undefined {
  const raw = text(flags, 'parents')
  if (raw === undefined) return undefined
  const ids = raw.split(',').map(part => part.trim()).filter(Boolean)
  return ids.length > 0 ? ids : undefined
}

function optionalLabel(flags: Flags): string | undefined {
  return text(flags, 'label')
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  info: {
    cmd: 'get_info',
    summary: 'firmware version, note counts and storage state',
    gated: false,
    usage: 'notelocker info',
    build: () => ({cmd: 'get_info'})
  },
  list: {
    cmd: 'list_notes',
    summary: 'list the notes held on the device',
    gated: false,
    usage: 'notelocker list [--offset N] [--limit N]',
    build: (_args, flags) => {
      const command: Record<string, unknown> = {cmd: 'list_notes'}
      const offset = text(flags, 'offset')
      const limit = text(flags, 'limit')
      // A vault too full to answer in one reply returns response_too_large;
      // that is the cue to page rather than a fault. See PROTOCOL.md.
      if (offset !== undefined) command['offset'] = Number(offset)
      if (limit !== undefined) command['limit'] = Number(limit)
      return command
    }
  },
  new: {
    cmd: 'new_secret',
    summary: 'generate a new note secret on the device',
    gated: false,
    usage: 'notelocker new [--host <host>] [--label <text>] [--parents <id,id>]',
    build: (_args, flags) => {
      const command: Record<string, unknown> = {cmd: 'new_secret'}
      const label = optionalLabel(flags)
      const parentIds = parents(flags)
      // With --host the secret comes off that mint's LUD-25 ladder, so a seed
      // phrase can find the note again; without it the device draws at random
      // exactly as it always has. Passed through rather than defaulted: a
      // host the device has no subtree for is refused, and that refusal is
      // the honest answer to "give me a note my seed can find".
      const host = text(flags, 'host')
      if (host !== undefined) command['host'] = host
      if (label !== undefined) command['label'] = label
      if (parentIds !== undefined) command['parent_ids'] = parentIds
      return command
    }
  },
  'new-pair': {
    cmd: 'new_secret_pair',
    summary: 'generate two secrets at once, for a split',
    gated: false,
    usage: 'notelocker new-pair [--host <host>] [--label <text>] [--parents <id,id>]',
    build: (_args, flags) => {
      const command: Record<string, unknown> = {cmd: 'new_secret_pair'}
      const parentIds = parents(flags)
      // Both secrets come off the ladder under one counter write. See `new`.
      const host = text(flags, 'host')
      const label = optionalLabel(flags)
      if (host !== undefined) command['host'] = host
      if (label !== undefined) command['label'] = label
      if (parentIds !== undefined) command['parent_ids'] = parentIds
      return command
    }
  },
  confirm: {
    cmd: 'confirm',
    summary: 'promote a pending note once the mint has issued it',
    gated: false,
    usage: 'notelocker confirm <id> --amount <msat> --host <host> [--sig <hex>]',
    build: (args, flags) => {
      const command: Record<string, unknown> = {
        cmd: 'confirm',
        id: requireId(args, 'notelocker confirm <id> --amount <msat> --host <host>'),
        amount_msat: requireMsat(flags, 'amount'),
        host: requireHost(flags)
      }
      const sig = text(flags, 'sig')
      if (sig !== undefined) command['sig'] = sig
      return command
    }
  },
  'provision-cash': {
    cmd: 'provision_cash_node',
    heartwoodOnly: true,
    // What the operator is really being asked on the device is "is this the
    // mint you meant", because the node cannot be checked by eye. Say so here
    // too, so the card is not the first place they learn it matters.
    summary: "store a mint's LUD-25 subtree so its notes derive from the seed (needs the button)",
    gated: true,
    usage: 'notelocker provision-cash --host <host> --node <128-hex>',
    build: (_args, flags) => ({
      cmd: 'provision_cash_node',
      host: requireHost(flags),
      node: requireNode(flags)
    })
  },
  'forget-cash': {
    cmd: 'forget_cash_node',
    heartwoodOnly: true,
    summary: "drop a mint's subtree; notes already held are untouched",
    gated: false,
    usage: 'notelocker forget-cash --host <host>',
    build: (_args, flags) => ({cmd: 'forget_cash_node', host: requireHost(flags)})
  },
  'list-cash': {
    cmd: 'list_cash_mints',
    heartwoodOnly: true,
    summary: 'mints this device can derive notes for, and the next index of each',
    gated: false,
    usage: 'notelocker list-cash',
    build: () => ({cmd: 'list_cash_mints'})
  },
  'set-cash-index': {
    cmd: 'set_cash_index',
    heartwoodOnly: true,
    // Raises only, and the device enforces that. Named "set" to match the
    // wire, described as "raise" because that is what it can actually do.
    summary: "raise a mint's next index to meet a wallet that has minted further",
    gated: false,
    usage: 'notelocker set-cash-index --host <host> --index <n>',
    build: (_args, flags) => {
      const raw = text(flags, 'index')
      if (raw === undefined) throw new UsageError('--index is required, the next index to mint at')
      if (!/^\d+$/.test(raw)) throw new UsageError(`--index must be a whole number, got ${raw}`)
      const index = Number(raw)
      // 2^31 is where the device stops: `i` is hardened by LUD-25's own `i'`,
      // so it has the low 31 bits. Refused here so the operator gets the
      // reason rather than a bare bad_request.
      if (index > 0x7fffffff) throw new UsageError('--index must be below 2147483648')
      return {cmd: 'set_cash_index', host: requireHost(flags), next_index: index}
    }
  },
  discard: {
    cmd: 'discard',
    summary: 'drop a pending note that was never issued',
    gated: true,
    usage: 'notelocker discard <id>',
    build: args => ({cmd: 'discard', id: requireId(args, 'notelocker discard <id>')})
  },
  export: {
    cmd: 'export_secret',
    summary: 'read a note secret out (needs the button, within 30s)',
    gated: true,
    usage: 'notelocker export <id>',
    build: args => ({cmd: 'export_secret', id: requireId(args, 'notelocker export <id>')})
  },
  import: {
    cmd: 'import_secret',
    summary: 'store an existing note secret on the device',
    gated: false,
    usage: 'notelocker import --secret <64-hex> --host <host> --amount <msat> [--label <text>]',
    build: (_args, flags) => {
      const secret = text(flags, 'secret')
      if (secret === undefined) throw new UsageError('--secret is required, 64 hex characters')
      if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
        throw new UsageError(`--secret must be 64 hex characters, got ${secret.length}`)
      }
      const command: Record<string, unknown> = {
        cmd: 'import_secret',
        k1: secret.toLowerCase(),
        host: requireHost(flags),
        amount_msat: requireMsat(flags, 'amount')
      }
      const label = optionalLabel(flags)
      if (label !== undefined) command['label'] = label
      return command
    }
  },
  spend: {
    cmd: 'mark_spent',
    summary: 'mark a note spent once it has been melted',
    gated: true,
    usage: 'notelocker spend <id>',
    build: args => ({cmd: 'mark_spent', id: requireId(args, 'notelocker spend <id>')})
  },
  rename: {
    cmd: 'rename',
    summary: 'change a note label',
    gated: true,
    usage: 'notelocker rename <id> <label>',
    build: args => {
      const id = requireId(args, 'notelocker rename <id> <label>')
      const label = args[1]
      if (label === undefined) throw new UsageError('usage: notelocker rename <id> <label>')
      return {cmd: 'rename', id, label}
    }
  },
  delete: {
    cmd: 'delete',
    summary: 'remove a spent note (spend or discard it first)',
    gated: true,
    usage: 'notelocker delete <id>',
    build: args => ({cmd: 'delete', id: requireId(args, 'notelocker delete <id>')})
  },
  reset: {
    cmd: 'reset',
    summary: 'reboot the device, leaving notes untouched (lnurl-vault only)',
    gated: false,
    vaultOnly: true,
    usage: 'notelocker reset',
    build: () => ({cmd: 'reset'})
  }
}

export function timeoutFor(spec: CommandSpec): number {
  return spec.gated ? GATED_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

export function lookup(name: string): CommandSpec {
  const spec = COMMANDS[name]
  if (spec === undefined) {
    throw new UsageError(`unknown command "${name}" - run notelocker --help for the list`)
  }
  return spec
}
