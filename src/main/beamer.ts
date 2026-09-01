import { mkdir, readdir, rm, stat, unlink } from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import { parse as parseIpaddr } from 'ipaddr.js';
import { SlpDownloadStatus } from '../common/types';
import { DownloadError, downloadFile } from './util';

const INDEX_ATTEMPTS = 3;
const INDEX_RETRY_MS = 1000;
const STATUS_THROTTLE_MS = 100;

export type BeamerFile = { name: string; size: number; url: string };

export function toBeamerOrigin(addressOrHost: string) {
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

export async function getBeamerIndex(origin: string) {
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
      size: Number.isInteger(file.size) ? file.size : -1,
      url,
    });
  });
  return {
    stationId: typeof index.station_id === 'string' ? index.station_id : '',
    files,
  };
}

export function beamerName(origin: string, stationId: string) {
  return stationId && stationId !== 'unknown'
    ? stationId
    : origin.replace(/^http:\/\//, '');
}

export function beamerDirFor(
  cacheRoot: string,
  origin: string,
  stationId: string,
) {
  const name = beamerName(origin, stationId).replace(/:/g, '_');
  return path.join(cacheRoot, sanitize(name) || 'beamer');
}

async function hasCompleteFile(dest: string, file: BeamerFile) {
  try {
    const stats = await stat(path.join(dest, file.name));
    return stats.isFile() && (file.size < 0 || stats.size === file.size);
  } catch {
    return false;
  }
}

export async function firstMissingFile(dest: string, files: BeamerFile[]) {
  const present = await Promise.all(
    files.map((file) => hasCompleteFile(dest, file)),
  );
  const i = present.findIndex((have) => !have);
  return i >= 0 ? files[i] : null;
}

async function partSize(dest: string, name: string) {
  try {
    return (await stat(path.join(dest, `${name}.part`))).size;
  } catch {
    return 0;
  }
}

export async function pullFromBeamer(
  dest: string,
  files: BeamerFile[],
  onStatus: (status: SlpDownloadStatus) => void,
  signal?: AbortSignal,
) {
  await mkdir(dest, { recursive: true });

  const present = await Promise.all(
    files.map((file) => hasCompleteFile(dest, file)),
  );
  const missing = files.filter((file, i) => !present[i]);
  if (missing.length === 0) {
    onStatus({ status: 'success' });
    return;
  }

  const slpUrls = missing.map((file) => file.url);
  const failures = new Map<string, string>();

  const totalBytes = missing.reduce((sum, file) => sum + file.size, 0);
  const byBytes = missing.every((file) => file.size >= 0) && totalBytes > 0;
  const bytesWritten = new Map<string, number>();

  let filesDone = 0;
  let completed = 0;
  let highWater = 0;
  let lastSentAt = 0;

  const send = (file: BeamerFile, attempt: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastSentAt < STATUS_THROTTLE_MS) {
      return;
    }
    lastSentAt = now;
    let done = 0;
    bytesWritten.forEach((bytes) => {
      done += bytes;
    });
    const progress = byBytes
      ? (done / totalBytes) * 100
      : (filesDone / missing.length) * 100;
    highWater = Math.max(highWater, progress);
    onStatus({
      status: 'downloading',
      slpUrls,
      progress: highWater,
      currentFile: file.name,
      filesDone,
      totalFiles: missing.length,
      attempt,
    });
  };

  let unreachable = '';

  const pull = async (file: BeamerFile) => {
    let attempt = 1;
    const started = await partSize(dest, file.name);
    bytesWritten.set(file.name, started);
    send(file, attempt, true);
    try {
      await downloadFile(file.url, path.join(dest, file.name), {
        expectedSize: file.size,
        signal,
        onBytes: (written) => {
          bytesWritten.set(file.name, written);
          send(file, attempt);
        },
        onAttempt: (n) => {
          attempt = n;
        },
      });
      failures.delete(file.name);
      bytesWritten.set(file.name, Math.max(file.size, 0));
      completed += 1;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failures.set(file.name, reason);
      if (e instanceof DownloadError && e.unreachable) {
        unreachable = reason;
      }
    }
    filesDone += 1;
    send(file, attempt, true);
  };

  const cancelled = () => {
    if (!signal?.aborted) {
      return false;
    }
    onStatus({
      status: 'cancelled',
      filesDone: completed,
      totalFiles: missing.length,
    });
    return true;
  };

  for (let i = 0; i < missing.length; i += 1) {
    if (cancelled()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await pull(missing[i]);
    if (unreachable) {
      const reason = unreachable;
      missing.slice(i + 1).forEach((file) => {
        failures.set(file.name, reason);
      });
      break;
    }
  }

  const stragglers = unreachable
    ? []
    : missing.filter((file) => failures.has(file.name));
  if (stragglers.length > 0) {
    for (let i = 0; i < stragglers.length; i += 1) {
      if (cancelled()) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await pull(stragglers[i]);
      if (unreachable) {
        break;
      }
    }
  }

  if (cancelled()) {
    return;
  }
  onStatus(
    failures.size > 0
      ? {
          status: 'error',
          failedFiles: Array.from(
            failures,
            ([name, reason]) => `${name} — ${reason}`,
          ),
        }
      : { status: 'success' },
  );
}

export async function listCachedReplays(dest: string) {
  try {
    return (await readdir(dest, { withFileTypes: true }))
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.slp'))
      .map((dirent) => dirent.name);
  } catch {
    return [];
  }
}

export async function pruneStaleReplays(
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
        // Already gone, or in use. The next poll tries again.
      }
    }),
  );
  return stale;
}

export async function getReplayCacheSize(cacheRoot: string) {
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

export async function clearReplayCache(cacheRoot: string) {
  await rm(cacheRoot, { recursive: true, force: true });
}
