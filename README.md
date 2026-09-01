# Beamer support in replay manager

This is a fork of [replay-manager-for-slippi](https://github.com/jmlee337/replay-manager-for-slippi).

## What a Beamer is

A [Beamer](https://github.com/jendotpg/slippi-beamer) is a microprocessor attached to a Wii over the USB port. The Beamer presents a disk image to the Wii as an ordinary USB flash drive. Slippi Nintendont writes `.slp` files to it believing it is a stick. The Beamer then serves those same replays over the tournament WiFi (or, for bigger tournaments, over a dedicated IoT access point).

In short: TOs can use Beamers to report a set with only a station number - no need to send a flash drive back and forth.

### The network contract

| Method | Path             | What it does                                                  |
| ------ | ---------------- | ------------------------------------------------------------- |
| `GET`  | `/SLIPPI/`       | Index of the replays this station is currently serving.       |
| `GET`  | `/status`        | The last self-check, cached. Runs nothing, so poll it freely. |
| `POST` | `/status`        | Re-runs the check, then returns the fresh report.             |
| `GET`  | `/SLIPPI/<file>` | The replay itself.                                            |
| `POST` | `/reset-beamer`  | Erases the replay drive. Requires`X-Beamer-Confirm: reset`.   |
| mDNS   | N/A              | Stations advertise`_beamer._tcp` on port 80.                  |

`GET /SLIPPI/` -> a JSON index of the replays the station is serving right now, newest first (`NUM-REPLAYS-SERVED`, up to 16).

```json
{
  "schema": 1,
  "station_id": "60ed5b25-5a43-5481-9d5c-abcb52dcb1f2",
  "served_replay_count": 1,
  "files": [
    { "size": 1343765, "url": "/SLIPPI/Game_8C56C52F24CC_20260831T202307.slp" }
  ]
}
```

`GET /status` ->

```json
{
  "schema": 1,
  "arch": "esp32", # fake for a fake, armhf for a pi zero w
  "firmware_version": "v0.2.2",
  "station_id": "60ed5b25-5a43-5481-9d5c-abcb52dcb1f2",
  "station_name": "dev-unit-02",
  "ssid": "nycmelee",
  "replay_count": 17,
  "replay_cap": 512,
  "ssh": false,
  "game": { # null until a game has been started, then the most recent game
    "live": false,
    "ports": [
      {
        "port": 1,
        "char": "Puff",
        "char_id": 15,
        "color": null,
        "costume": 0,
        "nametag": null
      },
      {
        "port": 4,
        "char": "Falco",
        "char_id": 20,
        "color": null,
        "costume": 0,
        "nametag": null
      }
    ]
  },
  "secs_since_port_change": 888, # how many seconds have the same ports been in use
  "secs_since_character_change": 888, # how many seconds have the same characters AND ports been in use
  "health": "ok",
  "warnings": []
}
```

### Trust model

There's no authentication at all - if you can reach the beamer, you can do anything to it. This is part of why at bigger events they'll be on their own wifi.

## `usbstorage`/ `onUsb`

In this fork`onUsb`(triggered by `usbstorage`) carries three conceptually different things: "a USB drive state was updated", "a replay directory was downloaded through a deep-link", and "a Beamer cache was updated." All three share (approximately) a graphical interface - but this still feels weird to me...

It was already overloaded before I touched it. Upstream at 2.5.1, `usbstorage` had two producers:

1. `detect-usb` insert/eject -> `addReplayDir(dir, key)` on insert and raw `usbstorage` send on eject
2. `handleProtocolLoadSlpUrls` download -> `addReplayDir(protocolLoadFullPath, '')`

It seems like this channel is really meant to control "what displays in the top-left corner showing replay origin" and not per se usbs.

In this fork, the payload went from `(dir, isUsb)` to `(dir, isUsb, beamerOrigin, beamerName)`, and there are now six producers: usb eject, cache clearing, cache pruning, usb insert, protocol load, and `copyFromBeamer`. The latter three are routed through `addReplayDir`.

A few notes on why I really don't like the current shape:

- The payload is a tagged union pretending to be positional arguments. Every consumer has to know which combinations are legal (`isUsb` true _and_ `beamerOrigin` set is meaningless, but nothing says so).
- The name no longer describes any of its meanings, including the original one after eject re-announces a non-USB directory.
- Some `usbstorage` sets go through `addReplayDir` and others don't - and some don't even go through the `onUsb` channel at all. `chooseReplaysDir`and the undo path set`dir`/`isUsb`/`beamerOrigin` locally from a return value and never touch the channe .

I think this shape should probably be changed completely but I don't want to do a big refactor that's going to need to be undone if this ever goes upstream. I see three options (I personally prefer the 2nd):

1. Keep the shape in this fork right now (`onUsb`controlling replay directory for Beamers + deep links + usb mounting, minimal refactoring of upstream)
2. Refactor `usbstorage` into separate`replaydir` and `usbstorage` channels - downloads (like Beamer pulls and deep links) can send `replaydir` directly and the renderer thread can handle the much simpler `onUsb` and `onReplayDir` more cleanly.
3. Keep `usbstorage` as is, add a `beamer` channel that ONLY works for Beamers and update Beamer state on `onBeamer` while leaving deep links alone. This is the cleanest design without any upstream refactoring but leaves the existing overload alone without piling onto it - feels very weird to me....

## Changes to replay manager

### `src/main/beamer.ts` (new) — the replay index and the local cache

### `src/main/discover.ts` (new) — mDNS, `/status`, `/reset-beamer`

### `src/main/util.ts` — `downloadFile` moved out of `ipc.ts`, now shared with the Beamer pull and rewritten to survive venue wifi

### `src/main/ipc.ts` — a number of changes to the stateful layer

Sixteen new `invoke` handlers (`copyFromBeamer`, `refreshFromBeamer`, `cancelBeamerDownload`, `getNextBeamerReplay`, `downloadNextBeamerReplay`, `getMaxGamesFromIndex` / `setMaxGamesFromIndex`, `startBeamerBrowse` / `stopBeamerBrowse`, `getBeamerFleet`, `refreshBeamerStatus`, `refreshAllBeamerStations`, `resetBeamerStation`, `resetAllBeamerStations`, `getBeamerCacheSize`, `clearBeamerCache`) and one new push channel, `beamerFleet`.

A few notes:

- `ReplayDir`got new fields to account for a new type of location
- The fleet poll is forgiving. A failed `/status` poll does not remove a station from the list if it's advertising over mDNS.
- The fleet is keyed by address, not by station name. Nothing stops two stations from advertising the same instance name.
- Pulling .slps from the Beamer index is windowed. `maxGamesFromIndex` caps how many of the newest index entries `copyFromBeamer` and `refreshFromBeamer` pass to `pullFromBeamer`. `pruneStaleReplaysFor` still passes the full index to `pruneStaleReplays`, so a replay that fell outside the download window is still shown if it's still being served.

### `src/main/preload.ts` — matching changes to the bridge

### `src/renderer/BeamerDialog.tsx` (new) - dialog to manage beamer fleet

### `src/renderer/ReplayList.tsx` - the "Download next replay" row

### `src/renderer/App.tsx` - add Beamer button, show the Beamer as the source, disable eject / delete paths for Beamer sources, and point refresh at the Beamer

### `SetControls.tsx`- disable delete from Beamer cache

### `Settings.tsx`- let user delete cached replays

### `SlpDownloadModal.tsx` - a Cancel button, a `cancelled` state, an `(n of m)` counter, and a "retrying" line

### `common/`- new beamer types and constant

## Non-changes to replay manager

No new dependencies.

No background network traffic. The mDNS browser and the 10 s fleet poll run only while the dialog is open. A TO who never opens it never sees a multicast packet.

No new download or progress UI. The `replay-manager:` protocol handler already had `SlpDownloadStatus`, the `slp-download-status` channel, and `SlpDownloadModal`. The Beamer pull emits the same statuses on the same channel into the same modal. `pullFromBeamer` takes an `onStatus` callback for exactly this reason. The status payload gained three optional fields and one new variant; the modal gained a Cancel button and a retry line.

Four things change for a user who never touches a Beamer:

1. `downloadFile` is shared with the `replay-manager:` protocol handler, so that path inherits the resume, the retries, the watchdogs, streaming to disk instead of buffering the whole file in memory, and a new set of error strings.
2. A failed or cancelled protocol download leaves a `.part` file behind. Upstream immediately deleted the partial file; this fork keeps it so a retry resumes and Settings can delete it. If the host ignores `Range` the fragment is dropped and the file downloads in full upon retry.
3. Protocol downloads moved from `userData/protocol` to `userData/replayCache/protocol`, alongside the Beamer cache at `userData/replayCache/beamer`. One "Delete cached replays" button in Settings clears both.
4. Two controls are always visible: the Beamer button in the app bar, and the "No cached replays" row in Settings.

## Reviewing this without a Beamer

You don't need any extra hardware. Everything the app talks to is an mDNS advertisement and five HTTP endpoints, and [the Beamer repo](https://github.com/jendotpg/slippi-beamer) ships a stand-in:

```bash
tools/fake-beamer.py --name beamer-virtual-1 --port 8081 \
  --replays ~/Slippi/ --game ~/Slippi/Game_20230110T102627.slp \
  --station-name "Fake 1"
```

Run several on different ports for a fleet — the app honours the advertised port, so they coexist on one machine. Biggest exception: the duplicate-name case can't be faked on my Mac since Bonjour renames the duplicate automatically. Maybe you can get away with it on another platform or by forcing it in a way I didn't try (I didn't try very hard :P )

The game payload isn't canned: `--game` is peeked out of a real `.slp` by a port of`beamer::slp`.

The flags that reproduce states the app has to handle:

- `--unhealthy` -> `health: "error"`, which should show the red warning icon on the row while still allowing a copy.
- `--warn "DRIVE FILLING,NO WII"` -> `health: "warn"` with those labels, which should show the amber icon and the labels in its tooltip.
- `--unreported` -> `503` on `GET /status`, which should drop the station off the list rather than raising an error - `listedBeamerStations` only lists stations that have reported.
- `--cap` / `--served` -> the `replay_cap` the station reports and how many replays it publishes, for the `17/512 replays` line.
- `--post-delay` -> how long `POST /status` takes, so the refresh spinner is visible.

This test doesn't emulate the USB gadget, the LED, the config file, the reset endpoint's actual destruction, the `409` you get from the station's API lock, or the timing of a real Beamer.
