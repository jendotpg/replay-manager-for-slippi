import { app, BrowserWindow } from 'electron';
import DnsSd, { DnsSdBrowse } from '@fugood/dns-sd';
import { createSocket } from 'dgram';
import os from 'os';
import { mkdir, readdir, rm, stat, unlink } from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import { parse as parseIpaddr } from 'ipaddr.js';
import {
  BEAMER_EVENT_KINDS,
  BEAMER_HEALTHS,
  Beamer,
  BeamerEvent,
  BeamerEventKind,
  BeamerFile,
  BeamerFleet,
  BeamerGame,
  BeamerHealth,
  BeamerPort,
  BeamerStatusBody,
  DownloadStatus,
  DownloadFailure,
} from '../common/types';
import { assertInteger } from '../common/asserts';
import { hasCompleteFile } from './download';
import {
  beamerDirWritten,
  cancelBeamerDownload,
  enqueueBeamerDownload,
  enqueueBeamerPull,
  initDownloadQueue,
  prioritizeBeamer,
} from './downloadQueue';

export { beamerDirWritten, cancelBeamerDownload };

const INDEX_ATTEMPTS = 3;
const INDEX_RETRY_MS = 1000;

const PING_FAILS_BEFORE_OFFLINE = 3;

const EVENT_GROUP = '239.255.42.1';
const EVENT_PORT = 34700;

const STATUS_TIMEOUT_MS = 4000;
const MAX_STATUS_BYTES = 1024 * 1024;

export const replayCacheFullPath = path.join(
  app.getPath('userData'),
  'replayCache',
);
export const beamerFullPath = path.join(replayCacheFullPath, 'beamer');

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPort(value: unknown): BeamerPort | null {
  const record = asRecord(value);
  if (!record || !Number.isInteger(record.port)) {
    return null;
  }
  return {
    port: record.port as number,
    charId:
      Number.isInteger(record.char_id) && (record.char_id as number) >= 0
        ? (record.char_id as number)
        : null,
    costume: Number.isInteger(record.costume) ? (record.costume as number) : 0,
    char: asString(record.char),
    color: asString(record.color),
    nametag: asString(record.nametag),
  };
}

function asGame(value: unknown): BeamerGame | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.ports)) {
    return null;
  }
  const ports = (record.ports as unknown[])
    .map(asPort)
    .filter((port: BeamerPort | null): port is BeamerPort => port !== null);
  return { live: record.live === true, ports };
}

const HEALTHS: BeamerHealth[] = BEAMER_HEALTHS.filter(
  (health) => health !== 'unknown',
);

function asHealth(value: unknown): BeamerHealth {
  return HEALTHS.includes(value as BeamerHealth)
    ? (value as BeamerHealth)
    : 'unknown';
}

function asCount(value: unknown) {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function asWarnings(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (warning): warning is string =>
          typeof warning === 'string' && warning.length > 0,
      )
    : [];
}

function beamerFromStatus(
  base: Pick<Beamer, 'address' | 'host'>,
  status: BeamerStatusBody,
): Beamer {
  return {
    ...base,
    beamerId: asString(status.station_id),
    beamerName: asString(status.station_name),
    ssid: asString(status.ssid),
    arch: asString(status.arch),
    ssh: status.ssh === true,
    replayCount: asCount(status.replay_count),
    replayCap: asCount(status.replay_cap),
    health: asHealth(status.health),
    warnings: asWarnings(status.warnings),
    secsSincePortChange: asCount(status.secs_since_port_change),
    secsSinceCharacterChange: asCount(status.secs_since_character_change),
    secsSinceGameStart: asCount(status.secs_since_game_start),
    reported: true,
    pingFails: 0,
    game: asGame(status.game),
    subscribed: false,
  };
}

function unreportedBeamer(base: Pick<Beamer, 'address' | 'host'>): Beamer {
  return {
    ...base,
    beamerId: '',
    beamerName: '',
    ssid: '',
    arch: '',
    ssh: false,
    health: 'unknown',
    warnings: [],
    reported: false,
    pingFails: 0,
    game: null,
    subscribed: false,
  };
}

