import { app, BrowserWindow } from 'electron';
import DnsSd, { DnsSdBrowse } from '@fugood/dns-sd';
import { createSocket } from 'dgram';
import os from 'os';
import { mkdir, readdir, unlink } from 'fs/promises';
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
  SlpDownloadStatus,
  RequestFailure,
} from '../common/types';
import { assertInteger } from '../common/asserts';
import { maxGamesFromIndexCeiling } from '../common/constants';
import { hasCompleteFile } from './download';
import {
  beamerDirWritten,
  enqueueBeamerBackgroundPull,
  enqueueBeamerPull,
  initDownloadQueue,
  isBeamerDownloadPending,
  recordBeamerPullFailure,
} from './downloadQueue';

const INDEX_ATTEMPTS = 3;
const INDEX_RETRY_MS = 1000;

const PING_FAILS_BEFORE_OFFLINE = 3;

const EVENT_GROUP = '239.255.42.1';
const EVENT_PORT = 34700;

const STATUS_TIMEOUT_MS = 4000;
const MAX_STATUS_BYTES = 1024 * 1024;

export const beamerFullPath = path.join(
  app.getPath('userData'),
  'replayCache',
  'beamer',
);

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

function asHealth(value: unknown): BeamerHealth {
  return BEAMER_HEALTHS.includes(value as (typeof BEAMER_HEALTHS)[number])
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
    replayCount: asCount(status.replay_count),
    replayCap: asCount(status.replay_cap),
    health: asHealth(status.health),
    warnings: asWarnings(status.warnings),
    secsSincePortChange: asCount(status.secs_since_port_change),
    secsSinceGameStart: asCount(status.secs_since_game_start),
    reported: true,
    pingFails: 0,
    game: asGame(status.game),
  };
}

