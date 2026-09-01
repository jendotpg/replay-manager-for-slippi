import os from 'os';
import { URL } from 'url';
import path from 'path';
import { execSync } from 'child_process';
import { LookupOptions } from 'dns';
import { IPv4, IPv6, parse } from 'ipaddr.js';
import { createWriteStream } from 'fs';
import { rename, stat, unlink } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const CONNECT_TIMEOUT_MS = 4000;
const STALL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 5;
const MAX_TOTAL_ATTEMPTS = 20;
const UNREACHABLE_ATTEMPTS = 2;
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EAI_AGAIN',
]);
const BACKOFF_MS = [1000, 2000, 4000, 4000];

export class DownloadError extends Error {
  readonly retryable: boolean;
  readonly discardPartial: boolean;
  readonly unreachable: boolean;

  constructor(
    message: string,
    { retryable = true, discardPartial = false, unreachable = false } = {},
  ) {
    super(message);
    this.name = 'DownloadError';
    this.retryable = retryable;
    this.discardPartial = discardPartial;
    this.unreachable = unreachable;
  }
}

function networkError(error: unknown) {
  const code = (error as any)?.cause?.code ?? (error as any)?.code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
    return new DownloadError(`the Beamer is unreachable (${code})`, {
      unreachable: true,
    });
  }
  if (typeof code === 'string') {
    return new DownloadError(`the connection failed (${code})`);
  }
  return new DownloadError(
    error instanceof Error ? error.message : String(error),
  );
}

export type DownloadOptions = {
  expectedSize?: number;
  onBytes?: (written: number) => void;
  onAttempt?: (attempt: number) => void;
  signal?: AbortSignal;
};

async function sizeOf(file: string) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function discard(file: string) {
  try {
    await unlink(file);
  } catch {
    // best effort - there may be no partial file at all
  }
}

function statusError(status: number, resuming = false) {
  const retryable = status >= 500 || status === 408 || status === 429;
  return new DownloadError(`HTTP ${status}`, {
    retryable,
    discardPartial: status === 404 || (resuming && status === 200), // 200 (server doesn't support range) sticks otherwise
  });
}

function expectedTotal(
  response: Response,
  from: number,
  fromIndex: number | undefined,
) {
  const contentRange = response.headers.get('content-range');
  const total = contentRange?.match(/\/(\d+)\s*$/)?.[1];
  if (total) {
    return Number(total);
  }
  const length = response.headers.get('content-length');
  if (length !== null && length !== '') {
    return from + Number(length);
  }
  return fromIndex !== undefined && fromIndex >= 0 ? fromIndex : -1;
}

async function downloadAttempt(
  url: string,
  part: string,
  options: DownloadOptions,
): Promise<number> {
  const from = await sizeOf(part);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  const watchdog = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(abort, ms);
  };

  try {
    watchdog(CONNECT_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: from > 0 ? { Range: `bytes=${from}-` } : undefined,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DownloadError('cancelled', { retryable: false });
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DownloadError('timed out');
      }
      throw networkError(error);
    }

    if (from > 0 && response.status === 416) {
      throw new DownloadError('the partial file was stale', {
        discardPartial: true,
      });
    }
    const wantStatus = from > 0 ? 206 : 200;
    if (response.status !== wantStatus) {
      throw statusError(response.status, from > 0);
    }
    if (!response.body) {
      throw new DownloadError('no response body');
    }

    const expected = expectedTotal(response, from, options.expectedSize);

    let written = from;
    watchdog(STALL_TIMEOUT_MS);
    const counted = Readable.fromWeb(response.body as any).map(
      (chunk: Buffer) => {
        written += chunk.length;
        watchdog(STALL_TIMEOUT_MS);
        options.onBytes?.(written);
        return chunk;
      },
    );

    try {
      await pipeline(
        counted,
        createWriteStream(part, from > 0 ? { flags: 'a' } : {}),
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DownloadError('cancelled', { retryable: false });
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DownloadError('the connection stalled');
      }
      throw networkError(error);
    }

    if (expected >= 0 && written !== expected) {
      throw new DownloadError(
        `truncated (${written} of ${expected} bytes)`,
        { discardPartial: written > expected },
      );
    }
    return written;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<void> {
  const part = `${dest}.part`;
  let tries = 1;
  let attempts = 0;
  let best = await sizeOf(part);

  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await downloadAttempt(url, part, options);
      // eslint-disable-next-line no-await-in-loop
      await rename(part, dest);
      return;
    } catch (error) {
      const failure =
        error instanceof DownloadError
          ? error
          : new DownloadError(
              error instanceof Error ? error.message : String(error),
            );
      if (failure.discardPartial) {
        // eslint-disable-next-line no-await-in-loop
        await discard(part);
        best = 0;
      }
      if (!failure.retryable) {
        throw failure;
      }

      // eslint-disable-next-line no-await-in-loop
      const written = await sizeOf(part);
      if (written > best) {
        best = written;
        attempts = 0;
      } else {
        attempts += 1;
      }
      const budget = failure.unreachable ? UNREACHABLE_ATTEMPTS : MAX_ATTEMPTS;
      if (attempts >= budget || tries >= MAX_TOTAL_ATTEMPTS) {
        throw failure;
      }

      tries += 1;
      options.onAttempt?.(tries);
      const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, backoff);
      });
      if (options.signal?.aborted) {
        throw new DownloadError('cancelled', { retryable: false });
      }
    }
  }
}

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}

let computerName = '';
export function getComputerName() {
  if (computerName) {
    return computerName;
  }

  switch (process.platform) {
    case 'win32':
      computerName = execSync('hostname').toString().trim() || os.hostname();
      return computerName;
    case 'darwin':
      computerName =
        execSync('scutil --get ComputerName').toString().trim() ||
        os.hostname();
      return computerName;
    case 'linux':
      computerName =
        execSync('hostnamectl --pretty').toString().trim() || os.hostname();
      return computerName;
    default:
      computerName = os.hostname();
      return computerName;
  }
}

export function lookupInner(addresses: string[], options: LookupOptions) {
  // decent-effort, respect family and all, ignore hints and verbatim
  let family: 0 | 4 | 6 = 0;
  if (options.family !== undefined) {
    if (options.family === 'IPv4') {
      family = 4;
    } else if (options.family === 'IPv6') {
      family = 6;
    } else if (
      options.family === 0 ||
      options.family === 4 ||
      options.family === 6
    ) {
      family = options.family;
    } else {
      throw new Error(`invalid family: ${options.family}`);
    }
  }

  const ipaddrs: (IPv4 | IPv6)[] = [];
  addresses.forEach((address) => {
    try {
      const ipaddr = parse(address);
      // to connect to an ipv6 link local address we need to know the network interface
      // and we can't know that currently so filter them out.
      if (ipaddr.kind() === 'ipv4' || ipaddr.range() !== 'linkLocal') {
        ipaddrs.push(ipaddr);
      }
    } catch {
      // just catch
    }
  });
  let retAddrs = ipaddrs.map((ipaddr) => ({
    address: ipaddr.toString(),
    family: ipaddr.kind() === 'ipv4' ? 4 : 6,
  }));
  if (family !== 0) {
    retAddrs = retAddrs.filter((retAddr) => retAddr.family === family);
  }
  return retAddrs;
}
