/**
 * Release notes from an app's own changelog (spec
 * 2026-10-19-whats-new-design § Where the words come from): the Mac's
 * `desktop/CHANGELOG.md` and the phone's `mobile/CHANGELOG.md`, both in the
 * Keep a Changelog format, bundled at build time and read here for the
 * version that runs and the versions before it the person skipped.
 */

import { compareVersions } from './remote/version.js';

/**
 * The Mac's server setting where WHAT'S NEW remembers the last version this
 * Mac ran (web `lib/whatsNew` `SeenVersion`, serialized). Missing is a fresh
 * install.
 */
export const WHATS_NEW_SEEN_KEY = 'whats_new_seen';

/**
 * What `WHATS_NEW_SEEN_KEY` holds on an install from before WHAT'S NEW
 * (server migration 0030): it was updated, so the message for the running
 * version shows once. The phone stands for the same with its own existing
 * state (`mobile/WhatsNew`).
 */
export const WHATS_NEW_BEFORE = 'before-whats-new';

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
 * The most versions WHAT'S NEW tells at once: after skipping more, the
 * newest this many. Enough for a week or two away, short of a wall of text.
 */
export const WHATS_NEW_MAX_VERSIONS = 10;

/** A heading's version that reads as one: `Unreleased` and the like do not. */
const RELEASE_VERSION = /^\d+(\.\d+)*$/;

/** Each released version's heading in `markdown`: its version and its line, in file order. */
function versionHeadings(lines: readonly string[]): { version: string; line: number }[] {
  return lines.flatMap((line, i) => {
    const version = VERSION_HEADING.exec(line)?.[1];
    return version && RELEASE_VERSION.test(version) ? [{ version, line: i }] : [];
  });
}

/**
 * The versions WHAT'S NEW tells about, newest first: `version` and those
 * before it down to the oldest the file lists, at most `max`. The build cut
 * (`recentReleaseSections`) and the reading (`releaseNotesSince`) both take
 * their versions from here, so a cut file answers as the whole one does.
 */
function recentVersions(markdown: string, version: string, max: number): string[] {
  const listed = versionHeadings(markdown.split(/\r?\n/)).map((h) => h.version);
  if (!listed.includes(version)) return [];
  return listed
    .filter((v) => compareVersions(v, version) <= 0)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, max);
}

/**
 * The part of `markdown` WHAT'S NEW can need for `version`: its section and
 * those of the versions before it, at most `max` in all, as written and in
 * file order; empty when the file has no section for `version`. Never
 * `Unreleased`, nor a version newer than `version`. A build hands the client
 * only this (web `changelogSection.ts`), and `releaseNotesSince` reads the
 * same notes from it as from the whole file.
 */
export function recentReleaseSections(markdown: string, version: string, max = WHATS_NEW_MAX_VERSIONS): string {
  const lines = markdown.split(/\r?\n/);
  const keep = new Set(recentVersions(markdown, version, max));
  const sections: string[] = [];
  for (const { version: v, line } of versionHeadings(lines)) {
    if (!keep.has(v)) continue;
    const next = lines.findIndex((l, i) => i > line && /^##\s/.test(l));
    sections.push(lines.slice(line, next === -1 ? undefined : next).join('\n'));
  }
  return sections.join('\n');
}

/**
 * The notes WHAT'S NEW shows after an update from `seen` to `version`,
 * newest first: every version newer than `seen` and not newer than
 * `version` that has lines, at most `max` (the newest). Only `version`'s,
 * as before skipping counted, when nothing earlier is known: no `seen` (a
 * first install, an install from before WHAT'S NEW), a `seen` that is not a
 * version number, or one not older than `version` (a downgrade). A `seen`
 * the file does not list is compared by number all the same; one older than
 * every version listed takes them all, up to `max`. Empty when `version`
 * itself has no notes: then there is nothing to tell.
 */
export function releaseNotesSince(
  markdown: string,
  version: string,
  seen?: string,
  max = WHATS_NEW_MAX_VERSIONS,
): ReleaseNotes[] {
  const running = releaseNotes(markdown, version);
  if (!running) return [];
  if (!seen || !/^\d+(\.\d+)*(-.*)?$/.test(seen) || compareVersions(seen, version) >= 0) return [running];
  return recentVersions(markdown, version, max)
    .filter((v) => compareVersions(v, seen) > 0)
    .flatMap((v) => (v === version ? [running] : (releaseNotes(markdown, v) ?? [])));
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

/**
 * The lines the toast shows (1a): the first `count` across the sections, in
 * their order, the newest version's first and an older one's after them.
 */
export function firstReleaseNotes(notes: readonly ReleaseNotes[], count = 3): string[] {
  return notes.flatMap((n) => n.sections.flatMap((s) => s.items)).slice(0, count);
}
