/**
 * What `apt-cache policy orbital` says about the package (spec
 * 2026-10-19-headless-server-design § Updating from the group): the version
 * installed and the one an upgrade would install. Run with `LC_ALL=C`, so
 * the labels are English; in any other language nothing is found, and the
 * server knows no candidate rather than a wrong one.
 */

/** A version as apt spells one; anything else is not taken. */
const APT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+~:-]{0,63}$/;

export type AptPolicy = { installed: string | null; candidate: string | null };

/**
 * The `Installed:` and `Candidate:` lines of `pkg`'s block. `(none)` — not
 * installed, or no version to install — reads as null, as does a missing
 * block (apt knows no such package) or a line apt never writes.
 */
export function parseAptPolicy(output: string, pkg = 'orbital'): AptPolicy {
  const out: AptPolicy = { installed: null, candidate: null };
  let inBlock = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      // A package's block starts at column 0 with its name and a colon.
      inBlock = line.trim() === `${pkg}:`;
      continue;
    }
    if (!inBlock) continue;
    const m = /^\s+(Installed|Candidate):\s*(\S+)\s*$/.exec(line);
    if (!m) continue;
    const value = APT_VERSION.test(m[2]) ? m[2] : null;
    if (m[1] === 'Installed') out.installed = value;
    else out.candidate = value;
  }
  return out;
}
