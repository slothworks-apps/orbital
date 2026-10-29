import { describe, expect, it } from 'vitest';
import { firstReleaseNotes, recentReleaseSections, releaseNotes, releaseNotesSince } from '../src/changelog.js';

// Samples as they stand in desktop/CHANGELOG.md and mobile/CHANGELOG.md.
const DESKTOP = `# Changelog — Orbital for Mac

All notable changes to the desktop app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow \`version\` in \`desktop/package.json\`.

## [Unreleased]
### Added
- Not out yet.

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
    expect(releaseNotes('## [Unreleased]\n\n## [1.0.0]\n### Added\n- x\n', 'Unreleased')).toBeNull();
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
    expect(firstReleaseNotes([notes])).toEqual([
      "Orbital's built-in session tips are shorter, and sessions are told they run in Orbital rather than a terminal.",
      'A session that only finishes its turn is no longer announced as needing your input.',
      'The Needs input setting now says that it also covers a finished turn.',
    ]);
    expect(firstReleaseNotes([releaseNotes(DESKTOP, '0.34.1')!])).toHaveLength(1);
  });

  it('takes the newest version first and fills up from the older ones', () => {
    const lines = firstReleaseNotes(releaseNotesSince(DESKTOP, '0.34.2', '0.34.0'));
    expect(lines).toEqual([
      "Orbital's built-in session tips are shorter, and sessions are told they run in Orbital rather than a terminal.",
      'A session that only finishes its turn is no longer announced as needing your input.',
      'The Needs input setting now says that it also covers a finished turn.',
    ]);
    expect(firstReleaseNotes(releaseNotesSince(DESKTOP, '0.34.2', '0.34.0'), 4)[3]).toBe(
      'After you choose Restart when sessions finish, the update message leaves the map.',
    );
  });
});

const versions = (notes: { version: string }[]) => notes.map((n) => n.version);

describe('releaseNotesSince', () => {
  it('tells every version after the one seen, up to the running one, newest first', () => {
    expect(versions(releaseNotesSince(DESKTOP, '0.35.0', '0.34.1'))).toEqual(['0.35.0', '0.34.2']);
    expect(versions(releaseNotesSince(DESKTOP, '0.35.0', '0.34.0'))).toEqual(['0.35.0', '0.34.2', '0.34.1']);
    // Not past the running version, even though the file lists a newer one.
    expect(versions(releaseNotesSince(DESKTOP, '0.34.2', '0.34.0'))).toEqual(['0.34.2', '0.34.1']);
    expect(releaseNotesSince(DESKTOP, '0.35.0', '0.34.1')[0]).toEqual(releaseNotes(DESKTOP, '0.35.0'));
  });

  it('only the running version when nothing earlier is known', () => {
    for (const seen of [undefined, '', 'dev', 'before-whats-new', 'Unreleased']) {
      expect(versions(releaseNotesSince(DESKTOP, '0.35.0', seen))).toEqual(['0.35.0']);
    }
  });

  it('only the running version after a downgrade or on the same version', () => {
    expect(versions(releaseNotesSince(DESKTOP, '0.34.1', '0.35.0'))).toEqual(['0.34.1']);
    expect(versions(releaseNotesSince(DESKTOP, '0.34.2', '0.34.2'))).toEqual(['0.34.2']);
  });

  it('compares a seen version the file does not list by number', () => {
    expect(versions(releaseNotesSince(DESKTOP, '0.35.0', '0.34.1-beta.1'))).toEqual(['0.35.0', '0.34.2']);
    expect(versions(releaseNotesSince(DESKTOP, '0.35.0', '0.34.1.5'))).toEqual(['0.35.0', '0.34.2']);
    // Older than everything listed: all of it.
    expect(versions(releaseNotesSince(DESKTOP, '0.35.0', '0.1.0'))).toEqual(['0.35.0', '0.34.2', '0.34.1']);
    // Numbers, not text.
    const md = '## [0.10.0]\n### Added\n- ten\n## [0.9.1]\n### Fixed\n- nine one\n## [0.9.0]\n### Added\n- nine\n';
    expect(versions(releaseNotesSince(md, '0.10.0', '0.9.0'))).toEqual(['0.10.0', '0.9.1']);
  });

  it('never tells Unreleased', () => {
    const lines = releaseNotesSince(DESKTOP, '0.35.0', '0.1.0').flatMap((n) => n.sections.flatMap((s) => s.items));
    expect(lines).not.toContain('Not out yet.');
  });

  it('is empty when the running version has no notes, and skips an older one without lines', () => {
    expect(releaseNotesSince(DESKTOP, '0.36.0', '0.34.1')).toEqual([]);
    const md = '## [1.2.0]\n### Added\n- a\n## [1.1.0]\n## [1.0.0]\n### Fixed\n- b\n';
    expect(versions(releaseNotesSince(md, '1.2.0', '0.9.0'))).toEqual(['1.2.0', '1.0.0']);
  });

  it('keeps the newest ones when more were skipped than it tells', () => {
    const md = Array.from({ length: 14 }, (_, i) => `## [1.${13 - i}.0]\n### Added\n- line ${13 - i}\n`).join('\n');
    expect(versions(releaseNotesSince(md, '1.13.0', '1.0.0', 3))).toEqual(['1.13.0', '1.12.0', '1.11.0']);
    expect(releaseNotesSince(md, '1.13.0', '1.0.0')).toHaveLength(10);
  });
});

describe('recentReleaseSections', () => {
  it('reads the same notes as the whole file, for every seen version', () => {
    for (const [md, v] of [[DESKTOP, '0.35.0'], [DESKTOP, '0.34.2'], [DESKTOP, '0.34.1'], [MOBILE, '0.16.0'], [MOBILE, '0.15.3']] as const) {
      const cut = recentReleaseSections(md, v);
      for (const seen of [undefined, '0.1.0', '0.15.3', '0.34.1', '0.34.2', '0.35.0']) {
        expect(releaseNotesSince(cut, v, seen)).toEqual(releaseNotesSince(md, v, seen));
      }
    }
  });

  it('holds no Unreleased and nothing newer than the running version', () => {
    const cut = recentReleaseSections(DESKTOP, '0.34.2');
    expect(cut.split('\n')[0]).toBe('## [0.34.2] — 2026-10-19');
    expect(cut).not.toMatch(/Unreleased|0\.35\.0|Not out yet/);
    expect(cut).toMatch(/## \[0\.34\.1\]/);
  });

  it('holds at most the versions it can tell, and reads as the whole file past them too', () => {
    const md = Array.from({ length: 14 }, (_, i) => `## [1.${13 - i}.0]\n### Added\n- line ${13 - i}\n`).join('\n');
    const cut = recentReleaseSections(md, '1.13.0', 3);
    expect(cut.match(/^## /gm)).toHaveLength(3);
    expect(releaseNotesSince(cut, '1.13.0', '1.0.0', 3)).toEqual(releaseNotesSince(md, '1.13.0', '1.0.0', 3));
  });

  it('is empty for a version the file does not list', () => {
    expect(recentReleaseSections(DESKTOP, '9.9.9')).toBe('');
    expect(releaseNotesSince(recentReleaseSections(DESKTOP, '9.9.9'), '9.9.9', '0.34.1')).toEqual([]);
  });
});
