import DnsSd, { DnsSdBrowse } from '@fugood/dns-sd';
import {
  BeamerGame,
  BeamerHealth,
  BeamerPort,
  BeamerStation,
} from '../common/types';

export const FLEET_POLL_MS = 10000;

const STATUS_TIMEOUT_MS = 4000;
const STATUS_POST_TIMEOUT_MS = 30000;
const MAX_STATUS_BYTES = 1024 * 1024;

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asPort(value: any): BeamerPort | null {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.port)) {
    return null;
  }
  return {
    port: value.port,
    charId:
      Number.isInteger(value.char_id) && value.char_id >= 0
        ? value.char_id
        : null,
    costume: Number.isInteger(value.costume) ? value.costume : 0,
    char: asString(value.char),
    color: asString(value.color),
    nametag: asString(value.nametag),
  };
}

function asGame(value: any): BeamerGame | null {
  if (!value || typeof value !== 'object' || !Array.isArray(value.ports)) {
    return null;
  }
  const ports = value.ports
    .map(asPort)
    .filter((port: BeamerPort | null): port is BeamerPort => port !== null);
  return { live: value.live === true, ports };
}

const HEALTHS: BeamerHealth[] = ['ok', 'starting', 'warn', 'error'];

function asHealth(value: unknown): BeamerHealth {
  return HEALTHS.includes(value as BeamerHealth)
    ? (value as BeamerHealth)
    : 'unknown';
}

function asCount(value: unknown) {
  return Number.isInteger(value) ? (value as number) : -1;
}

function asSecs(value: unknown) {
  return Number.isInteger(value) ? (value as number) : null;
}

function asWarnings(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (warning): warning is string =>
          typeof warning === 'string' && warning.length > 0,
      )
    : [];
}

export function stationFromStatus(
  base: Pick<BeamerStation, 'address' | 'host'>,
  status: any,
): BeamerStation {
  return {
    ...base,
    stationId: asString(status.station_id),
    stationName: asString(status.station_name),
    ssid: asString(status.ssid),
    arch: asString(status.arch),
    ssh: status.ssh === true,
    replayCount: asCount(status.replay_count),
    replayCap: asCount(status.replay_cap),
    health: asHealth(status.health),
    warnings: asWarnings(status.warnings),
    secsSincePortChange: asSecs(status.secs_since_port_change),
    secsSinceCharacterChange: asSecs(status.secs_since_character_change),
    reported: true,
    game: asGame(status.game),
  };
}

export function unreportedStation(
  base: Pick<BeamerStation, 'address' | 'host'>,
): BeamerStation {
  return {
    ...base,
    stationId: '',
    stationName: '',
    ssid: '',
    arch: '',
    ssh: false,
    replayCount: -1,
    replayCap: -1,
    health: 'unknown',
    warnings: [],
    secsSincePortChange: null,
    secsSinceCharacterChange: null,
    reported: false,
    game: null,
  };
}

export function isStatusBody(body: any) {
  return (
    Boolean(body) &&
    typeof body === 'object' &&
    'schema' in body &&
    'station_id' in body
  );
}

async function readStatus(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STATUS_BYTES) {
    throw new Error('That station sent back far more than a status report.');
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type StatusResult =
  | { kind: 'status'; body: any }
  | { kind: 'unreported' };

async function requestStatus(
  origin: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
): Promise<StatusResult> {
  let response;
  try {
    response = await fetch(`${origin}/status`, {
      method,
      ...(method === 'POST' ? { body: '' } : {}),
      signal: AbortSignal.timeout(timeoutMs),
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
  if (response.status === 409) {
    throw new Error(
      'That station is busy with another action - try again in a moment.',
    );
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

export function getBeamerStatus(origin: string) {
  return requestStatus(origin, 'GET', STATUS_TIMEOUT_MS);
}

export function postBeamerStatus(origin: string) {
  return requestStatus(origin, 'POST', STATUS_POST_TIMEOUT_MS);
}

const RESET_TIMEOUT_MS = 90000;

export async function resetBeamer(origin: string) {
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
        `${origin} did not answer the reset. Check the station before assuming its replays survived.`,
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
        ? `That station refused: ${reported}. Nothing was erased - try again in a moment.`
        : 'That station is busy sending a replay, or with another action. Nothing was erased - try again in a moment.',
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

export function addressFor(service: { addresses: string[]; port: number }) {
  const isIpv4 = (candidate: string) => candidate.includes('.');
  const isRoutable = (candidate: string) =>
    !candidate.startsWith('127.') && !candidate.startsWith('169.254.');

  const address =
    service.addresses.find(
      (candidate) => isIpv4(candidate) && isRoutable(candidate),
    ) ??
    service.addresses.find(isIpv4) ??
    service.addresses[0] ??
    '';
  if (!address) {
    return '';
  }
  const bracketed = address.includes(':') ? `[${address}]` : address;
  return service.port === 80 ? bracketed : `${bracketed}:${service.port}`;
}

export type BeamerBrowseHandle = {
  stop: () => void;
};

export function browseForBeamers(callbacks: {
  onFound: (base: Pick<BeamerStation, 'address' | 'host'>) => void;
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
