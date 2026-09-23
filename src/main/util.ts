import os from 'os';
import { URL } from 'url';
import path from 'path';
import { readdir, stat } from 'fs/promises';
import { execSync } from 'child_process';
import { LookupOptions } from 'dns';
import { IPv4, IPv6, parse } from 'ipaddr.js';

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

export function pathInside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function measureReplayCache(cacheRoot: string) {
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string) => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      // no cache dir yet - nothing to measure
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
