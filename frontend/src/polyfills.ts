// crypto.randomUUID is only exposed in secure contexts (HTTPS / localhost).
// Operator Chat is frequently served over plain HTTP on a LAN IP, where it is
// undefined. OpenUI's renderer (@openuidev/*) calls crypto.randomUUID()
// internally, so we polyfill it here — imported first in main.tsx, before any
// OpenUI code runs. crypto.getRandomValues IS available in insecure contexts;
// we fall back to Math.random only if even that is missing.

function uuidFromRandomBytes(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set version (4) and variant (RFC 4122) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}

const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
if (globalCrypto && typeof globalCrypto.randomUUID !== 'function') {
  (globalCrypto as { randomUUID: () => string }).randomUUID = uuidFromRandomBytes;
} else if (!globalCrypto) {
  (globalThis as { crypto?: Partial<Crypto> }).crypto = {
    randomUUID: uuidFromRandomBytes,
  } as Crypto;
}
