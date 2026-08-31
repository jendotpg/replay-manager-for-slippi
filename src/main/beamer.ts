import { mkdir, readdir, rm, stat, unlink } from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import { parse as parseIpaddr } from 'ipaddr.js';
import { SlpDownloadStatus } from '../common/types';
import { downloadFile } from './util';

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

export async function getBeamerIndex(origin: string) {
  let response;
  try {
    response = await fetch(`${origin}/SLIPPI/`, {
      signal: AbortSignal.timeout(5000),
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

export async function pullFromBeamer(
  dest: string,
  files: BeamerFile[],
  onStatus: (status: SlpDownloadStatus) => void,
) {
  await mkdir(dest, { recursive: true });

  const present = await Promise.all(
    files.map(async (file) => {
      try {
        const stats = await stat(path.join(dest, file.name));
        return stats.isFile() && (file.size < 0 || stats.size === file.size);
      } catch {
        return false;
      }
    }),
  );
  const missing = files.filter((file, i) => !present[i]);
  if (missing.length === 0) {
    return;
  }

  const slpUrls = missing.map((file) => file.url);
  const failedFiles: string[] = [];
  for (let i = 0; i < missing.length; i += 1) {
    const file = missing[i];
    onStatus({
      status: 'downloading',
      slpUrls,
      progress: Math.round((i / missing.length) * 100),
      currentFile: file.name,
    });

    const filePath = path.join(dest, file.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      await downloadFile(file.url, filePath);
    } catch {
      failedFiles.push(file.name);
      try {
        // eslint-disable-next-line no-await-in-loop
        await unlink(filePath);
      } catch {
        // best effort, there may be no partial file at all
      }
    }
  }

  onStatus(
    failedFiles.length > 0
      ? { status: 'error', failedFiles }
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

export async function pruneBeamerDir(
  dest: string,
  cached: string[],
  indexNames: string[],
) {
  const keep = new Set(indexNames);
  const stale = cached.filter((name) => !keep.has(name));
  await Promise.all(
    stale.map(async (name) => {
      try {
        await unlink(path.join(dest, name));
      } catch {
        // Already gone, or in use. The next poll tries again.
      }
    }),
  );
  return stale;
}

export async function getBeamerCacheSize(cacheRoot: string) {
  let stationDirs: string[];
  try {
    stationDirs = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  } catch {
    return { files: 0, bytes: 0 };
  }

  let files = 0;
  let bytes = 0;
  await Promise.all(
    stationDirs.map(async (stationDir) => {
      const stationPath = path.join(cacheRoot, stationDir);
      let names: string[];
      try {
        names = (await readdir(stationPath, { withFileTypes: true }))
          .filter((dirent) => dirent.isFile())
          .map((dirent) => dirent.name);
      } catch {
        return;
      }
      await Promise.all(
        names.map(async (name) => {
          try {
            const stats = await stat(path.join(stationPath, name));
            files += 1;
            bytes += stats.size;
          } catch {
            // gone between the readdir and the stat, close enough
          }
        }),
      );
    }),
  );
  return { files, bytes };
}

export async function clearBeamerCache(cacheRoot: string) {
  await rm(cacheRoot, { recursive: true, force: true });
}
