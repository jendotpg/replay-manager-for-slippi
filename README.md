# Beamer support in replay manager

This is a fork of [replay-manager-for-slippi](https://github.com/jmlee337/replay-manager-for-slippi) to support getting replays over the air from [slippi-beamer](https://github.com/jendotpg/slippi-beamer) devices. Status: we've used this for a few brackets tournaments (NYSE redemption, Melee at Recess) with <15 setups each needing only one router. Multi-section events should work the same but haven't been tested yet.

## What a Beamer is

A [Beamer](https://github.com/jendotpg/slippi-beamer) is a microprocessor attached to a Wii over the USB port. The Beamer presents a disk image to the Wii as an ordinary USB flash drive. Slippi Nintendont writes `.slp` files to it believing it is a stick. The Beamer then serves those same replays over the tournament WiFi (or, for bigger tournaments, over a dedicated IoT access point).

In short: TOs can use Beamers to report a set with only a station number - no need to send a flash drive back and forth.

### Why not Nintendont FTP / Slippi Console Mirror / $SOME_OTHER_OPTION

TL;DR: NYC Melee struggles with the current USB-handoff workflow and this is the solution I was the right developer for. A fork of Nintendont could function very similarly - it would be structurally less safe and I don't feel confident in my ability to build and stress-test such a fork. I eagerly invite someone else to do so ^\_^

Beamer was built from the ground up with a few requirements:

- Setup has to be dead simple after configuring once (in particular, we don't want to require turning on and configuring a PC at tournament start - it's a lot to ask from our setup team who don't bring their own computers)
- We often have multiple TOs reporting sets off of a shared section of setups
- TOs report off of laptops that hibernate often and unpredictably
- Wifi goes down sometimes - we need to be able to report using traditional workflows when that happens
- Under no circumstances should replay issues **EVER** affect gameplay for our players
- Failures must be LOUD - TOs need to know where replays aren't functioning correctly

Slippi console mirror is not an option at all without one central, always on computer - against our setup goals (and I think unrealistic for nearly every laptop-TO'd event for the same reason). Nintendont FTP could almost certainly be extended to meet these goals, but I personally am not comfortable writing Wii software that ensures (a) gameplay isn't affected and (b) failure is easily visible to TOs. Having a separate piece of hardware handle replay transmission trivially guarantees that gameplay won't be affected\*. Complete control over its firmware, along with the bundled screen and LED, let me make sure the failures are loud to TOs both visibly and over the network. The "replays served on demand with timing hints issued over UDP" architecture lets multiple TOs connect and disconnect from a section as they please - certainly possible with FTP, but opening random sockets on command on the same processor that's serving a quasi-real time service makes me uncomfortable. Finally, the HTTP API lets us send status information (like game liveness and players) on demand - again, possible with a Nintendont fork but requiring on demand TCP networking during quasi-real time computation.

\*(Of course, a big enough USB volume is actually known to affect gameplay. It's likely that other details of the USB volume can too. I'm not the right dev for fixing that type of thing. The best I can do is guarantee that gameplay won't be affected against the baseline of the "USB handoff workflow".)

### The network contract

| Method             | Path                 | What it does                                                  |
| ------------------ | -------------------- | ------------------------------------------------------------- |
| `GET`              | `/SLIPPI/`           | Index of the replays this station is currently serving.       |
| `GET`              | `/status`            | The last self-check, cached. Runs nothing, so poll it freely. |
| `GET`              | `/SLIPPI/<file>`     | The replay itself.                                            |
| `POST`             | `/reset-beamer`      | Erases the replay drive. Requires`X-Beamer-Confirm: reset`.   |
| mDNS               | N/A                  | Stations advertise`_beamer._tcp` on port 80.                  |
| multicast announce | `239.255.42.1:34700` | Sends events on game start and game finish                    |

`GET /SLIPPI/` -> a JSON index of the replays the station is serving right now, newest first (`NUM-REPLAYS-SERVED`, up to 16: `maxGamesFromIndexCeiling` in `src/common/constants.ts`).

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
  "rssi": -58,        # the station's own radio, refreshed every 10s; null until the network is up
  "phy_mode": "HT20", # 11B/11G/11A/HT20/HT40/HE20/VHT20/LR/unknown - a fallback to 11G explains a slow pull
  "channel": 6,
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
  "secs_since_game_start": null, # how many seconds since the last game start
  "health": "ok",
  "warnings": []
}
```

Multicast announcement `game_started`->

```json
{
  "schema": 1,
  "event": "game_started",
  "station_id": "3f2a...",
  "station_name": "stream station 2",
  "seq": 7,
  "replay": {
    "name": "Game_20260814T181203.slp",
    "size": 2134, # this is nonsense - don't worry about it!
    "url": "/SLIPPI/Game_20260814T181203.slp" # not valid until the game is finished!
  },
  "game": { ... } # the same object as /status "game" - here "live": true
}
```

Multicast announcement `game_finished`->

```json
{
  "schema": 1,
  "event": "game_finished",
  "station_id": "3f2a...",
  "station_name": "stream station 2",
  "seq": 8,
  "replay": {
    "name": "Game_20260814T181203.slp",
    "size": 412393, # final size on the card
    "url": "/SLIPPI/Game_20260814T181203.slp" #accessible right now
  },
  "game": { ... } # the same object as /status "game" - here "live": false
}
```

### Trust model

There's no authentication at all - if you can reach the beamer, you can do anything to it. This is part of why at bigger events they'll be on their own wifi.

## Non-changes to replay manager

No new dependencies.

New background traffic is only added if there are Beamers on the network with one exception: when auto-subscribe is on, the mDNS listener itself listens for new Beamers from startup. Subscribing to a station (in bulk via settings or individually in the fleet view) starts background downloads: newly finished games are pulled when `game_finished` multicasts arrive and on periodic catch-up sweeps. A TO with no Beamer on the network (or only unsubscribed Beamers and auto-subscribe off) sees no background work.

Four things change for a user who never touches a Beamer:

1. `downloadFile` is shared with the `replay-manager:` protocol handler, so that path inherits the resume, the retries, the watchdogs, `Retry-After` honoring, streaming to disk instead of buffering the whole file in memory, and a new set of error strings.
2. A failed protocol download leaves a `.part` file behind. Upstream immediately deleted the partial file; this fork keeps it so a retry resumes and Settings can delete it. If the host ignores `Range` the fragment is dropped and the file downloads in full upon retry.
3. Protocol downloads moved from `userData/protocol` to `userData/replayCache/protocol`, alongside the Beamer cache at `userData/replayCache/beamer`. One "Delete cached replays" button in Settings clears both.
4. Two controls are always visible: the Beamer button in the app bar and the "No cached replays" row in Settings.

## Reviewing this without a Beamer

You don't need any extra hardware. Everything the app talks to is an mDNS advertisement and five HTTP endpoints, and [the Beamer repo](https://github.com/jendotpg/slippi-beamer) ships a stand-in:

```bash
tools/fake_beamer.py --name beamer-virtual-1 --port 8081 \
  --replays ~/Slippi/ --game ~/Slippi/Game_20230110T102627.slp \
  --station-name "Fake 1"
```

Run several on different ports for a fleet.

The game payload isn't canned: `--game` is peeked out of a real `.slp` by a port of `beamer::slp`.

The flags that reproduce states the app has to handle:

- `--unhealthy` -> `health: "error"`, which should turn the row's Live light red while still allowing a copy.
- `--warn "DRIVE FILLING,NO WII"` -> `health: "warn"` with those labels, which should turn the Live light amber and show the labels in its tooltip (a "can't write" warning like `DRIVE FULL` / `NO WII` reads as red).
- `--unreported` -> `503` on `GET /status`, which should drop the beamer off the list rather than raising an error.
- `--cap` / `--served` -> the `replay_cap` the station reports and how many replays it publishes, for the `17/512 replays` line.

This test doesn't emulate the USB gadget, the LED, the config file, the reset endpoint's actual destruction, the `409` you get from the station's API lock, or the timing of a real Beamer.
