/**
 * One version's notes from an app's own changelog (spec
 * 2026-10-19-whats-new-design § Where the words come from): the Mac's
 * `desktop/CHANGELOG.md` and the phone's `mobile/CHANGELOG.md`, both in the
 * Keep a Changelog format, bundled at build time and read here for the
 * version that runs.
 */

/** The titles WHAT'S NEW shows (canvas `Feature - Notice toast` 1b), in its order. */
export const RELEASE_NOTE_TITLES = ['NEW', 'CHANGED', 'FIXED'] as const;
export type ReleaseNoteTitle = (typeof RELEASE_NOTE_TITLES)[number];

export interface ReleaseNoteSection {
  title: ReleaseNoteTitle;
  items: string[];
}

export interface ReleaseNotes {
  version: string;
  /** The heading's date as written, `2026-10-19`; absent when the heading has none. */
  date?: string;
  /** Only the titles that have lines, in `RELEASE_NOTE_TITLES` order. */
  sections: ReleaseNoteSection[];
}

/** `Added` is NEW and `Fixed` is FIXED; `Changed`, `Removed` and anything else is CHANGED. */
function titleFor(heading: string): ReleaseNoteTitle {
  const word = heading.trim().toLowerCase();
  if (word === 'added') return 'NEW';
  if (word === 'fixed') return 'FIXED';
  return 'CHANGED';
}

/** `## [0.35.0] — 2026-10-19`, `## 0.35.0 - 2026-10-19`, `## [0.35.0]`: the version and the date. */
const VERSION_HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s+[—–-]\s+(\S+))?\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
/** A bullet at any depth: a sub-bullet is a line of its own. */
const BULLET = /^\s*[-*+]\s+(.*)$/;

/**
 * The words as the person reads them: the canvas draws the lines as plain
 * text, so inline code loses its backticks. Everything else stays as written.
 */
function plain(line: string): string {
  return line.replace(/`([^`]*)`/g, '$1').trim();
}

/**
 * The notes of `version` in `markdown`, or null when the changelog has no
 * section for it or the section has no lines. A line that wraps onto the
 * next (indented, no bullet) joins its item.
 */
export function releaseNotes(markdown: string, version: string): ReleaseNotes | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => VERSION_HEADING.exec(line)?.[1] === version);
  if (start === -1) return null;
  const date = VERSION_HEADING.exec(lines[start])?.[2];

  const items = new Map<ReleaseNoteTitle, string[]>();
  let title: ReleaseNoteTitle | null = null;
  let last: { list: string[]; index: number } | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const section = SECTION_HEADING.exec(line);
    if (section) {
      title = titleFor(section[1]);
      last = null;
      continue;
    }
    if (title === null) continue;
    const bullet = BULLET.exec(line);
    if (bullet) {
      const text = plain(bullet[1]);
      if (!text) continue;
      const list = items.get(title) ?? [];
      list.push(text);
      items.set(title, list);
      last = { list, index: list.length - 1 };
      continue;
    }
    if (!line.trim()) {
      last = null;
      continue;
    }
    if (last && /^\s/.test(line)) last.list[last.index] = `${last.list[last.index]} ${plain(line)}`;
  }

  const sections = RELEASE_NOTE_TITLES.flatMap((t) => {
    const list = items.get(t);
    return list?.length ? [{ title: t, items: list }] : [];
  });
  if (sections.length === 0) return null;
  return date ? { version, date, sections } : { version, sections };
}

/** The lines the toast shows (1a): the first `count` across the sections, in their order. */
export function firstReleaseNotes(notes: ReleaseNotes, count = 3): string[] {
  return notes.sections.flatMap((s) => s.items).slice(0, count);
}
