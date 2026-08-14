import os from 'node:os';
import type { NetworkInterfaceInfo } from '../../shared/types/models';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0) >>> 0;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

export function broadcastAddress(address: string, netmask: string): string {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  return intToIpv4((ip | (~mask >>> 0)) >>> 0);
}

export function getLanInterfaces(): NetworkInterfaceInfo[] {
  const result: NetworkInterfaceInfo[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family !== 'IPv4' || item.internal || item.address.startsWith('169.254.')) continue;
      result.push({ name, address: item.address, netmask: item.netmask, broadcast: broadcastAddress(item.address, item.netmask) });
    }
  }
  const virtualPattern = /vEthernet|Hyper-V|WSL|VMware|VirtualBox|Docker|Default Switch/i;
  const rank = (item: NetworkInterfaceInfo): number => virtualPattern.test(item.name) ? 1 : 0;
  return result.sort((a, b) => rank(a) - rank(b) || `${a.name}:${a.address}`.localeCompare(`${b.name}:${b.address}`));
}

export function networkFingerprint(): string {
  return getLanInterfaces().map((item) => `${item.name}:${item.address}/${item.netmask}`).join('|');
}

export function normalizeRemoteAddress(address?: string): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function isLocalLanAddress(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = /^172\.(\d{1,3})\./.exec(host);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  if (/^(fc|fd|fe80):/i.test(host)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  // Host names are allowed for manual LAN DNS; the HTTP transfer still uses the resolved WS peer address.
  return /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host);
}
