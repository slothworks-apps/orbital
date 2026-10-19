/**
 * The OS and its version this device's hello names (`osVersion`, canvas
 * 50t): `macOS 14.6` on a Mac, the distribution on Linux (`Ubuntu 24.04`).
 * Read once per process; anything that fails leaves it unknown, which the
 * rows show as the OS alone.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { osName } from '@orbital/shared/remote/device';
import { osVersionText } from '@orbital/shared/remote/groupWords';
import { HELLO_OS_VERSION_MAX_CHARS } from '@orbital/shared/remote/messages';

/** How long `sw_vers` may take before the version is left unknown. */
export const SW_VERS_TIMEOUT_MS = 2_000;

/** Where a Linux distribution says what it is, in the order systemd reads them. */
export const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'];

/** One `KEY=value` line's value: quotes off, the escapes the format allows undone. */
function osReleaseValue(raw: string): string {
  const v = raw.trim();
  const quote = v[0];
  if ((quote === '"' || quote === "'") && v.endsWith(quote) && v.length >= 2) {
    const inner = v.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
  }
  return v;
}

/** A word as it may reach a row: printable, one line, no control characters. */
function printable(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return s !== '' && !/[\u0000-\u001f\u007f]/.test(s);
}

/**
 * `NAME` and `VERSION_ID` of an os-release file (`Ubuntu 24.04`, `Debian
 * 12`); `NAME` alone without a version (a rolling release); null without a
 * name. Debian's `GNU/Linux` is dropped: the row already says what kind of
 * device it is. Cut to `HELLO_OS_VERSION_MAX_CHARS`.
 */
export function parseOsRelease(text: string): string | null {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !fields.has(m[1])) fields.set(m[1], osReleaseValue(m[2]));
  }
  const name = (fields.get('NAME') ?? '').replace(/\s+GNU\/Linux$/, '').trim();
  if (!printable(name)) return null;
  const version = (fields.get('VERSION_ID') ?? '').trim();
  const out = printable(version) ? `${name} ${version}` : name;
  return out.slice(0, HELLO_OS_VERSION_MAX_CHARS);
}

/** `sw_vers -productVersion`'s answer as a row reads it (`macOS 14.6`); null for anything that is not a version. */
export function macOsVersion(productVersion: string): string | null {
  const v = productVersion.trim();
  return /^\d{1,3}(\.\d{1,3}){0,2}$/.test(v) ? osVersionText(osName('darwin'), v) : null;
}

type Readers = {
  swVers: () => Promise<string>;
  osRelease: (file: string) => Promise<string>;
};

const SYSTEM: Readers = {
  swVers: () => promisify(execFile)('/usr/bin/sw_vers', ['-productVersion'], { timeout: SW_VERS_TIMEOUT_MS, maxBuffer: 4096 })
    .then(({ stdout }) => stdout),
  osRelease: (file) => readFile(file, 'utf8'),
};

/** This host's OS version for `platform`; null where it is unknown or unreadable. */
export async function readOsVersion(platform: NodeJS.Platform, readers: Readers = SYSTEM): Promise<string | null> {
  try {
    if (platform === 'darwin') return macOsVersion(await readers.swVers());
    if (platform === 'linux') {
      for (const file of OS_RELEASE_FILES) {
        try {
          return parseOsRelease(await readers.osRelease(file));
        } catch {
          /* the next file, as systemd does */
        }
      }
    }
  } catch {
    /* unknown */
  }
  return null;
}

let once: Promise<string | null> | null = null;

/** `readOsVersion` for this process, read the first time it is asked. */
export function hostOsVersion(): Promise<string | null> {
  once ??= readOsVersion(process.platform);
  return once;
}