function isStatusBody(body: unknown): body is BeamerStatusBody {
  const record = asRecord(body);
  return Boolean(record && 'schema' in record && 'station_id' in record);
}

async function readStatus(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STATUS_BYTES) {
    throw new Error('That beamer sent back far more than a status report.');
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > MAX_STATUS_BYTES) {
      reader.cancel();
      throw new Error('That beamer sent back far more than a status report.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

type StatusResult =
  | { kind: 'status'; body: BeamerStatusBody }
  | { kind: 'unreported' };

async function getBeamerStatus(origin: string): Promise<StatusResult> {
  let response;
  try {
    response = await fetch(`${origin}/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError')
    ) {
      throw new Error(`${origin} did not respond.`);
    }
    throw new Error(`Could not reach a Beamer at ${origin}.`);
  }

  if (response.status === 503) {
    return { kind: 'unreported' };
  }
  if (!response.ok) {
    throw new Error(`${origin} answered ${response.status} for /status.`);
  }

  const body = await readStatus(response);
  if (!isStatusBody(body)) {
    throw new Error(
      `${origin} did not return a status report. Is it a Beamer?`,
    );
  }
  return { kind: 'status', body };
}

const RESET_TIMEOUT_MS = 90000;

async function requestBeamerReset(origin: string) {
  let response;
  try {
    response = await fetch(`${origin}/reset-beamer`, {
      method: 'POST',
      headers: { 'X-Beamer-Confirm': 'reset' },
      body: '',
      signal: AbortSignal.timeout(RESET_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError')
    ) {
      throw new Error(
        `${origin} did not answer the reset. Check the beamer before assuming its replays survived.`,
      );
    }
    throw new Error(`Could not reach a Beamer at ${origin}.`);
  }

  if (response.status === 409) {
    let reported = '';
    try {
      const body = await response.json();
      reported = typeof body?.error === 'string' ? body.error : '';
    } catch {
      reported = '';
    }
    throw new Error(
      reported
        ? `That beamer refused: ${reported}. Nothing was erased - try again in a moment.`
        : 'That beamer is busy sending a replay, or with another action. Nothing was erased - try again in a moment.',
    );
  }
  if (response.status === 400) {
    throw new Error(
      `${origin} refused the reset confirmation header. Is that a Beamer?`,
    );
  }
  if (!response.ok) {
    let reported = '';
    try {
      const body = await response.json();
      reported = typeof body?.error === 'string' ? body.error : '';
    } catch {
      reported = '';
    }
    throw new Error(
      reported || `${origin} answered ${response.status} for /reset-beamer.`,
    );
  }
}

function addressFor(service: { addresses: string[]; port: number }) {
  const hasDots = (candidate: string) => candidate.includes('.');
  const isRoutable = (candidate: string) =>
    !candidate.startsWith('127.') && !candidate.startsWith('169.254.');

  const address =
    service.addresses.find(
      (candidate) => hasDots(candidate) && isRoutable(candidate),
    ) ??
    service.addresses.find(hasDots) ??
    service.addresses[0] ??
    '';
  if (!address) {
    return '';
  }
  const bracketed = address.includes(':') ? `[${address}]` : address;
  return service.port === 80 ? bracketed : `${bracketed}:${service.port}`;
}

type BeamerBrowseHandle = {
  stop: () => void;
};

function browseForBeamers(callbacks: {
  onFound: (base: Pick<Beamer, 'address' | 'host'>) => void;
  onLost: (host: string) => void;
  onError: (error: Error) => void;
}): BeamerBrowseHandle {
  let browser: DnsSdBrowse | null = DnsSd.search('_beamer._tcp')
    .on('serviceFound', (service) => {
      const address = addressFor(service);
      if (!address) {
        return;
      }
      callbacks.onFound({
        address,
        host: service.name,
      });
    })
    .on('serviceLost', (service) => {
      callbacks.onLost(service.name);
    })
    .on('error', (error) => {
      callbacks.onError(error);
    });

  return {
    stop: () => {
      if (browser) {
        browser.removeAllListeners();
        browser.stop();
        browser = null;
      }
    },
  };
}

function safeJsonParse(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

function parseBeamerEvent(buf: Buffer): BeamerEvent | null {
  const body = asRecord(safeJsonParse(buf));
  if (!body || !('schema' in body)) {
    return null;
  }
  if (!BEAMER_EVENT_KINDS.includes(body.event as BeamerEventKind)) {
    return null;
  }
  if (
    typeof body.station_id !== 'string' ||
    !body.station_id ||
    !Number.isInteger(body.seq)
  ) {
    return null;
  }
  const replay = asRecord(body.replay);
  if (
    !replay ||
    typeof replay.name !== 'string' ||
    !replay.name ||
    typeof replay.url !== 'string' ||
    !replay.url
  ) {
    return null;
  }
  const game = asGame(body.game);
  return {
    event: body.event as BeamerEventKind,
    beamerId: body.station_id,
    beamerName: asString(body.station_name),
    seq: body.seq as number,
    replay: {
      name: replay.name,
      size: asCount(replay.size),
      url: replay.url,
    },
    game,
  };
}

type BeamerEventsHandle = {
  stop: () => void;
};

function subscribeBeamerEvents(callbacks: {
  onEvent: (event: BeamerEvent, fromAddress: string) => void;
  onError: (error: Error) => void;
}): BeamerEventsHandle {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (error) => {
    callbacks.onError(error);
  });
  socket.on('message', (msg, rinfo) => {
    const event = parseBeamerEvent(msg);
    if (event) {
      callbacks.onEvent(event, rinfo.address);
    }
  });

  socket.bind(EVENT_PORT, () => {
    const join = (iface?: string) => {
      try {
        socket.addMembership(EVENT_GROUP, iface);
      } catch {
        // already a member on this interface, or it cannot join here
      }
    };
    join();
    Object.values(os.networkInterfaces()).forEach((ifaces) => {
      (ifaces ?? []).forEach((ni) => {
        if (ni.family === 'IPv4' && !ni.internal) {
          join(ni.address);
        }
      });
    });
  });

  return {
    stop: () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}

function toBeamerOrigin(addressOrHost: string) {
  // beamers have no TLS by design - strip https and force http
  const trimmed = addressOrHost
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Enter a Beamer address.');
  }

  let host = trimmed;
  try {
    const ipaddr = parseIpaddr(trimmed);
    host =
      ipaddr.kind() === 'ipv4' ? ipaddr.toString() : `[${ipaddr.toString()}]`;
  } catch {
    // Not an IP. Leave it alone so hostnames like beamer-3f2a.local work.
  }
  return `http://${host}`;
}

async function fetchIndex(origin: string) {
  let last: any;
  for (let i = 0; i < INDEX_ATTEMPTS; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetch(`${origin}/SLIPPI/`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (e: any) {
      last = e;
      if (i < INDEX_ATTEMPTS - 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, INDEX_RETRY_MS);
        });
      }
    }
  }
  throw last;
}

async function getBeamerIndex(origin: string) {
  let response;
  try {
    response = await fetchIndex(origin);
  } catch (e: any) {
    if (
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError')
    ) {
      throw new Error(`${origin} did not respond.`);
    }
    throw new Error(`Could not reach a Beamer at ${origin}.`);
  }
  if (!response.ok) {
    throw new Error(
      `${origin} answered ${response.status} for /SLIPPI/. Is that a Beamer?`,
    );
  }

  let index: any;
  try {
    index = await response.json();
  } catch {
    index = null;
  }
  if (!Array.isArray(index?.files)) {
    throw new Error(`${origin} did not return a replay index.`);
  }

  const prefix = `${origin}/SLIPPI/`;
  const files: BeamerFile[] = [];
  index.files.forEach((file: any) => {
    if (typeof file?.url !== 'string' || !file.url) {
      return;
    }
    let resolved;
    try {
      resolved = new URL(file.url, origin);
    } catch {
      return;
    }
    const url = resolved.toString();
    if (!url.startsWith(prefix)) {
      return;
    }
    let name;
    try {
      name = path.basename(decodeURIComponent(resolved.pathname));
    } catch {
      return;
    }
    if (!name.endsWith('.slp') || name.startsWith('.')) {
      return;
    }
    files.push({
      name,
      size: Number.isInteger(file.size) ? file.size : undefined,
      url,
    });
  });
  return {
    beamerId: typeof index.station_id === 'string' ? index.station_id : '',
    files,
  };
}

function beamerDirFor(cacheRoot: string, beamerId: string) {
  if (!beamerId) {
    throw new Error(
      'Refusing to cache replays for a beamer with no station id.',
    );
  }
  const label = sanitize(beamerId.replace(/:/g, '_'));
  if (!label) {
    throw new Error(`Could not derive a cache directory for ${beamerId}.`);
  }
  return path.join(cacheRoot, label);
}

async function nextOlderMissingFile(dest: string, files: BeamerFile[]) {
  const present = await Promise.all(
    files.map((file) => hasCompleteFile(dest, file)),
  );
  const oldestPresent = present.lastIndexOf(true);
  return oldestPresent >= 0 && oldestPresent + 1 < files.length
    ? files[oldestPresent + 1]
    : null;
}

async function listCachedReplays(dest: string) {
  try {
    return (await readdir(dest, { withFileTypes: true }))
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.slp'))
      .map((dirent) => dirent.name);
  } catch {
    return [];
  }
}

async function pruneStaleReplays(
  dest: string,
  cached: string[],
  indexNames: string[],
) {
  const keep = new Set(indexNames);
  const stale = cached.filter((name) => !keep.has(name));

  let parts: string[] = [];
  try {
    parts = (await readdir(dest, { withFileTypes: true }))
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.slp.part'))
      .map((dirent) => dirent.name)
      .filter((name) => !keep.has(name.slice(0, -'.part'.length)));
  } catch {
    // Already gone.
  }

  await Promise.all(
    [...stale, ...parts].map(async (name) => {
      try {
        await unlink(path.join(dest, name));
      } catch {
        // Already gone, or in use. The next refresh tries again.
      }
    }),
  );
  return stale;
}

async function measureReplayCache(cacheRoot: string) {
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string) => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      dirents.map(async (dirent) => {
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(full);
          return;
        }
        if (
          !dirent.name.endsWith('.slp') &&
          !dirent.name.endsWith('.slp.part')
        ) {
          return;
        }
        try {
          const stats = await stat(full);
          files += 1;
          bytes += stats.size;
        } catch {
          // gone between the readdir and the stat...
        }
      }),
    );
  };

  await walk(cacheRoot);
  return { files, bytes };
}

