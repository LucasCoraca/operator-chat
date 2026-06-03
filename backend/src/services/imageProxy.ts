// SSRF-safe image fetcher for the /api/image-proxy endpoint.
//
// Browser-tool observations contain markdown images (![](url)) pointing at
// arbitrary, untrusted scraped hosts. Rendering them directly would make the
// user's browser fetch attacker-chosen URLs (leaking IP/User-Agent, enabling
// tracking pixels). Instead the backend fetches the image server-side with
// these guards and relays only validated image bytes:
//   - http/https only
//   - hostname must resolve exclusively to public IPs (blocks loopback,
//     private ranges, link-local, cloud metadata 169.254.169.254, ULA, etc.)
//   - redirects followed manually, re-validating each hop
//   - response Content-Type must be image/*
//   - hard size cap + request timeout
//
// Residual risk: DNS rebinding (host resolves public at check time, private at
// connect time). Mitigating fully requires pinning the connection to the
// validated IP; for this threat model (scraped-page-chosen URLs) blocking
// non-public resolutions covers the practical attack.

import dns from 'dns';
import net from 'net';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

export interface SafeImageResult {
  ok: boolean;
  status: number; // HTTP status to relay to the client
  error?: string;
  contentType?: string;
  body?: Buffer;
}

/** True if an IP is not publicly routable (loopback, private, link-local, ULA, multicast, ...). */
function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true; // loopback / unspecified
    if (v.startsWith('::ffff:')) return isBlockedIp(v.slice(7)); // IPv4-mapped
    if (v.startsWith('fe80')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA fc00::/7
    if (v.startsWith('ff')) return true; // multicast
    return false;
  }
  return true; // not a valid IP literal → block
}

/** Returns an error string if the hostname is unsafe to fetch, else null. */
async function assertPublicHost(hostname: string): Promise<string | null> {
  // URL.hostname keeps brackets around IPv6 literals (e.g. "[::1]"); strip them
  // so net.isIP recognizes the address instead of falling through to DNS.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host)) {
    return isBlockedIp(host) ? 'Blocked address' : null;
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    return 'DNS resolution failed';
  }
  if (!addrs.length) return 'DNS resolution failed';
  for (const a of addrs) {
    if (isBlockedIp(a.address)) return 'Blocked address';
  }
  return null;
}

export async function fetchSafeImage(rawUrl: string): Promise<SafeImageResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, error: 'Invalid URL' };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return { ok: false, status: 400, error: 'Only http(s) URLs are allowed' };
    }
    const blocked = await assertPublicHost(current.hostname);
    if (blocked) return { ok: false, status: 400, error: blocked };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      });
    } catch {
      return { ok: false, status: 502, error: 'Fetch failed' };
    } finally {
      clearTimeout(timer);
    }

    // Follow redirects ourselves so each hop's host is re-validated.
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return { ok: false, status: 502, error: 'Bad redirect' };
      try {
        current = new URL(loc, current);
      } catch {
        return { ok: false, status: 502, error: 'Bad redirect' };
      }
      continue;
    }

    if (!resp.ok) return { ok: false, status: 502, error: `Upstream ${resp.status}` };

    const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      return { ok: false, status: 415, error: 'Not an image' };
    }

    const lenHeader = resp.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > MAX_BYTES) {
      return { ok: false, status: 413, error: 'Image too large' };
    }

    const reader = resp.body?.getReader();
    if (!reader) return { ok: false, status: 502, error: 'Empty body' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Enforce the cap while reading (defends against missing/forged content-length).
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return { ok: false, status: 413, error: 'Image too large' };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: 200, contentType, body: Buffer.concat(chunks) };
  }

  return { ok: false, status: 508, error: 'Too many redirects' };
}
