/**
 * Which versions of each other the relay, the Mac and the phone work with
 * (spec 2026-10-07-version-compatibility-design). Each side holds the oldest
 * version of the other it accepts; a version is the one the component ships
 * under (the version table in the root `CLAUDE.md`). A minimum is raised in
 * the change that makes the other side depend on something new, and
 * `scripts/check-versions.mjs` refuses one that names a version the repo
 * has not reached.
 */

/** The oldest relay the Mac and the phone connect through; compared with what the relay announces. */
export const MIN_RELAY_VERSION = '0.2.0';

/**
 * The oldest Orbital on the Mac this phone works with (spec § 5, 9i): the
 * release that lets the phone answer a harness gate and a limit wait, read
 * the files a session named (`file_get`) and page subagent and task output
 * (spec 2026-10-05-mobile-next), without which those screens half-work.
 */
export const MIN_SERVER_VERSION = '0.20.6';

/** The oldest phone app the Mac talks to; compared with `hello.app`. */
export const MIN_PHONE_VERSION = '0.1.0';

/**
 * The version of a relay that announces none. Every relay released before
 * the announcement is this or older, so a silent relay passes while
 * `MIN_RELAY_VERSION` stays at or below it and fails once it is raised past.
 */
export const RELAY_VERSION_BEFORE_ANNOUNCING = '0.2.0';

/** The first phone release that understands `bye app_too_old`; an older one is sent `bye protocol`. */
export const PHONE_KNOWS_APP_TOO_OLD = '0.4.0';

/** The header every HTTP answer of the relay carries its version in. */
export const RELAY_VERSION_HEADER = 'x-orbital-relay-version';

/**
 * Dotted numbers, compared part by part; a missing part is zero and a
 * pre-release suffix (`-beta.1`) is ignored. `dev` — a server run from
 * source, which reports no version — is newer than any release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null =>
    v.trim() === 'dev'
      ? null
      : v.trim().split('-')[0].split('.').map((part) => {
          const n = Number.parseInt(part, 10);
          return Number.isFinite(n) ? n : 0;
        });
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function isSupportedServer(version: string): boolean {
  return compareVersions(version, MIN_SERVER_VERSION) >= 0;
}

/** A relay below `MIN_RELAY_VERSION`: what it announced (or is taken to be) and what is needed. */
export type RelayTooOld = { relayVersion: string; needed: string };

/**
 * Null when the relay is new enough. `announced` is what the relay said —
 * the `challenge`'s `version`, or `RELAY_VERSION_HEADER` — and absent or
 * empty for a relay that says nothing.
 */
export function relayTooOld(announced: string | null | undefined): RelayTooOld | null {
  const relayVersion = announced?.trim() || RELAY_VERSION_BEFORE_ANNOUNCING;
  return compareVersions(relayVersion, MIN_RELAY_VERSION) < 0 ? { relayVersion, needed: MIN_RELAY_VERSION } : null;
}

/**
 * `relayTooOld` for one HTTP answer, given its `RELAY_VERSION_HEADER` (null
 * when absent). A missing header counts as a silent relay only on a success:
 * an error page may come from a proxy in front of the relay, which says
 * nothing about the relay behind it.
 */
export function relayAnswerTooOld(header: string | null, ok: boolean): RelayTooOld | null {
  if (header === null && !ok) return null;
  return relayTooOld(header);
}

/**
 * The version in `hello.app` (`orbital-mobile/<version>`), or null when it
 * names none a comparison could judge. The Mac refuses only a phone it can
 * name as too old: the refusal shows both versions.
 */
export function phoneAppVersion(app: string): string | null {
  const version = app.slice(app.lastIndexOf('/') + 1).trim();
  return /^\d+(\.\d+)*(-.*)?$/.test(version) ? version : null;
}
