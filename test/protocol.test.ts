import {describe, expect, it} from 'vitest'
import {COMMANDS, DEFAULT_TIMEOUT_MS, GATED_TIMEOUT_MS, UsageError, lookup, timeoutFor} from '../src/protocol.ts'

const build = (name: string, args: string[] = [], flags: Record<string, string | boolean> = {}) =>
  lookup(name).build(args, flags)

describe('the command table', () => {
  it('covers the shared surface of both devices', () => {
    // These are the twelve in lnurl-vault's docs/PROTOCOL.md that its own web
    // console offers. A heartwood implements all but `reset`. Anything beyond
    // them has to declare which device it is for, so this list stays the
    // definition of "works on both" rather than drifting into a union.
    const shared = Object.values(COMMANDS)
      .filter(spec => !spec.vaultOnly && !spec.heartwoodOnly)
      .map(spec => spec.cmd)
      .sort()
    expect(shared).toEqual([
      'confirm',
      'delete',
      'discard',
      'export_secret',
      'get_info',
      'import_secret',
      'list_notes',
      'mark_spent',
      'new_secret',
      'new_secret_pair',
      'rename'
    ])
  })

  it('names the commands only one device has', () => {
    // `reset` is the vault's; the cash ones are the heartwood's until the
    // vault wires its own derive.c to a command.
    const only = (pick: (s: (typeof COMMANDS)[string]) => boolean) =>
      Object.values(COMMANDS).filter(pick).map(spec => spec.cmd).sort()
    expect(only(s => s.vaultOnly === true)).toEqual(['reset'])
    expect(only(s => s.heartwoodOnly === true)).toEqual([
      'forget_cash_node',
      'list_cash_mints',
      'provision_cash_node',
      'set_cash_index'
    ])
    // and nothing claims to be both
    expect(Object.values(COMMANDS).filter(s => s.vaultOnly && s.heartwoodOnly)).toEqual([])
  })

  it('marks exactly the physically-gated commands', () => {
    const gated = Object.values(COMMANDS).filter(spec => spec.gated).map(spec => spec.cmd).sort()
    // provision_cash_node joins them: a domain node is every note secret at
    // that mint, so it is not a quiet write.
    expect(gated).toEqual([
      'delete',
      'discard',
      'export_secret',
      'mark_spent',
      'provision_cash_node',
      'rename'
    ])
  })

  it('flags reset as the one lnurl-vault only command', () => {
    const vaultOnly = Object.entries(COMMANDS).filter(([, spec]) => spec.vaultOnly === true).map(([name]) => name)
    expect(vaultOnly).toEqual(['reset'])
  })

  it('gives gated commands room for the on-device confirmation', () => {
    expect(timeoutFor(COMMANDS['export']!)).toBe(GATED_TIMEOUT_MS)
    expect(timeoutFor(COMMANDS['info']!)).toBe(DEFAULT_TIMEOUT_MS)
    expect(GATED_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('rejects an unknown command by name', () => {
    expect(() => lookup('frobnicate')).toThrow(UsageError)
  })
})

describe('building commands', () => {
  it('builds the trivial ones', () => {
    expect(build('info')).toEqual({cmd: 'get_info'})
    expect(build('reset')).toEqual({cmd: 'reset'})
  })

  it('omits optional fields rather than sending undefined', () => {
    // A null or undefined where the device expects a string is a bad_request,
    // so absent means absent.
    expect(build('new')).toEqual({cmd: 'new_secret'})
    expect(build('new', [], {label: 'float'})).toEqual({cmd: 'new_secret', label: 'float'})
  })

  it('splits parent ids on commas and drops the blanks', () => {
    expect(build('new-pair', [], {parents: 'aa, bb ,'})).toEqual({
      cmd: 'new_secret_pair',
      parent_ids: ['aa', 'bb']
    })
  })

  it('builds a confirm with its required fields', () => {
    expect(build('confirm', ['a1b2'], {amount: '50000', host: 'moneyer.dev'})).toEqual({
      cmd: 'confirm',
      id: 'a1b2',
      amount_msat: 50_000,
      host: 'moneyer.dev'
    })
  })

  it('refuses a confirm missing its amount or host', () => {
    expect(() => build('confirm', ['a1b2'], {host: 'moneyer.dev'})).toThrow(/--amount/)
    expect(() => build('confirm', ['a1b2'], {amount: '1'})).toThrow(/--host/)
  })

  it('refuses an amount that is not whole millisatoshis', () => {
    // 50.5 msat is not a thing, and a silent Number() would send NaN.
    expect(() => build('confirm', ['a1b2'], {amount: '50.5', host: 'x'})).toThrow(/whole number/)
  })

  it('normalises an imported secret and checks its length', () => {
    const secret = 'A'.repeat(64)
    expect(build('import', [], {secret, host: 'moneyer.dev', amount: '1000'})).toEqual({
      cmd: 'import_secret',
      k1: 'a'.repeat(64),
      host: 'moneyer.dev',
      amount_msat: 1_000
    })
    expect(() => build('import', [], {secret: 'abc', host: 'x', amount: '1'})).toThrow(/64 hex/)
  })

  it('needs an id for every command that names a note', () => {
    for (const name of ['discard', 'export', 'spend', 'delete', 'rename']) {
      expect(() => build(name)).toThrow(UsageError)
    }
  })

  it('needs both halves of a rename', () => {
    expect(() => build('rename', ['a1b2'])).toThrow(/rename <id> <label>/)
    expect(build('rename', ['a1b2', 'rent'])).toEqual({cmd: 'rename', id: 'a1b2', label: 'rent'})
  })

  it('treats a valueless flag as a mistake, not as true', () => {
    expect(() => build('new', [], {label: true})).toThrow(/--label needs a value/)
  })
})

describe('the cash commands', () => {
  const build = (name: string, flags: Record<string, string | boolean | undefined>) =>
    COMMANDS[name]!.build([], flags)

  it('builds a provision with a host and a 64-byte node', () => {
    const node = 'ab'.repeat(64)
    expect(build('provision-cash', {host: 'mint.example', node})).toEqual({
      cmd: 'provision_cash_node',
      host: 'mint.example',
      node
    })
  })

  it('refuses a node that is not 64 bytes, before the cable sees it', () => {
    // The device answers a malformed one with a bare bad_request, which
    // leaves an operator at a cable guessing which of two arguments was wrong.
    const node = 'ab'.repeat(64)
    expect(() => build('provision-cash', {host: 'mint.example'})).toThrow(UsageError)
    expect(() => build('provision-cash', {host: 'mint.example', node: 'beef'})).toThrow(
      /64 bytes of hex/
    )
    expect(() => build('provision-cash', {host: 'mint.example', node: `${node}ab`})).toThrow(
      /64 bytes of hex/
    )
    expect(() => build('provision-cash', {host: 'mint.example', node: 'zz'.repeat(64)})).toThrow(
      /64 bytes of hex/
    )
    expect(() => build('provision-cash', {node})).toThrow(/--host is required/)
  })

  it('normalises a node to lower case, as the device stores it', () => {
    const node = 'AB'.repeat(64)
    expect(build('provision-cash', {host: 'mint.example', node})['node']).toBe('ab'.repeat(64))
  })

  it('raises an index and refuses one past the ladder', () => {
    expect(build('set-cash-index', {host: 'mint.example', index: '9'})).toEqual({
      cmd: 'set_cash_index',
      host: 'mint.example',
      next_index: 9
    })
    // i is hardened by LUD-25's own i', so it has the low 31 bits.
    expect(() => build('set-cash-index', {host: 'mint.example', index: '2147483648'})).toThrow(
      /below 2147483648/
    )
    expect(() => build('set-cash-index', {host: 'mint.example', index: '-1'})).toThrow(UsageError)
    expect(() => build('set-cash-index', {host: 'mint.example', index: 'many'})).toThrow(UsageError)
    expect(() => build('set-cash-index', {host: 'mint.example'})).toThrow(/--index is required/)
  })

  it('sends a host on new and new-pair only when one was given', () => {
    // No host is not a fallback, it is the old behaviour: the device draws at
    // random, and the note is good but findable only from a backup file.
    expect(build('new', {})).toEqual({cmd: 'new_secret'})
    expect(build('new', {host: 'mint.example'})).toEqual({
      cmd: 'new_secret',
      host: 'mint.example'
    })
    expect(build('new-pair', {})).toEqual({cmd: 'new_secret_pair'})
    expect(build('new-pair', {host: 'mint.example'})).toEqual({
      cmd: 'new_secret_pair',
      host: 'mint.example'
    })
  })
})
