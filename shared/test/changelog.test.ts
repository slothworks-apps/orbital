import { describe, expect, it } from 'vitest';
import { firstReleaseNotes, releaseNotes, releaseSection } from '../src/changelog.js';

// Samples as they stand in desktop/CHANGELOG.md and mobile/CHANGELOG.md.
const DESKTOP = `# Changelog — Orbital for Mac

All notable changes to the desktop app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow \`version\` in \`desktop/package.json\`.

## [Unreleased]

## [0.35.0] — 2026-10-19
### Added
- Orbital runs on an Ubuntu server too: install the \`orbital\` package, join your group with \`orbital join\`, and its sessions keep running while your Mac sleeps.
- Settings → Devices shows each device's version and, when a newer one is out, an Update you can press for that device from here; this Mac's own update stays in Settings → Updates.
- Another device in your group can update this Mac: it downloads and restarts the same way Restart in Settings → Updates does.

## [0.34.2] — 2026-10-19
### Changed
- Orbital's built-in session tips are shorter, and sessions are told they run in Orbital rather than a terminal.
### Fixed
- A session that only finishes its turn is no longer announced as needing your input.
- The Needs input setting now says that it also covers a finished turn.

## [0.34.1] — 2026-10-19
### Changed
- After you choose Restart when sessions finish, the update message leaves the map.
`;

const MOBILE = `# Changelog — Orbital for the phone

## [Unreleased]

## [0.16.0] — 2026-10-19
### Added
- Devices shows each device's version, and a device with a newer version gets Update in its sheet: update your server or your Mac from the phone.
- The phone's own code says how to add a server: \`orbital join\` on the server.

## [0.15.3] — 2026-10-19
### Fixed
- The banner inside the app no longer says a session needs your input when it has only finished its turn.
`;

describe('releaseNotes', () => {
  it('reads the desktop version with its date, lines as written but without backticks', () => {
    expect(releaseNotes(DESKTOP, '0.35.0')).toEqual({
      version: '0.35.0',
      date: '2026-10-19',
      sections: [
        {
          title: 'NEW',
          items: [
            'Orbital runs on an Ubuntu server too: install the orbital package, join your group with orbital join, and its sessions keep running while your Mac sleeps.',
            "Settings → Devices shows each device's version and, when a newer one is out, an Update you can press for that device from here; this Mac's own update stays in Settings → Updates.",
            'Another device in your group can update this Mac: it downloads and restarts the same way Restart in Settings → Updates does.',
          ],
        },
      ],
    });
  });

  it('stops at the next version', () => {
    const notes = releaseNotes(DESKTOP, '0.34.2');
    expect(notes?.sections.map((s) => [s.title, s.items.length])).toEqual([['CHANGED', 1], ['FIXED', 2]]);
    expect(releaseNotes(DESKTOP, '0.34.1')?.sections).toEqual([
      { title: 'CHANGED', items: ['After you choose Restart when sessions finish, the update message leaves the map.'] },
    ]);
  });

  it('reads the phone changelog', () => {
    const notes = releaseNotes(MOBILE, '0.16.0');
    expect(notes?.sections[0].items[1]).toBe("The phone's own code says how to add a server: orbital join on the server.");
    expect(releaseNotes(MOBILE, '0.15.3')?.sections[0].title).toBe('FIXED');
  });

  it('is null for a version it does not list, or one with no lines', () => {
    expect(releaseNotes(DESKTOP, '0.36.0')).toBeNull();
    expect(releaseNotes(DESKTOP, 'Unreleased')).toBeNull();
    // A prefix is not the version.
    expect(releaseNotes(DESKTOP, '0.35')).toBeNull();
    expect(releaseNotes('', '0.35.0')).toBeNull();
  });

  it('maps Removed and unknown headings to CHANGED, merged, in the order NEW, CHANGED, FIXED', () => {
    const md = `## [1.2.0] — 2026-01-02
### Fixed
- f
### Removed
- r
### Security
- s
### Changed
- c
### Added
- a
`;
    expect(releaseNotes(md, '1.2.0')?.sections).toEqual([
      { title: 'NEW', items: ['a'] },
      { title: 'CHANGED', items: ['r', 's', 'c'] },
      { title: 'FIXED', items: ['f'] },
    ]);
  });

  it('keeps a sub-bullet as a line of its own and joins a wrapped line to its item', () => {
    const md = `## [2.0.0]
### Added
- A parent line
  - its detail
- A line that
  wraps onto the next
`;
    const notes = releaseNotes(md, '2.0.0');
    expect(notes).toEqual({
      version: '2.0.0',
      sections: [{ title: 'NEW', items: ['A parent line', 'its detail', 'A line that wraps onto the next'] }],
    });
  });

  it('ignores lines before the first section heading', () => {
    expect(releaseNotes('## [1.0.0]\n- stray\n### Fixed\n- kept\n', '1.0.0')?.sections).toEqual([
      { title: 'FIXED', items: ['kept'] },
    ]);
  });

  it('takes a heading with a plain hyphen and no brackets', () => {
    expect(releaseNotes('## 1.0.0 - 2026-01-01\n### Added\n- x\n', '1.0.0')?.date).toBe('2026-01-01');
  });
});

describe('firstReleaseNotes', () => {
  it('takes the first three lines across the sections', () => {
    const notes = releaseNotes(DESKTOP, '0.34.2')!;
    expect(firstReleaseNotes(notes)).toEqual([
      "Orbital's built-in session tips are shorter, and sessions are told they run in Orbital rather than a terminal.",
      'A session that only finishes its turn is no longer announced as needing your input.',
      'The Needs input setting now says that it also covers a finished turn.',
    ]);
    expect(firstReleaseNotes(releaseNotes(DESKTOP, '0.34.1')!)).toHaveLength(1);
  });
});

describe('releaseSection', () => {
  it('cuts out one version as written, from which the same notes read', () => {
    for (const [md, v] of [[DESKTOP, '0.35.0'], [DESKTOP, '0.34.2'], [DESKTOP, '0.34.1'], [MOBILE, '0.16.0'], [MOBILE, '0.15.3']] as const) {
      const section = releaseSection(md, v);
      expect(section.split('\n')[0]).toMatch(new RegExp(`^## \\[${v.replace(/\./g, '\\.')}\\]`));
      expect(section).not.toMatch(/\n## /);
      expect(releaseNotes(section, v)).toEqual(releaseNotes(md, v));
    }
  });

  it('is empty for a version the file does not list', () => {
    expect(releaseSection(DESKTOP, '9.9.9')).toBe('');
    expect(releaseNotes(releaseSection(DESKTOP, '9.9.9'), '9.9.9')).toBeNull();
  });
});