async function wipeReplayCache(cacheRoot: string) {
  await rm(cacheRoot, { recursive: true, force: true });
}

let mainWindow: BrowserWindow | undefined;
let autoSubscribeBeamers = false;

const sendBeamerDownloadStatus = (status: DownloadStatus) => {
  mainWindow?.webContents.send('beamerDownloadStatus', status);
};

const originByBeamer = new Map<string, string>();
const nameByBeamer = new Map<string, string>();

function rememberBeamer(
  beamerId: string,
  origin: string,
  name: string | undefined,
) {
  if (!beamerId || !name) {
    return;
  }
  originByBeamer.set(beamerId, origin);
  nameByBeamer.set(beamerId, name);
}

const beamerLabel = (beamerId: string) =>
  nameByBeamer.get(beamerId) || beamerId || undefined;

const beamers = new Map<string, Beamer>();
let beamerBrowse: BeamerBrowseHandle | null = null;
let beamerBrowseOpen = false; // the fleet dialog is holding the browser open
let beamerFleetError = '';

const subscribedBeamers = new Map<string, string>();
const isSubscribed = (beamer: Pick<Beamer, 'beamerId'>) =>
  subscribedBeamers.has(beamer.beamerId);

// unsubscribes only have session lifetimes
const unsubscribed = new Set<string>();

