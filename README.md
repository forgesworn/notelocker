# notelocker

One CLI for LNURLcash bearer-note locker devices.

Plug in a locker, ask it what it is holding, mint a secret on it, release one
when you need to spend. It speaks [lnurl-vault]'s serial command set, and it
speaks it over either framing, so the same commands work on an lnurl-vault and
on a heartwood without you having to remember which is on the end of the cable.

```
$ notelocker ports
/dev/cu.usbmodem2101  Espressif (native USB)

$ notelocker info
fw_version      0.9.2
board           heltec-v4
note_count      3
pending_count   0

$ notelocker list
a1b2c3d4  CONFIRMED  50.000 sat  float      moneyer.dev
e5f6a7b8  PENDING     0.000 sat  -          moneyer.dev
```

## Install

```
npx @forgesworn/notelocker info
```

Or install it properly with `npm i -g @forgesworn/notelocker`.

It depends on `serialport`, which is a native module. That ships prebuilt
binaries for current Node on macOS, Linux and Windows, so `npx` normally just
works. On anything else you will need a build toolchain.

Node 22 or newer.

## Why it works on both devices

The command set is [lnurl-vault's `docs/PROTOCOL.md`][protocol]. A heartwood
implements the same JSON in `common/src/note_cmd.rs`. What differs is the
framing around each message:

| | lnurl-vault | heartwood |
|---|---|---|
| framing | one JSON object per line | `HW` magic, type, u16 BE length, payload, CRC32 BE |
| note command | `{"cmd":...}\n` | frame type `0x70`, reply `0x71` |

`--transport auto` (the default) works out which by asking for `get_info` each
way. It probes the **framed** protocol twice, then the newline one, and the
order is not a preference. Measured on hardware 2026-08-27: a heartwood that receives
newline-delimited JSON stops answering framed commands for the rest of the
session, and only reopening the port recovers it, while a vault that receives a
frame is poisoned only until the next newline, because it reads to one and
resynchronises. So the probe whose failure can be repaired goes second, and a
flush newline between the two does the repairing. An earlier version of this
paragraph said the opposite; the code has always been right.

The framed probe gets two goes before the newline one is risked, which is also
measured rather than guessed. A heartwood that has just been unlocked is still
finishing its boot, and a single 1.5 s probe times out against a device that is
merely busy - at which point the line probe wedges it, and a board that needed
one more second reports "no note locker answered on either framing". Repeating
the safe probe costs a second; reaching the unsafe one early costs the session.

Every command carries a `tag`, which both devices echo verbatim on whatever
answers it. The wire has no request ids otherwise, so a reply that is never
coming is indistinguishable from a slow one, and a late reply from the reply to
the next command. With a tag, a straggler from a command that already timed out
is recognised as one and skipped instead of being taken for the current answer.
Firmware too old to know about the field answers untagged and is still
accepted, which is exactly the old behaviour and no worse. The tag never
reaches a caller: it is stripped from the reply on the way up.

Every command works on both, bar one. `reset` is lnurl-vault only; a heartwood
answers `bad_request`.

## Commands

```
notelocker ports                     list attached candidate devices
notelocker info                      firmware version, note counts, storage
notelocker list [--offset N] [--limit N]
notelocker new [--label <text>] [--parents <id,id>]
notelocker new-pair [--parents <id,id>]
notelocker confirm <id> --amount <msat> --host <host> [--sig <hex>]
notelocker import --secret <64-hex> --host <host> --amount <msat> [--label <text>]
notelocker export <id>               needs the button
notelocker spend <id>                needs the button
notelocker discard <id>              needs the button
notelocker rename <id> <label>       needs the button
notelocker delete <id>               needs the button
notelocker reset                     lnurl-vault only
notelocker raw '<json>'              send one raw protocol command
```

Options: `--port <path>`, `--transport auto|frame|line`, `--timeout <ms>`,
`--json`, `--help`.

**Commands marked "needs the button"** put a card on the device's display and
wait for a physical press, up to 30 seconds. Those get a 40 second timeout; the
rest get 5.

**`export` prints a live note secret to your terminal.** Anyone who reads it can
spend the note. Think about your scrollback, and rotate the note afterwards if
it went anywhere shared.

**`delete` only works on a spent note.** Discard a pending one or spend a
confirmed one first.

## Picking a device

With one locker attached you can leave `--port` off. With two, it will refuse
rather than guess, because sending `spend` to the wrong board is not a mistake
you can take back.

`notelocker ports` looks at USB vendor IDs: Espressif native USB, plus the
CP210x, CH340 and FTDI bridges that non-native boards reach the host through.
The browser console in lnurl-vault filters on Espressif alone, which is right
for a vault but would miss a heartwood on a Heltec V3.

## As a library

```ts
import {detectTransport, openPort, lookup, timeoutFor} from '@forgesworn/notelocker'

const wire = await openPort('/dev/cu.usbmodem2101')
const transport = await detectTransport(wire)
const spec = lookup('list')
const reply = await transport.request(spec.build([], {}), timeoutFor(spec))
await wire.close()
```

The frame codec and the command table are pure and have no native dependency,
so they import and test anywhere. Only `openPort` and `listPorts` reach for
`serialport`, and they do it lazily.

## Licence

MIT.

[lnurl-vault]: https://github.com/dni/lnurl-vault
[protocol]: https://github.com/dni/lnurl-vault/blob/main/docs/PROTOCOL.md