function isStatusBody(body: unknown): body is BeamerStatusBody {
  const record = asRecord(body);
  return Boolean(
    record &&
      typeof record.schema === 'number' &&
      typeof record.station_id === 'string',
  );
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
  } catch (e) {
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
  } catch (e) {
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
      reported = ''; // no usable error body...
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
      reported = ''; // no usable error body...
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function sanitizeReplayName(name: string): string {
  const base = path.basename(name);
  if (!base.endsWith('.slp') || base.startsWith('.')) {
    return '';
  }
  return base;
}

function parseBeamerEvent(buf: Buffer): BeamerEvent | null {
  const body = asRecord(safeJsonParse(buf));
  if (!body || !('schema' in body)) {
    return null;
  }
  if (!BEAMER_EVENT_KINDS.includes(body.event as BeamerEventKind)) {
    return null;
  }
  if (typeof body.station_id !== 'string' || !body.station_id) {
    return null;
  }
  const replay = asRecord(body.replay);
  const name =
    typeof replay?.name === 'string' ? sanitizeReplayName(replay.name) : '';
  if (!replay || !name || typeof replay.url !== 'string' || !replay.url) {
    return null;
  }
  return {
    event: body.event as BeamerEventKind,
    beamerId: body.station_id,
    beamerName: asString(body.station_name),
    replay: {
      name,
      size: asCount(replay.size),
      url: replay.url,
    },
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
  let last: unknown;
  for (let i = 0; i < INDEX_ATTEMPTS; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetch(`${origin}/SLIPPI/`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
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

export function beamerReplayUrl(url: string, origin: string): string {
  let resolved;
  try {
    resolved = new URL(url, origin);
  } catch {
    return '';
  }
  const resolvedStr = resolved.toString();
  const prefix = `${origin}/SLIPPI/`;
  return resolvedStr.startsWith(prefix) ? resolvedStr : '';
}

async function getBeamerIndex(origin: string) {
  let response;
  try {
    response = await fetchIndex(origin);
  } catch (e) {
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

  const index = asRecord(await readJson(response));
  const filesList = Array.isArray(index?.files) ? index.files : null;
  if (!index || !filesList) {
    throw new Error(`${origin} did not return a replay index.`);
  }

  const files: BeamerFile[] = [];
  filesList.forEach((entry: unknown) => {
    const file = asRecord(entry);
    if (!file || typeof file.url !== 'string' || !file.url) {
      return;
    }
    const url = beamerReplayUrl(file.url, origin);
    if (!url) {
      return; // malformed or off-origin url - skip the file
    }
    let name = '';
    try {
      const { pathname } = new URL(url);
      name = sanitizeReplayName(path.basename(decodeURIComponent(pathname)));
    } catch {
      return; // malformed percent-encoding - skip the file
    }
    if (!name) {
      return;
    }
    files.push({
      name,
      size: Number.isInteger(file.size) ? (file.size as number) : undefined,
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
  // the index is newest-first: the last present file is the oldest one we
  // have, so the next file after it is the newest replay we are missing
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
      if (
        name.endsWith('.part') &&
        isBeamerDownloadPending(dest, name.slice(0, -'.part'.length))
      ) {
        return;
      }
      try {
        await unlink(path.join(dest, name));
      } catch {
        // Already gone (or in use). The next refresh tries again.
      }
    }),
  );
  return stale;
}

let mainWindow: BrowserWindow | undefined;
let autoSubscribeBeamers = false;

const sendBeamerDownloadStatus = (status: SlpDownloadStatus) => {
  if (mainWindow) {
    mainWindow.webContents.send('beamer-download-status', status);
  }
};

type BeamerBase = Pick<Beamer, 'address' | 'host'>;

const createLiveBeamers = () => {
  const byId = new Map<string, Beamer>();
  const idByAddress = new Map<string, string>();

  const findByAddress = (address: string) => {
    const beamerId = idByAddress.get(address);
    return beamerId ? byId.get(beamerId) : undefined;
  };

  const remove = (beamerId: string) => {
    const removed = byId.get(beamerId);
    byId.delete(beamerId);
    if (removed && idByAddress.get(removed.address) === beamerId) {
      idByAddress.delete(removed.address);
    }
  };

  return {
    upsert: (beamer: Beamer) => {
      if (!beamer.beamerId) {
        throw new Error('Refusing to key a beamer with no station id.');
      }
      const existing = byId.get(beamer.beamerId);
      if (
        existing &&
        existing.address !== beamer.address &&
        idByAddress.get(existing.address) === beamer.beamerId
      ) {
        idByAddress.delete(existing.address);
      }
      const previous = findByAddress(beamer.address);
      if (previous && previous.beamerId !== beamer.beamerId) {
        byId.delete(previous.beamerId);
      }
      idByAddress.set(beamer.address, beamer.beamerId);
      byId.set(beamer.beamerId, beamer);
    },
    get: (beamerId: string) => byId.get(beamerId),
    findByAddress,
    findByHost: (host: string) =>
      Array.from(byId.values()).filter((beamer) => beamer.host === host),
    all: () => Array.from(byId.values()),
    remove,
    removeByAddress: (address: string) => {
      const existing = findByAddress(address);
      if (existing) {
        remove(existing.beamerId);
      }
    },
    markPingMiss: (base: BeamerBase) => {
      const existing = findByAddress(base.address);
      if (existing) {
        byId.set(existing.beamerId, {
          ...existing,
          pingFails: existing.pingFails + 1,
        });
      }
    },
  };
};

const liveBeamers = createLiveBeamers();

const createGhostList = () => {
  // a ghost is a beamer seen on mDNS that doesn't meet the HTTP API...
  const byAddress = new Map<string, BeamerBase>();

  return {
    upsert: (base: BeamerBase) => {
      byAddress.set(base.address, base);
    },
    findByHost: (host: string) =>
      Array.from(byAddress.values()).filter((base) => base.host === host),
    all: () => Array.from(byAddress.values()),
    remove: (address: string) => {
      byAddress.delete(address);
    },
  };
};

const ghosts = createGhostList();

const forgetBeamerAt = (address: string) => {
  ghosts.remove(address);
  liveBeamers.removeByAddress(address);
};

const rememberedBeamers = new Map<string, { origin: string; name: string }>();

function rememberBeamer(
  beamerId: string,
  origin: string,
  name: string | undefined,
) {
  if (!beamerId || !name) {
    return;
  }
  rememberedBeamers.set(beamerId, { origin, name });
}

const beamerLabel = (beamerId: string) =>
  rememberedBeamers.get(beamerId)?.name || beamerId || undefined;

const subscriptions = {
  subscribed: new Map<string, string>(), // stationId -> origin
  unsubscribed: new Set<string>(), // unsubscribes have session lifetimes
};

const isSubscribed = (beamer: Pick<Beamer, 'beamerId'>) =>
  subscriptions.subscribed.has(beamer.beamerId);

function rememberBeamerSubscription(origin: string, beamer: Beamer) {
  if (!beamer.beamerId) {
    return;
  }
  subscriptions.subscribed.set(beamer.beamerId, origin);
  rememberBeamer(beamer.beamerId, origin, beamer.beamerName);
}

const autoSubscribeCandidate = (beamer: Beamer) =>
  autoSubscribeBeamers &&
  beamer.reported &&
  Boolean(beamer.beamerId) &&
  !subscriptions.subscribed.has(beamer.beamerId) &&
  !subscriptions.unsubscribed.has(beamer.beamerId);

const browse = {
  handle: null as BeamerBrowseHandle | null,
  open: false,
  error: '',
};

const listedBeamers = () =>
  liveBeamers
    .all()
    .filter(
      (beamer) =>
        beamer.reported && beamer.pingFails < PING_FAILS_BEFORE_OFFLINE,
    )
    .flatMap((beamer) => {
      const label = beamerLabel(beamer.beamerId);
      return label
        ? [{ ...beamer, subscribed: isSubscribed(beamer), label }]
        : [];
    })
    .sort((a, b) => a.label.localeCompare(b.label));

const buildBeamerFleet = (): BeamerFleet => ({
  beamers: listedBeamers(),
  browsing: browse.handle !== null,
  error: browse.error,
});

const sendBeamerFleet = () => {
  if (mainWindow) {
    mainWindow.webContents.send('beamer-fleet', buildBeamerFleet());
  }
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

const refreshBeamer = async (base: BeamerBase) => {
  const origin = toBeamerOrigin(base.address);
  let result: StatusResult;
  try {
    result = await getBeamerStatus(origin);
  } catch {
    liveBeamers.markPingMiss(base);
    return;
  }
  const beamer =
    result.kind === 'status' ? beamerFromStatus(base, result.body) : null;

  if (!beamer || !beamer.beamerId) {
    liveBeamers.removeByAddress(base.address);
    ghosts.upsert(base);
    return;
  }

  const previous =
    liveBeamers.get(beamer.beamerId) ?? liveBeamers.findByAddress(base.address);
  liveBeamers.upsert(beamer);
  ghosts.remove(base.address);

  if (subscriptions.subscribed.has(beamer.beamerId)) {
    subscriptions.subscribed.set(beamer.beamerId, origin);
  }
  rememberBeamer(beamer.beamerId, origin, beamer.beamerName || beamer.beamerId);

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
  const bases = [...liveBeamers.all(), ...ghosts.all()].map(
    ({ address, host }) => ({ address, host }),
  );
  await Promise.all(bases.map((base) => refreshBeamer(base)));
  sendBeamerFleet();
}

let beamerEvents: BeamerEventsHandle | null = null;
const statusRefreshInFlight = new Set<string>();

const refreshBeamerForEvent = async (beamerId: string) => {
  const beamer = liveBeamers.get(beamerId);
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
  subscriptions.subscribed.has(beamerId) ||
  (autoSubscribeBeamers && !subscriptions.unsubscribed.has(beamerId));

const onBeamerEvent = (event: BeamerEvent) => {
  refreshBeamerForEvent(event.beamerId).catch(() => {});
  if (event.event === 'game_finished' && pullWanted(event.beamerId)) {
    const beamer = liveBeamers.get(event.beamerId);
    const origin =
      subscriptions.subscribed.get(event.beamerId) ||
      rememberedBeamers.get(event.beamerId)?.origin ||
      (beamer ? toBeamerOrigin(beamer.address) : '');
    if (origin) {
      try {
        const label = beamerLabel(event.beamerId);
        if (!label) {
          throw new Error('Refusing to pull for a beamer with no station id.');
        }
        const name = sanitizeReplayName(event.replay.name);
        const url = name ? beamerReplayUrl(event.replay.url, origin) : '';
        if (!name || !url) {
          throw new Error('Ignoring replay that fails beamer sanitization.');
        }
        enqueueBeamerBackgroundPull({
          dest: beamerDirFor(beamerFullPath, event.beamerId),
          name,
          url,
          size: event.replay.size,
          beamerId: event.beamerId,
          beamerName: label,
        });
      } catch {
        // unparseable replay url - it'll get fetched on select
      }
    }
  }
};

const startBeamerEvents = () => {
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

const stopBeamerEvents = () => {
  beamerEvents?.stop();
  beamerEvents = null;
};

const startBeamerBrowser = () => {
  if (browse.handle) {
    return;
  }
  browse.error = '';
  browse.handle = browseForBeamers({
    onFound: (base) => {
      const known = liveBeamers.findByAddress(base.address);
      if (known) {
        liveBeamers.upsert({ ...known, ...base });
      } else {
        ghosts.upsert(base);
      }
      sendBeamerFleet();
      refreshBeamer(base)
        .then(sendBeamerFleet)
        .catch(() => {
          sendBeamerFleet();
        });
    },
    onLost: (host) => {
      const sharing = [
        ...liveBeamers.findByHost(host),
        ...ghosts.findByHost(host),
      ];
      if (sharing.length === 0) {
        return;
      }
      if (sharing.length === 1) {
        forgetBeamerAt(sharing[0].address);
        sendBeamerFleet();
        return;
      }
      Promise.all(
        sharing.map(async (base) => {
          try {
            await getBeamerStatus(toBeamerOrigin(base.address));
          } catch {
            forgetBeamerAt(base.address);
          }
        }),
      )
        .then(sendBeamerFleet)
        .catch(() => {
          sendBeamerFleet();
        });
    },
    onError: (error) => {
      browse.error = error.message;
      sendBeamerFleet();
    },
  });
  sendBeamerFleet();
};

const stopBeamerBrowser = () => {
  browse.handle?.stop();
  browse.handle = null;
  browse.error = '';
};

const beamerListenersWanted = () =>
  browse.open || autoSubscribeBeamers || subscriptions.subscribed.size > 0;

const updateBeamerListeners = () => {
  if (beamerListenersWanted()) {
    startBeamerBrowser();
    startBeamerEvents();
  } else {
    stopBeamerBrowser();
    stopBeamerEvents();
  }
};

const stopBrowse = () => {
  browse.open = false;
  updateBeamerListeners();
};

export function startBeamerBrowse() {
  browse.open = true;
  updateBeamerListeners();
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
  const beamer = liveBeamers.get(beamerId);
  const origin =
    (beamer ? toBeamerOrigin(beamer.address) : '') ||
    rememberedBeamers.get(beamerId)?.origin ||
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
  enqueueBeamerPull(dest, files.slice(0, maxGames), indexBeamerId, label).catch(
    (e) => {
      recordBeamerPullFailure(indexBeamerId, label, e);
    },
  );
  return { dest, display: label, beamerId: indexBeamerId };
}

export async function refreshFromBeamer(
  beamerId: string,
  dir: string,
  maxGames: number,
) {
  const origin = rememberedBeamers.get(beamerId)?.origin;
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
  const origin = rememberedBeamers.get(beamerId)?.origin;
  if (!origin) {
    return '';
  }
  try {
    const { files } = await getBeamerIndex(origin);
    return (await nextOlderMissingFile(dir, files))?.name ?? '';
  } catch {
    return ''; // beamer unreachable - there is no previous replay
  }
}

export async function downloadPreviousBeamerReplay(
  beamerId: string,
  dir: string,
) {
  const origin = rememberedBeamers.get(beamerId)?.origin;
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

function setBeamerSubscription(beamerId: string, subscribed: boolean) {
  if (subscribed) {
    const beamer = liveBeamers.get(beamerId);
    if (beamer) {
      rememberBeamerSubscription(toBeamerOrigin(beamer.address), beamer);
    } else {
      const rememberedOrigin = rememberedBeamers.get(beamerId)?.origin;
      if (rememberedOrigin) {
        subscriptions.subscribed.set(beamerId, rememberedOrigin);
      }
    }
  } else {
    subscriptions.unsubscribed.add(beamerId);
    subscriptions.subscribed.delete(beamerId);
  }
  updateBeamerListeners();
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
  updateBeamerListeners();
}

export async function refreshBeamerStatus(beamerId: string) {
  const existing = liveBeamers.get(beamerId);
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
): Promise<RequestFailure[]> => {
  const targets = listedBeamers();
  if (targets.length === 0) {
    throw new Error('No beamers are advertising themselves.');
  }

  const results = await Promise.allSettled(targets.map(action));

  const failures: RequestFailure[] = [];
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
  const existing = liveBeamers.get(beamerId);
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

export function clampMaxGamesFromIndex(newMaxGamesFromIndex: number) {
  return Math.min(
    Math.max(assertInteger(newMaxGamesFromIndex), 1),
    maxGamesFromIndexCeiling,
  );
}

export function initBeamers(
  initMainWindow: BrowserWindow,
  initAutoSubscribe: boolean,
) {
  mainWindow = initMainWindow;
  autoSubscribeBeamers = initAutoSubscribe;
  initDownloadQueue(sendBeamerDownloadStatus);
  updateBeamerListeners();
}
