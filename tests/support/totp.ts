import { createHmac } from "node:crypto";

/**
 * RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 second step), computed with node:crypto so tests
 * need no dependency. The secret is base32, the form an authenticator app scans or Supabase Auth returns
 * in `mfa.enroll`. Test support only: nothing in the app imports this.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Not a base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  /** Milliseconds since the epoch. Defaults to now. */
  at?: number;
  /** Digits in the code. Authenticator apps and Supabase Auth use 6. */
  digits?: number;
  /** Steps to move from the current one: +1 is the next 30 seconds, -1 the previous. */
  stepOffset?: number;
}

export function totp(secretBase32: string, options: TotpOptions = {}): string {
  const { at = Date.now(), digits = 6, stepOffset = 0 } = options;
  const counter = BigInt(Math.floor(at / 1000 / 30) + stepOffset);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}
