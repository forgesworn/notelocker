# notelocker

A CLI and library for LNURLcash bearer-note locker devices. It speaks
[lnurl-vault](https://github.com/dni/lnurl-vault)'s serial command set over
either wire framing, so the same commands drive an lnurl-vault and a
heartwood alike. The CLI is the primary interface; the library exports the
same codec and transport pieces for anything that would rather drive a
locker in process.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies |
| `npm run build` | Compile with `tsc` to `dist/` |
| `npm test` | Run the test suite (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting |
| `npm run check` | typecheck, test, build, `npm pack --dry-run` |

## Structure

```
src/cli.ts        command-line entry point and argument parsing
src/protocol.ts    the shared command table (COMMANDS), timeouts, flag parsing
src/frame.ts       the heartwood frame codec (pure, no native dependency)
src/transport.ts   frame and line transports, device error types
src/port.ts        serial port discovery and opening (lazy `serialport` import)
src/index.ts       the library surface (re-exports the above)
test/              vitest specs, plus a fake Wire for hardware-free testing
```

## Conventions

- British English in prose and comments.
- Amounts are in millisatoshis on the wire and commands (`--amount <msat>`).
- The frame codec and command table (`src/frame.ts`, `src/protocol.ts`) are
  pure and have no native dependency, so they import and test anywhere. Only
  `openPort` and `listPorts` in `src/port.ts` reach for `serialport`, and
  they do it lazily.
- Every protocol command carries a `tag` so a late reply from a timed-out
  command is recognised and skipped rather than mistaken for the current
  answer. It is stripped from the reply before it reaches a caller.

## Key Files

| File | Purpose |
|------|---------|
| `src/protocol.ts` | `COMMANDS`, `CommandSpec`, `lookup`, `timeoutFor` |
| `src/transport.ts` | `Transport`, `Wire`, `detectTransport`, error classes |
| `src/frame.ts` | heartwood frame encode/decode, CRC32 |
| `src/port.ts` | `CANDIDATE_VENDOR_IDS`, `openPort`, `listPorts` |

## Common Pitfalls

- `--transport auto` probes the framed protocol twice before the newline
  one: a heartwood that receives a stray newline-delimited command stops
  answering framed commands for the rest of the session, so the probe order
  is deliberate, not a preference.
- `reset` is lnurl-vault only; a heartwood answers `bad_request`.
- `export` prints a live note secret to the terminal; anyone who reads it
  can spend the note.
- `delete` only works on a spent note; discard a pending one or spend a
  confirmed one first.
- Commands marked "needs the button" (in `CommandSpec.gated`) wait up to 30
  seconds for a physical confirmation and use `GATED_TIMEOUT_MS`, not
  `DEFAULT_TIMEOUT_MS`.

## Verifying a change

Run `npm run check` before committing: it typechecks, runs the test suite,
builds, and does a dry-run `npm pack` to catch packaging mistakes.
