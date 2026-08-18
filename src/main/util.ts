import os from 'os';
import { URL } from 'url';
import path from 'path';
import { execSync } from 'child_process';
import { LookupOptions } from 'dns';
import { IPv4, IPv6, parse } from 'ipaddr.js';
import { writeFile } from 'fs/promises';

export async function downloadFile(url: string, dest: string): Promise<void> {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout downloading '${url}'`);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Failed to get '${url}' (${response.status})`);
  }

  if (!response.body) {
    throw new Error(`No response body for '${url}'`);
  }

  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
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
