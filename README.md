# Beamer support in replay manager

This is a fork of [replay-manager-for-slippi](<[github.com/jmlee337/replay-manager-for-slippi](https://github.com/jmlee337/replay-manager-for-slippi)>). I'm still working on building a test suite for it.

---

## 1. What a Beamer is

A [Beamer](<[github.com/jendotpg/slippi-beamer](https://github.com/jendotpg/slippi-beamer)>) is a Raspberry Pi Zero W bolted to a Wii. Linux can run a USB port in _device_ mode, so the Pi presents a 1 GB disk image on its SD card to the Wii as an ordinary USB flash drive. Slippi Nintendont writes `.slp` files to it believing it is a stick. The Pi then serves those same replays over the tournament WiFi (or, for bigger tournaments, over a dedicated IoT access point).

In short: TOs can use beamers to report sets with only a station number - no need to send a flash drive back and forth.

---

## 2. The network contract

This is the entire surface the app talks to: an mDNS advertisement and five HTTP routes.

**Discovery.** Stations advertise `_beamer._tcp` on port 80 via avahi. The service instance name is the station's hostname (`beamer-<slug of its configured name>`).

**`GET /SLIPPI/`** -> a JSON index of the last up-to-10 generated slippi replays

```json
{
  "schema": 1,
  "station": "<uuid>",
  "generated": "<timestamp>",
  "count": 10,
  "files": [
    {
      "name": "Game_….slp",
      "size": 214233,
      "mtime": "<iso>",
      "url": "/SLIPPI/Game_….slp"
    }
  ]
}
```

**`GET /SLIPPI/<file>`** -> the replay, served statically.

**`GET /status`** -> the station's last self-check: station id and name, WiFi SSID, replay count, a pass/fail verdict, and — when a game is in progress or has just finished — the ports, characters, costumes and nametags parsed out of the live `.slp`.

**`POST /status`** -> re-run the check, then return the fresh report. Slower, obviously.

**`POST /reset-beamer`** -> erase every replay on the station's drive and then remount. This requires the header `X-Beamer-Confirm: reset`, mostly so I don't accidentally trigger it LOL

### Trust model

There's no authentication at all - if you can reach the beamer, you can do anything to it. This is part of why at bigger events they'll be on their own wifi.

Because replay manager cannot trust beamers, it validates everything they send:

- Index entries are re-derived, not trusted (`beamer.ts`): `path.basename` on every name, non-`.slp` and dotfiles dropped, and the resolved URL must still start with `<origin>/SLIPPI/`.
- `/status` bodies are size-capped (`MAX_STATUS_BYTES`) and every field is coerced through `asString` / `Number.isInteger` guards before it reaches React.
- Every `fetch` has an explicit timeout. None of them can hang the main process.
- The per-station cache directory name goes through `sanitize-filename`.

---

## 3. Changes to replay manager

### `src/main/beamer.ts` (new) — the replay index and the local cache

### `src/main/discover.ts` (new) — mDNS, `/status`, `/reset-beamer`

### `src/main/util.ts` — `downloadFile` moved out of `ipc.ts`

Not new code. It was a closure inside `setupIPCs`; `beamer.ts` needed it, so it moved up to `util.ts` unchanged. The diff shows it as a pure relocation. The `slippi:` protocol handler still calls the same function.

### `src/main/ipc.ts` — a number of changes to the stateful layer

Everything mutable lives here. The `ReplayDir` record gained two fields:

```ts
type ReplayDir = {
  dir: string;
  usbKey: string;
  beamerOrigin: string;
  beamerName: string;
};
```

Ten new `invoke` handlers (`copyFromBeamer`, `refreshFromBeamer`, `startBeamerBrowse` / `stopBeamerBrowse`, `getBeamerFleet`, `refreshBeamerStatus`, `resetBeamerStation`, `resetAllBeamerStations`, `getBeamerAddress`, `getBeamerCacheSize`, `clearBeamerCache`) and one new push channel, `beamerFleet`.

A few notes:

- **The fleet poll is forgiving.** A failed `/status` poll does not remove a station from the list — only mDNS `serviceLost` does.
- **The local cache is matched exactly to the beamer.** Each poll compares the local cache to the station's index and unlinks anything the station no longer has, so the local view follows a station whose replay window has rolled forward. If a station won't hand over its index, the cache is left alone.
- **`refreshFromBeamer` takes the origin explicitly.** This prevents a race condition on USB insert between render and click. Shoutout Claude - I never would have found this myself LMFAO

### `src/main/preload.ts` — matching changes to the bridge

Ten `invoke` wrappers, one `on` wrapper for `beamerFleet`, and two extra positional arguments on the existing `onUsb`. See section (5) for the `onUsb` issue - I have some thoughts.

### `src/renderer/BeamerDialog.tsx` (new) - dialog to manage beamer fleet

### `src/renderer/App.tsx`- add beamer button and show source field for beamers

### `SetControls.tsx`- disable delete from beamer cache

### `Settings.tsx`- let user delete beamer cache

### `common/`- new beamer types and

---

## 4. Non-changes

**No new dependencies.**

**No new download or progress UI.** The `slippi:` protocol handler already had `SlpDownloadStatus`, the `slp-download-status` channel, and `SlpDownloadModal`. The Beamer pull emits the same statuses on the same channel into the same modal. `pullFromBeamer` takes an `onStatus` callback for exactly this reason.

**No change to behaviour when no Beamer is involved.**

**No background network traffic.** The mDNS browser and the 10 s fleet poll run only while the dialog is open. A TO who never opens it never sees a multicast packet.

---

## 5. `usbstorage`/ `onUsb`

`usbstorage` now carries two conceptually different things: "a USB drive was inserted" and "a Beamer was selected." They share an interface - this feels weird to me...

However, it was already overloaded before I touched it. At `HEAD~1`, `usbstorage` had three producers:

1. `detect-usb` insert -> `addReplayDir(dir, key)`.
2. `detect-usb` eject -> re-announce whatever directory is now top of stack (possibly `''`).
3. `handleProtocolLoadSlpUrls` finishing a `slippi:` download -> `addReplayDir(protocolLoadFullPath, '')` — **not a USB event**, with `isUsb` false.

It seems like this channel is really meant to control "what displays in the top-left corner showing replay origin" and not per se usbs.

In this fork, the payload went from `(dir, isUsb)` to `(dir, isUsb, beamerOrigin, beamerName)`, and there are now five producers: insert, eject, protocol load, `copyFromBeamer` completing, and `clearBeamerCache` falling back. (Three of those share the one `addReplayDir` send site, so the same line of code means different things depending only on who called it.) Plus a sixth that isn't a source change at all — the cache pruner re-sends the _unchanged_ current directory purely to make the renderer re-read the folder.

A few notes:

1. **The payload is a tagged union pretending to be positional arguments.** Four positions today; a fifth source means a fifth argument, and every consumer has to know which combinations are legal (`isUsb` true _and_ `beamerOrigin` set is meaningless, but nothing says so).
2. **The name no longer describes any of its meanings**, including the original one after eject re-announces a non-USB directory.
3. **There are two ways into the same renderer state.** `chooseReplaysDir` and the undo path set `dir` / `isUsb` / `beamerOrigin` locally from a return value and never touch the channel. Adding Beamer fields doubled what those sites have to remember to clear (ew)

I think this shape should probably be changed completely - but that's ... not really my call :P I can certainly split off onUsb from onBeamerSelect, but I'm not sure that really addresses the underlying issue.

---

## 6. Reviewing this without a Beamer

You don't need a Pi, a Wii, or an LED. Everything the app talks to is an mDNS advertisement and four HTTP endpoints, and [the Beamer repo](<[github.com/jendotpg/slippi-beamer](https://github.com/jendotpg/slippi-beamer)>) ships a stand-in:

```bash
tools/fake-beamer.py --name beamer-virtual-1 --port 8081 \
  --replays ~/Slippi/ --game ~/Slippi/Game_20230110T102627.slp \
  --station-name "Fake 1"
```

Run several on different ports for a fleet — the app honours the advertised port, so they coexist on one machine.

The game payload isn't canned: it comes from the real `slp-peek`, compiled from the station's own C source and run against a real `.slp` exactly as the station does. So the character icons in the fleet list are a real test.

Two flags reproduce the failure states the app handles:

- `--unhealthy` -> `result: "fail"`, which should show the warning icon on the row while still allowing a copy.
- `--unreported` -> `503` on `GET /status`, which should show the row with an address and no details rather than an error.

This test doesn't emulate the USB gadget, the LED, the config file, the reset endpoint's actual destruction, or the timing of a real Zero W.