function rememberBeamerSubscription(origin: string, beamer: Beamer) {
  if (!beamer.beamerId) {
    return;
  }
  subscribedBeamers.set(beamer.beamerId, origin);
  rememberBeamer(beamer.beamerId, origin, beamer.beamerName);
}

const autoSubscribeCandidate = (beamer: Beamer) =>
  autoSubscribeBeamers &&
  beamer.reported &&
  Boolean(beamer.beamerId) &&
  !subscribedBeamers.has(beamer.beamerId) &&
  !unsubscribed.has(beamer.beamerId);

const listedBeamers = () =>
  Array.from(beamers.values())
    .filter(
      (beamer) =>
        beamer.reported && beamer.pingFails < PING_FAILS_BEFORE_OFFLINE,
    )
    .map((beamer) => {
      const label = beamerLabel(beamer.beamerId);
      if (!label) {
        throw new Error('Refusing to list a beamer with no station id.');
      }
      return {
        ...beamer,
        subscribed: isSubscribed(beamer),
        label,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

const buildBeamerFleet = (): BeamerFleet => ({
  beamers: listedBeamers(),
  browsing: beamerBrowse !== null,
  error: beamerFleetError,
});

const sendBeamerFleet = () => {
  mainWindow?.webContents.send('beamerFleet', buildBeamerFleet());
};

const pruneStaleReplaysFor = async (
  origin: string,
  beamer: Beamer,
  previousCount?: number,
) => {
  if (!beamer.beamerId) {
    return;
  }
  const dest = beamerDirFor(beamerFullPath, beamer.beamerId);
  const cached = await listCachedReplays(dest);
  if (cached.length === 0) {
    return;
  }

  if (
    previousCount != null &&
    beamer.replayCount != null &&
    beamer.replayCount === previousCount
  ) {
    return;
  }

  const { files } = await getBeamerIndex(origin);
  const stale = await pruneStaleReplays(
    dest,
    cached,
    files.map((file) => file.name),
  );
  if (stale.length === 0) {
    return;
  }

  beamerDirWritten.emit('dirWritten', dest);
};

type BeamerBase = Pick<Beamer, 'address' | 'host'>;

// one missed ping: bump the strike count, keep the last-known record
const markPingMiss = (base: BeamerBase) => {
  const existing = Array.from(beamers.values()).find(
    (beamer) => beamer.address === base.address,
  );
  if (!existing) {
    return;
  }
  beamers.set(existing.beamerId || existing.address, {
    ...existing,
    pingFails: existing.pingFails + 1,
  });
};

const refreshBeamer = async (base: BeamerBase) => {
  const origin = toBeamerOrigin(base.address);
  let result: StatusResult;
  try {
    result = await getBeamerStatus(origin);
  } catch {
    markPingMiss(base);
    return;
  }
  const beamer =
    result.kind === 'status'
      ? beamerFromStatus(base, result.body)
      : unreportedBeamer(base);

  if (result.kind === 'status' && !beamer.beamerId) {
    markPingMiss(base);
    return;
  }

  const key = beamer.beamerId || base.address; // key by address until uuid is reported
  const previous =
    (beamer.beamerId ? beamers.get(beamer.beamerId) : undefined) ||
    beamers.get(base.address);
  Array.from(beamers.entries()).forEach(([otherKey, other]) => {
    if (otherKey !== key && other.beamerId === beamer.beamerId) {
      beamers.delete(otherKey);
    }
  });
  beamers.delete(base.address);
  beamers.set(key, beamer);

  if (beamer.beamerId) {
    if (subscribedBeamers.has(beamer.beamerId)) {
      subscribedBeamers.set(beamer.beamerId, origin);
    }
    rememberBeamer(
      beamer.beamerId,
      origin,
      beamer.beamerName || beamer.beamerId,
    );
  }

  if (autoSubscribeCandidate(beamer)) {
    rememberBeamerSubscription(origin, beamer);
  }

  try {
    await pruneStaleReplaysFor(origin, beamer, previous?.replayCount);
  } catch {
    // if there's no index, we don't know whats stale - just noop.
  }
};

export async function refreshAllBeamers() {
  const bases = Array.from(beamers.values()).map(({ address, host }) => ({
    address,
    host,
  }));
  await Promise.all(bases.map((base) => refreshBeamer(base)));
  sendBeamerFleet();
}

let beamerEvents: BeamerEventsHandle | null = null;
const statusRefreshInFlight = new Set<string>();

const refreshBeamerForEvent = async (beamerId: string) => {
  const beamer = beamers.get(beamerId);
  if (!beamer || statusRefreshInFlight.has(beamerId)) {
    return;
  }
  statusRefreshInFlight.add(beamerId);
  try {
    await refreshBeamer({
      address: beamer.address,
      host: beamer.host,
    });
    sendBeamerFleet();
  } finally {
    statusRefreshInFlight.delete(beamerId);
  }
};

const pullWanted = (beamerId: string) =>
  subscribedBeamers.has(beamerId) ||
  (autoSubscribeBeamers && !unsubscribed.has(beamerId));

const onBeamerEvent = (event: BeamerEvent) => {
  refreshBeamerForEvent(event.beamerId).catch(() => {});
  if (event.event === 'game_finished' && pullWanted(event.beamerId)) {
    const beamer = beamers.get(event.beamerId);
    const origin =
      subscribedBeamers.get(event.beamerId) ||
      originByBeamer.get(event.beamerId) ||
      (beamer ? toBeamerOrigin(beamer.address) : '');
    if (origin) {
      try {
        const label = beamerLabel(event.beamerId);
        if (!label) {
          throw new Error('Refusing to pull for a beamer with no station id.');
        }
        enqueueBeamerDownload(
          {
            dest: beamerDirFor(beamerFullPath, event.beamerId),
            name: event.replay.name,
            url: new URL(event.replay.url, origin).toString(),
            size: event.replay.size,
            beamerId: event.beamerId,
            beamerName: label,
          },
          'low',
        );
      } catch {
        // unparseable replay url - it'll get fetched on select
      }
    }
  }
};

const ensureBeamerEvents = () => {
  // turned on as soon as a beamer is first seen
  if (beamerEvents) {
    return;
  }
  beamerEvents = subscribeBeamerEvents({
    onEvent: onBeamerEvent,
    onError: () => {
      // best-effort: a bind/join failure just means no live hints this session
    },
  });
};

const startBeamerBrowser = () => {
  if (beamerBrowse) {
    return;
  }
  beamerFleetError = '';
  beamerBrowse = browseForBeamers({
    onFound: (base) => {
      ensureBeamerEvents();
      const existing = Array.from(beamers.entries()).find(
        ([, beamer]) => beamer.address === base.address,
      );
      if (existing) {
        beamers.set(existing[0], { ...existing[1], ...base });
      } else {
        beamers.set(base.address, unreportedBeamer(base));
      }
      sendBeamerFleet();
      refreshBeamer(base)
        .then(sendBeamerFleet)
        .catch(() => {
          sendBeamerFleet();
        });
    },
    onLost: (host) => {
      const sharing = Array.from(beamers.entries()).filter(
        ([, beamer]) => beamer.host === host,
      );
      if (sharing.length === 0) {
        return;
      }
      if (sharing.length === 1) {
        beamers.delete(sharing[0][0]);
        sendBeamerFleet();
        return;
      }
      Promise.all(
        sharing.map(async ([key, beamer]) => {
          try {
            await getBeamerStatus(toBeamerOrigin(beamer.address));
          } catch {
            beamers.delete(key);
          }
        }),
      )
        .then(sendBeamerFleet)
        .catch(() => {
          sendBeamerFleet();
        });
    },
    onError: (error) => {
      beamerFleetError = error.message;
      sendBeamerFleet();
    },
  });
  sendBeamerFleet();
};

const stopBeamerBrowser = () => {
  beamerBrowse?.stop();
  beamerBrowse = null;
  beamerFleetError = '';
};

const beamerBrowseWanted = () =>
  beamerBrowseOpen || autoSubscribeBeamers || subscribedBeamers.size > 0;

const updateBeamerBrowser = () => {
  if (beamerBrowseWanted()) {
    startBeamerBrowser();
  } else {
    stopBeamerBrowser();
  }
};

const stopBrowse = () => {
  beamerBrowseOpen = false;
  updateBeamerBrowser();
};

export function startBeamerBrowse() {
  beamerBrowseOpen = true;
  startBeamerBrowser();
  refreshAllBeamers().catch(() => {}); // truth-check the fleet the moment the dialog opens
  sendBeamerFleet();
}

export function stopBeamerBrowse() {
  stopBrowse();
}

export function getBeamerFleet(): BeamerFleet {
  return buildBeamerFleet();
}

export async function selectBeamer(beamerId: string, maxGames: number) {
  const beamer = beamers.get(beamerId);
  const origin =
    (beamer ? toBeamerOrigin(beamer.address) : '') ||
    originByBeamer.get(beamerId) ||
    '';
  if (!origin) {
    throw new Error('That beamer is no longer advertising itself.');
  }
  stopBrowse();

  const indexPromise = getBeamerIndex(origin);
  const statusPromise = getBeamerStatus(origin).catch(() => null);
  const { beamerId: indexBeamerId, files } = await indexPromise;
  const remembered = beamerLabel(indexBeamerId);
  if (!remembered) {
    throw new Error('A beamer did not report its station id.');
  }
  const status = await statusPromise;
  const beamerName =
    status?.kind === 'status' && typeof status.body.station_name === 'string'
      ? status.body.station_name
      : '';
  const label = beamerName || remembered;

  const dest = beamerDirFor(beamerFullPath, indexBeamerId);

  await mkdir(dest, { recursive: true });
  rememberBeamer(indexBeamerId, origin, label);

  prioritizeBeamer(indexBeamerId);
  enqueueBeamerPull(dest, files.slice(0, maxGames), indexBeamerId, label).catch(
    (e) => {
      sendBeamerDownloadStatus({
        status: 'error',
        failedFiles: [{ reason: e instanceof Error ? e.message : String(e) }],
      });
    },
  );
  return { dest, display: label, beamerId: indexBeamerId };
}

export async function refreshFromBeamer(
  beamerId: string,
  dir: string,
  maxGames: number,
) {
  const origin = originByBeamer.get(beamerId);
  if (!origin) {
    throw new Error('Those replays are no longer loaded from a Beamer.');
  }

  const { files } = await getBeamerIndex(origin);
  const label = beamerLabel(beamerId);
  if (!label) {
    throw new Error('Those replays are no longer loaded from a Beamer.');
  }
  await enqueueBeamerPull(dir, files.slice(0, maxGames), beamerId, label);
}

export async function getPreviousBeamerReplay(beamerId: string, dir: string) {
  const origin = originByBeamer.get(beamerId);
  if (!origin) {
    return '';
  }
  try {
    const { files } = await getBeamerIndex(origin);
    return (await nextOlderMissingFile(dir, files))?.name ?? '';
  } catch {
    return '';
  }
}

export async function downloadPreviousBeamerReplay(
  beamerId: string,
  dir: string,
) {
  const origin = originByBeamer.get(beamerId);
  if (!origin) {
    throw new Error('Those replays are no longer loaded from a Beamer.');
  }
  const { files } = await getBeamerIndex(origin);
  const previous = await nextOlderMissingFile(dir, files);
  if (!previous) {
    return;
  }

  const label = beamerLabel(beamerId);
  if (!label) {
    throw new Error('Those replays are no longer loaded from a Beamer.');
  }
  await enqueueBeamerPull(dir, [previous], beamerId, label);
}

export function getReplayCacheSize() {
  return measureReplayCache(replayCacheFullPath);
}

export async function clearReplayCache() {
  cancelBeamerDownload();
  await wipeReplayCache(replayCacheFullPath);
}

function setBeamerSubscription(beamerId: string, subscribed: boolean) {
  if (subscribed) {
    const beamer = beamers.get(beamerId);
    if (beamer) {
      rememberBeamerSubscription(toBeamerOrigin(beamer.address), beamer);
    } else {
      const remembered = originByBeamer.get(beamerId);
      if (remembered) {
        subscribedBeamers.set(beamerId, remembered);
      }
    }
  } else {
    unsubscribed.add(beamerId);
    subscribedBeamers.delete(beamerId);
    updateBeamerBrowser();
  }
}

export function setBeamerSubscribed(beamerId: string, subscribed: boolean) {
  setBeamerSubscription(beamerId, subscribed);
  sendBeamerFleet();
}

export function getBeamersAutoSubscribe() {
  return autoSubscribeBeamers;
}

export function setBeamersAutoSubscribe(on: boolean) {
  autoSubscribeBeamers = on;
  if (on) {
    const swept = listedBeamers().filter(autoSubscribeCandidate);
    swept.forEach((beamer) =>
      rememberBeamerSubscription(toBeamerOrigin(beamer.address), beamer),
    );
    if (swept.length > 0) {
      sendBeamerFleet();
    }
  }
  updateBeamerBrowser();
}

export async function refreshBeamerStatus(beamerId: string) {
  const existing = beamers.get(beamerId);
  if (!existing) {
    throw new Error('That beamer is no longer advertising itself.');
  }
  await refreshBeamer({
    address: existing.address,
    host: existing.host,
  });
  sendBeamerFleet();
}

const runOverFleet = async (
  action: (beamer: Beamer) => Promise<void>,
): Promise<DownloadFailure[]> => {
  const targets = listedBeamers();
  if (targets.length === 0) {
    throw new Error('No beamers are advertising themselves.');
  }

  const results = await Promise.allSettled(targets.map(action));

  const failures: DownloadFailure[] = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const beamer = targets[i];
      failures.push({
        label: beamer.label,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });

  sendBeamerFleet();
  return failures;
};

export async function resetBeamer(beamerId: string) {
  const existing = beamers.get(beamerId);
  if (!existing) {
    throw new Error('That beamer is no longer advertising itself.');
  }
  const base = { address: existing.address, host: existing.host };
  await requestBeamerReset(toBeamerOrigin(base.address));
  await refreshBeamer(base);
  sendBeamerFleet();
}

export function resetAllBeamers() {
  return runOverFleet(async (beamer) => {
    const base = { address: beamer.address, host: beamer.host };
    await requestBeamerReset(toBeamerOrigin(base.address));
    await refreshBeamer(base);
  });
}

const MAX_GAMES_FROM_INDEX_CEILING = 16;

export function clampMaxGamesFromIndex(newMaxGamesFromIndex: number) {
  return Math.min(
    Math.max(assertInteger(newMaxGamesFromIndex), 1),
    MAX_GAMES_FROM_INDEX_CEILING,
  );
}

export function initBeamers(
  initMainWindow: BrowserWindow,
  initAutoSubscribe: boolean,
) {
  mainWindow = initMainWindow;
  autoSubscribeBeamers = initAutoSubscribe;
  initDownloadQueue(sendBeamerDownloadStatus);
  updateBeamerBrowser();
}
