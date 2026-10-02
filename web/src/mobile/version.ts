/**
 * The oldest Orbital on the Mac this phone works with (spec § 5, 9i): the
 * release that shipped Settings → Mobile, without which nothing pairs.
 */
export const MIN_SERVER_VERSION = '0.17.1'

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
          const n = Number.parseInt(part, 10)
          return Number.isFinite(n) ? n : 0
        })
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

export function isSupportedServer(version: string): boolean {
  return compareVersions(version, MIN_SERVER_VERSION) >= 0
}
