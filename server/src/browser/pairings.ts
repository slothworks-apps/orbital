import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The browser bridge's pairings (spec 2026-11-05-browser-bridge-design
 * § Pairing): the one pairing code Settings shows, and the browser tokens
 * extensions were given for it.
 *
 * A token is kept only as its SHA-256, in a file of its own in the data dir,
 * owner-only. Not in the settings table: `GET /api/settings` hands every row
 * to the web, to group members and to the phone. A token opens `/ws/browser`
 * and nothing else, and a hash of 32 random bytes needs no salt or stretching.
 */

export const BROWSER_PAIRINGS_FILE = 'browser-pairings.json';

/** How long a pairing code stays good. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

/** Characters in a pairing code: typed by hand into the popup, shown as 3 + 3. */
export const PAIRING_CODE_LENGTH = 6;

/**
 * What a pairing code is made of: letters and digits without 0/O and 1/I,
 * which read alike when typed off the screen (canvas 64f, The code).
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A code as typed, the way it is compared: case does not matter, nor the
 * space or dash someone types between its two halves.
 */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** Wrong codes a code survives; the next wrong one ends it, so it cannot be walked. */
export const PAIRING_CODE_MAX_FAILURES = 5;

export interface StoredPairing {
  id: string;
  browser: string;
  pairedAt: number;
  tokenHash: string;
  /** When its extension was last connected: set as it connects and as it leaves. */
  lastSeenAt?: number;
}

export type PairFailure = 'no-code' | 'expired' | 'wrong-code';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** What the extension calls its browser, kept short and printable. */
function browserName(raw: string): string {
  const name = [...raw].filter((c) => c >= ' ' && c !== '\u007f').join('').trim().slice(0, 40);
  return name || 'Browser';
}

export class BrowserPairings {
  private readonly file: string;
  private pairings: StoredPairing[];
  private code: { code: string; expiresAt: number; failures: number } | null = null;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = join(dataDir, BROWSER_PAIRINGS_FILE);
    this.pairings = this.load();
  }

  list(): readonly StoredPairing[] {
    return this.pairings;
  }

  /** A new code, replacing any still open: Settings shows one at a time. */
  newCode(): { code: string; expiresAt: number } {
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[randomInt(0, PAIRING_CODE_ALPHABET.length)];
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.code = { code, expiresAt, failures: 0 };
    return { code, expiresAt };
  }

  clearCode(): void {
    this.code = null;
  }

  /** When the open code lapses, or null when none is open: never made, spent, cancelled, worn out or expired. */
  codeExpiresAt(): number | null {
    const open = this.code;
    return open && this.now() < open.expiresAt ? open.expiresAt : null;
  }

  /** Spends the code on a new pairing and answers its token, or says why not. */
  pair(code: string, browser: string): { pairing: StoredPairing; token: string } | { failure: PairFailure } {
    const open = this.code;
    if (!open) return { failure: 'no-code' };
    if (this.now() >= open.expiresAt) {
      this.code = null;
      return { failure: 'expired' };
    }
    if (normalizePairingCode(code) !== open.code) {
      if (++open.failures >= PAIRING_CODE_MAX_FAILURES) this.code = null;
      return { failure: 'wrong-code' };
    }
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const pairing: StoredPairing = { id: randomUUID(), browser: browserName(browser), pairedAt: now, tokenHash: hashToken(token), lastSeenAt: now };
    this.pairings = [...this.pairings, pairing];
    this.save();
    return { pairing, token };
  }

  /** The pairing a token belongs to, or null for one unknown or revoked. */
  byToken(token: string): StoredPairing | null {
    if (!token) return null;
    const hash = hashToken(token);
    return this.pairings.find((p) => p.tokenHash === hash) ?? null;
  }

  /** Its extension is connected now, or just left: kept, so "last seen" survives a restart. */
  seen(id: string): void {
    const at = this.now();
    let changed = false;
    this.pairings = this.pairings.map((p) => {
      if (p.id !== id) return p;
      changed = true;
      return { ...p, lastSeenAt: at };
    });
    if (changed) this.save();
  }

  revoke(id: string): boolean {
    const kept = this.pairings.filter((p) => p.id !== id);
    if (kept.length === this.pairings.length) return false;
    this.pairings = kept;
    this.save();
    return true;
  }

  private load(): StoredPairing[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // Missing on a Mac that never paired; unreadable reads as nothing paired,
      // and the extension is asked to pair again.
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is StoredPairing =>
      typeof p === 'object' && p !== null
      && typeof p.id === 'string' && typeof p.browser === 'string'
      && typeof p.pairedAt === 'number' && typeof p.tokenHash === 'string'
      && (p.lastSeenAt === undefined || typeof p.lastSeenAt === 'number'));
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.pairings, null, 2), { mode: 0o600 });
    // `mode` applies only when the file is created.
    chmodSync(this.file, 0o600);
  }
}
