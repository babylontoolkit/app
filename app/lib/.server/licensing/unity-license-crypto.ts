/**
 * .NET-compatible crypto core for the Unity Project Licenser (SPEC §4.18, §5).
 *
 * This module reproduces, byte-for-byte, the three cryptographic primitives the Unity Exporter
 * plugin's `licenser.cs` validator (and the legacy `licenser.asmx` generator) rely on, so a
 * `license.json` generated here validates in the unchanged Unity Editor:
 *
 *   1. `dotnetPasswordDeriveBytes` — a faithful port of .NET's `PasswordDeriveBytes(password, null)`
 *      (PBKDF1-SHA1 with Microsoft's non-standard block extension, null salt, 100 iterations).
 *      Node has no built-in equivalent; this is validated SOLELY by the live license vector.
 *   2. `encryptLicenseSecret` / `decryptLicenseSecret` — AES-256-CBC (`SecurityTools.EncryptString`),
 *      key = derive("12bucklemyshoe", 32 bytes), IV = UTF-8 bytes of "xdgrq4yhjmd1ajel", PKCS7.
 *      The fixed key + IV make encryption deterministic, so re-encrypting a decrypted payload
 *      reproduces the exact base64 — the property the crypto spec pins.
 *   3. `computeProjectLicenseKeyHash` — the `key` field: per-part space→underscore, the
 *      "-babylontoolkit.com-05.00.00" suffix, lowercased, UTF-16LE bytes, MD5, first 28 uppercase
 *      hex chars dash-grouped by 4.
 *
 * **Server-only (SPEC §5).** The key phrase, IV, and private-key constants live here and must never
 * enter a client bundle. This file is under `.server/` by design.
 */
import crypto from 'node:crypto';

/** AES key phrase — `SecurityTools.GetKeyPhrase()` in the reference C#. */
const KEY_PHRASE = '12bucklemyshoe';

/** AES IV source — `SecurityTools.GetInitVector()`. UTF-8 bytes give the 16-byte CBC IV. */
const INIT_VECTOR = 'xdgrq4yhjmd1ajel';

/** 256-bit AES → 32-byte derived key (`GetKeySize() / 8`). */
const KEY_SIZE_BYTES = 32;

/** `PasswordDeriveBytes` default iteration count. */
const PBKDF_ITERATIONS = 100;

/** License-key hash private constants (`ComputeProjectLicenseKeyHash`). */
const PRIVATE_KEY_1 = 'babylontoolkit.com';
const PRIVATE_KEY_2 = '05.00.00';

function sha1(buf: Buffer): Buffer {
  return crypto.createHash('sha1').update(buf).digest();
}

/**
 * Port of .NET Framework `PasswordDeriveBytes(password, salt=null).GetBytes(count)`.
 *
 * ComputeBaseValue: `base = SHA1(password || salt)`, then hashed again for `i = 1 .. iterations-2`
 * (matching the framework's `for (i = 1; i < iterations - 1; i++)` loop) — 99 SHA-1 rounds total for
 * the default 100 iterations. GetBytes then emits blocks: block 0 = `SHA1(base)`, block N>0 =
 * `SHA1(ASCII(decimal N) || base)`, concatenated and truncated to `count`.
 *
 * Salt is UTF-8 bytes when provided; `null`/`undefined` means no salt (the Unity licenser's case).
 */
export function dotnetPasswordDeriveBytes(
  password: string,
  count: number,
  salt: Buffer | null = null,
  iterations: number = PBKDF_ITERATIONS,
): Buffer {
  const pw = Buffer.from(password, 'utf8');
  let base = sha1(salt ? Buffer.concat([pw, salt]) : pw);

  for (let i = 1; i < iterations - 1; i++) {
    base = sha1(base);
  }

  const blocks: Buffer[] = [];
  let produced = 0;
  let counter = 0;

  while (produced < count) {
    const block = counter === 0 ? sha1(base) : sha1(Buffer.concat([Buffer.from(String(counter), 'ascii'), base]));
    blocks.push(block);
    produced += block.length;
    counter++;
  }

  return Buffer.concat(blocks).subarray(0, count);
}

function deriveKeyAndIv(): { key: Buffer; iv: Buffer } {
  return {
    key: dotnetPasswordDeriveBytes(KEY_PHRASE, KEY_SIZE_BYTES),
    iv: Buffer.from(INIT_VECTOR, 'utf8'),
  };
}

/** AES-256-CBC encrypt (PKCS7) → base64, matching `SecurityTools.EncryptString`. */
export function encryptLicenseSecret(payload: string): string {
  const { key, iv } = deriveKeyAndIv();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  return Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()]).toString('base64');
}

/** AES-256-CBC decrypt (PKCS7) of a base64 secret, matching `SecurityTools.DecryptString`. */
export function decryptLicenseSecret(base64: string): string {
  const { key, iv } = deriveKeyAndIv();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  return Buffer.concat([decipher.update(Buffer.from(base64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * The `key` field — `Utilities.ComputeProjectLicenseKeyHash(seed)`.
 *
 * `seed` is `"<plan>-<product>"` (or `"<plan>-<companyName>"` for EnterprisePartner). Each part has
 * spaces replaced with underscores; the private-key constants contain no spaces (the replace is a
 * no-op on them but kept for fidelity). The joined identifier is lowercased, encoded as UTF-16LE
 * (.NET `Encoding.Unicode`), MD5-hashed, uppercase-hex, first 28 chars, dash-grouped every 4.
 */
export function computeProjectLicenseKeyHash(seed: string): string {
  const productIdentifier = (
    seed.replace(/ /g, '_') +
    '-' +
    PRIVATE_KEY_1.replace(/ /g, '_') +
    '-' +
    PRIVATE_KEY_2.replace(/ /g, '_')
  ).toLowerCase();

  const md5 = crypto.createHash('md5').update(Buffer.from(productIdentifier, 'utf16le')).digest();
  let hex = '';

  for (const byte of md5) {
    hex += byte.toString(16).padStart(2, '0').toUpperCase();
  }

  const truncated = hex.substring(0, 28);
  const groups: string[] = [];

  for (let i = 0; i < 28; i += 4) {
    groups.push(truncated.substring(i, i + 4));
  }

  return groups.join('-');
}
