import { readdir, rm, stat, unlink } from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import { parse as parseIpaddr } from 'ipaddr.js';

const INDEX_ATTEMPTS = 3;
const INDEX_RETRY_MS = 1000;

export type BeamerFile = { name: string; size?: number; url: string };

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
      size: Number.isInteger(file.size) ? file.size : undefined,
      url,
    });
  });
  return {
    beamerId: typeof index.station_id === 'string' ? index.station_id : '',
    files,
  };
}

export function beamerLabel(origin: string, beamerId: string) {
  return beamerId || origin.replace(/^http:\/\//, '');
}

export function beamerDirFor(
  cacheRoot: string,
  origin: string,
  beamerId: string,
) {
  const name = beamerLabel(origin, beamerId).replace(/:/g, '_');
  return path.join(cacheRoot, sanitize(name) || 'beamer');
}

export async function hasCompleteFile(dest: string, file: BeamerFile) {
  try {
    const stats = await stat(path.join(dest, file.name));
    return stats.isFile() && (file.size == null || stats.size === file.size);
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
