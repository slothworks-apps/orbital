/**
 * This Mac's identity on the relay: one Ed25519 pair in the data dir, made
 * the first time the feature is enabled and never rotated by the app (spec
 * 2026-09-30-mobile-remote-design § 1). A Node process has no Keychain, so
 * the file's mode is the whole protection — the same as the SQLite file
 * beside it.
 */
import {
  chmodSync, existsSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureDataDir } from '@orbital/shared/dataDir';
import {
  fromBase64Url, generateIdentity, identityFromSecret, SECRET_KEY_BYTES, toBase64Url, type Identity,
} from '@orbital/shared/remote/keys';
import type { DeviceKind } from '@orbital/shared/remote/device';
import { capabilitiesOf, osName } from '@orbital/shared/remote/device';
import type { OwnHello } from '@orbital/shared/remote/channel';
import { HELLO_OS_VERSION_MAX_CHARS } from '@orbital/shared/remote/messages';
import { PAIR_NAME_MAX_CHARS } from '@orbital/shared/remote/relayApi';

export const IDENTITY_FILE = 'remote-identity.json';

/**
 * `regenerated` is true when an existing file could not be read and a new
 * identity replaced it: every phone paired with the old one is now dead,
 * and the caller has to forget them.
 */
export function loadOrCreateIdentity(dataDir: string): { identity: Identity; regenerated: boolean } {
  const path = join(dataDir, IDENTITY_FILE);
  let regenerated = false;
  if (existsSync(path)) {
    const identity = tryReadIdentity(path);
    if (identity) return { identity, regenerated };
    quarantine(path);
    regenerated = true;
  }
  const identity = generateIdentity();
  ensureDataDir(dataDir, process.platform, process.getuid?.());
  writeIdentity(path, identity);
  return { identity, regenerated };
}

/** The identity already in the data dir, without making one; null when there is none that reads. */
export function readIdentity(dataDir: string): Identity | null {
  const path = join(dataDir, IDENTITY_FILE);
  return existsSync(path) ? tryReadIdentity(path) : null;
}

/** Null for anything that is not a complete, valid secret key — an empty
 * read, broken JSON, a missing field or the wrong number of bytes. */
function tryReadIdentity(path: string): Identity | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { secretKey?: string };
    if (typeof raw.secretKey !== 'string') return null;
    const secretKey = fromBase64Url(raw.secretKey);
    if (secretKey.length !== SECRET_KEY_BYTES) return null;
    return identityFromSecret(secretKey);
  } catch {
    return null;
  }
}

/**
 * Moves a file that failed to read aside rather than overwriting it, so the
 * user can inspect what went wrong; nothing is silently destroyed. Every
 * phone paired against the identity this file held now has to pair again,
 * since its key is gone with it.
 */
function quarantine(path: string): void {
  const dest = `${path}.corrupt-${Date.now()}`;
  renameSync(path, dest);
  console.warn(
    `orbital: ${IDENTITY_FILE} could not be read; moved to ${dest} and generated a new identity — every paired phone needs to pair again`,
  );
}

/**
 * Writes through a temp file in the same directory, then `chmod`s and
 * renames it into place: the 0600 mode is set explicitly rather than hoped
 * for at creation (some platforms/umasks do not honor `writeFileSync`'s
 * `mode` option), and the rename is atomic so a reader never sees a
 * half-written file at the real path either.
 */
function writeIdentity(path: string, identity: Identity): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ secretKey: toBase64Url(identity.secretKey) }));
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The stored name, or the machine's network name without Bonjour's suffix. */
export function macDisplayName(stored: string, host: string = hostname()): string {
  const name = stored.trim();
  if (name) return name;
  return host.replace(/\.local$/i, '');
}

/** A server started with `ORBITAL_HEADLESS=1` is a headless member (spec 2026-10-16-device-group-design § 11). */
export function serverDeviceKind(env: NodeJS.ProcessEnv = process.env): DeviceKind {
  return env.ORBITAL_HEADLESS === '1' ? 'headless' : 'desktop';
}

/**
 * This server's hello. `server` and `macName` are what a shipped phone
 * requires of whatever serves it; the rest names this device to one that
 * knows groups. The name is cut to `PAIR_NAME_MAX_CHARS`, the bound every
 * hello's names are read within. `osVersion` rides along when it is known
 * (`hostOsVersion`).
 */
export function serverHello(o: {
  serverVersion: string; name: string; kind: DeviceKind; osVersion?: string | null;
}): OwnHello {
  const name = o.name.slice(0, PAIR_NAME_MAX_CHARS);
  const osVersion = o.osVersion?.slice(0, HELLO_OS_VERSION_MAX_CHARS);
  return {
    app: `orbital-${o.kind}/${o.serverVersion}`, server: o.serverVersion, macName: name, version: o.serverVersion,
    kind: o.kind, os: osName(process.platform), name, capabilities: capabilitiesOf(o.kind),
    ...(osVersion ? { osVersion } : {}),
  };
}
