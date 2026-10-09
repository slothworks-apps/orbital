/**
 * File-path detection for assistant prose and tool inputs (spec:
 * 2026-09-19-file-viewer-design § The pressable path). Shared because the
 * server and the web must agree on which strings are paths: the server lists
 * a reply's media from them and the web draws its thumbnails and links from
 * them (spec 2026-10-09-session-media-design § Path detection moves to
 * `shared/`). The relay never imports this.
 *
 * Prose needs a pattern, not a parser: a run of path characters with at
 * least one `/` and a known text or image extension, optionally followed by `:line`
 * or `:line:col` (line kept, column ignored, both part of the hit area).
 * False positives are cheap — the viewer refuses politely; false negatives
 * are the expensive kind (canvas 8b).
 *
 * An inline code span is pressable too, but only when the path is the whole
 * span (adr `a-code-span-that-is-a-path-is-pressable`).
 */

/**
 * Extensions the viewer can show as text — a whitelist, because "not an
 * image" is unknowable from a name while "is a text format we know" is a
 * list. Known-binary extensions (`.woff2`, `.pdf`, `.zip`, …) are absent so
 * those paths stay plain text everywhere; images are pressable through
 * {@link IMAGE_EXTENSIONS} instead and open in the lightbox, not the viewer,
 * and a PDF through {@link PDF_EXTENSION}.
 */
const TEXT_EXTENSIONS = new Set([
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'scala', 'dart', 'ex',
  'exs', 'erl', 'hs', 'clj', 'edn', 'zig', 'sql', 'prisma', 'graphql',
  'gql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  // docs
  'md', 'markdown', 'txt', 'rst', 'adoc', 'log', 'csv', 'tsv',
  // config + markup
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'gradle', 'tf', 'html', 'htm', 'xml', 'css',
  'scss', 'sass', 'less', 'lock', 'editorconfig', 'gitignore',
]);

/**
 * Extensions a press opens in the lightbox, served by `/api/files/image` —
 * the server's `IMAGE_FILE_CONTENT_TYPES` lists the same set. `.svg` is text
 * on disk but an image to the reader, so it sits here (judgement call).
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

/** The one document format that counts as media; `/api/files/image` serves it too. */
const PDF_EXTENSION = 'pdf';

function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? null : base.slice(dot + 1).toLowerCase();
}

/** True when the path's basename carries an extension from the TEXT whitelist. */
export function hasTextExtension(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && TEXT_EXTENSIONS.has(ext);
}

/** True when the path names an image the lightbox can show. */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
}

/** True when the path names a PDF. */
export function isPdfPath(path: string): boolean {
  return extensionOf(path) === PDF_EXTENSION;
}

/** True when the path names media — an image or a PDF (spec 2026-10-09-session-media-design § What counts as media). */
export function isMediaPath(path: string): boolean {
  return isImagePath(path) || isPdfPath(path);
}

/** True when a press can open the path — as text in the viewer, or as media (an image or a PDF). */
export function isPressablePath(path: string): boolean {
  return hasTextExtension(path) || isMediaPath(path);
}

export interface PathMatch {
  /** Offset of the whole hit area (path + any `:line[:col]` suffix) in the input. */
  index: number;
  /** Length of the whole hit area. */
  length: number;
  /** The matched text verbatim — what the button shows. */
  text: string;
  /** The path alone, suffix stripped — what travels to the server. */
  path: string;
  /** Parsed `:line`, or null when the match carried none. */
  line: number | null;
}

/** One path segment: word chars plus the punctuation real file names use. */
const SEGMENT = String.raw`[\w.@+~-]+`;
/** A run with at least one `/` — an optional leading segment then `/segment`s. */
const PATH_RUN = new RegExp(`(?:${SEGMENT})?(?:/${SEGMENT})+`, 'g');
/** Optional `:line` or `:line:col` immediately after the path. */
const LINE_SUFFIX = /^:(\d+)(?::\d+)?/;

/**
 * An extension a file name could carry: a letter, then up to nine letters
 * or digits. What keeps `1/2.5` or `v1.2/3.0` from reading as a path when
 * every extension counts ({@link findPathMentions}).
 */
const NAMED_EXTENSION = /^[a-z][a-z0-9]{0,9}$/;

/** True when the path's basename carries something that reads as a file extension. */
function hasNamedExtension(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && NAMED_EXTENSION.test(ext);
}

/** Every path-shaped run in `text` whose extension a press can open. */
export function findPathMatches(text: string): PathMatch[] {
  return scanPaths(text, isPressablePath);
}

/**
 * Every path-shaped run in `text` with a file extension, pressable or not —
 * for a reader that does something with a path it cannot open (the phone's
 * long-press copy, spec 2026-10-05-mobile-next § 2). The desktop never asks.
 */
export function findPathMentions(text: string): PathMatch[] {
  return scanPaths(text, hasNamedExtension);
}

/** Every path-shaped run in `text` that names an image or a PDF. */
export function findMediaPaths(text: string): PathMatch[] {
  return scanPaths(text, isMediaPath);
}

/** Every path-shaped run in `text` that `accept` takes, in order. */
export function scanPaths(text: string, accept: (path: string) => boolean): PathMatch[] {
  const matches: PathMatch[] = [];
  PATH_RUN.lastIndex = 0;
  for (let m = PATH_RUN.exec(text); m !== null; m = PATH_RUN.exec(text)) {
    // Sentence punctuation: `.` is a path character, so a match at the end
    // of a sentence swallows the full stop — trim trailing dots before the
    // extension check so `web/src/App.tsx.` still reads as a `.tsx` hit.
    const path = m[0].replace(/\.+$/, '');
    // A candidate preceded by another slash is the tail of a `//` URL run
    // (`https://…`), not a file path.
    if (m.index > 0 && text[m.index - 1] === '/') continue;
    if (!accept(path)) continue;

    const suffix = LINE_SUFFIX.exec(text.slice(m.index + path.length));
    const hit = suffix ? path + suffix[0] : path;
    matches.push({
      index: m.index,
      length: hit.length,
      text: hit,
      path,
      line: suffix ? Number(suffix[1]) : null,
    });
    PATH_RUN.lastIndex = m.index + hit.length;
  }
  return matches;
}

/** What a code span or a reply is matched with. */
export type PathFinder = (text: string) => PathMatch[];

/**
 * The match an inline code span stands for, or null. Only a span that is
 * one path and nothing else qualifies: `` `web/src/App.tsx:42` `` is a
 * reference, while `` `cat web/src/App.tsx` `` is a command that happens to
 * contain one, and stays quoted material.
 */
export function codeSpanPath(text: string, find: PathFinder = findPathMatches): PathMatch | null {
  const trimmed = text.trim();
  const matches = find(trimmed);
  if (matches.length !== 1) return null;
  const [match] = matches;
  return match.index === 0 && match.length === trimmed.length ? match : null;
}

// ---------------------------------------------------------------------------
// The media a reply names
// ---------------------------------------------------------------------------

/** A fence line opening or closing a fenced code block: its character run, and nothing but an info string after. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** An indent that makes a line after a blank one an indented code block. */
const CODE_INDENT = /^(?: {4}|\t)/;
/** A list item's marker, which makes indented lines under it its content rather than code. */
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;
/**
 * A markdown link or image, `[label](target)` or `![alt](src)`. The rehype
 * plugin skips `a` elements whole, and an image's alt is no text node, so a
 * path in either is not the reply naming it.
 */
const LINK = /!?\[[^\]\n]*\]\([^)\n]*\)|<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>/g;

/**
 * The prose of a markdown reply, code blocks left out: one string per run of
 * lines between blocks, so a code span may still cross a line break as it
 * does in a paragraph.
 *
 * Not a markdown parser — the shapes the web's renderer (remark) turns into
 * `pre`, which the rehype plugin skips: fenced blocks, closed by a run of the
 * same character at least as long, and indented blocks after a blank line
 * outside a list.
 */
function proseRuns(text: string): string[] {
  const runs: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) runs.push(run.join('\n'));
    run = [];
  };
  let fence: string | null = null;
  let inIndentedCode = false;
  let inList = false;
  let previousBlank = true;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && close[2].trim() === '') fence = null;
      continue;
    }
    const blank = line.trim() === '';
    if (inIndentedCode && (blank || CODE_INDENT.test(line))) continue;
    inIndentedCode = false;
    const open = FENCE.exec(line);
    // A backtick fence's info string may not carry a backtick: that line is an inline span.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      flush();
      fence = open[1];
      previousBlank = false;
      continue;
    }
    if (!blank && previousBlank && !inList && CODE_INDENT.test(line)) {
      flush();
      inIndentedCode = true;
      continue;
    }
    if (blank) {
      flush();
    } else {
      if (LIST_MARKER.test(line)) inList = true;
      // A line at the margin after a blank one starts a paragraph the list does not reach.
      else if (previousBlank && !/^\s/.test(line)) inList = false;
      run.push(line);
    }
    previousBlank = blank;
  }
  flush();
  return runs;
}

/** `text` with markdown links and autolinks blanked to spaces, so offsets still hold. */
function withoutLinks(text: string): string {
  return text.replace(LINK, (link) => ' '.repeat(link.length));
}

/**
 * The paths a prose run names, in order: in its text, and in each code span
 * that is one path and nothing else — the rule the rehype plugin applies.
 * A run of backticks opens a span that only the same run closes; one left
 * open is literal text.
 */
function pathsInProse(prose: string, find: PathFinder): string[] {
  const out: string[] = [];
  const textPart = (part: string) => {
    for (const m of find(withoutLinks(part))) out.push(m.path);
  };
  let cursor = 0;
  let from = 0;
  const ticks = /`+/g;
  for (let open = ticks.exec(prose); open !== null; open = ticks.exec(prose)) {
    if (open.index < from) continue;
    const run = open[0];
    const closing = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
    closing.lastIndex = open.index + run.length;
    const close = closing.exec(prose);
    if (!close) {
      // Literal backticks: skip past them and keep looking for a span.
      from = open.index + run.length;
      continue;
    }
    textPart(prose.slice(cursor, open.index));
    const span = codeSpanPath(prose.slice(open.index + run.length, close.index).replace(/\n/g, ' '), find);
    if (span) out.push(span.path);
    cursor = close.index + run.length;
    from = cursor;
    ticks.lastIndex = cursor;
  }
  textPart(prose.slice(cursor));
  return out;
}

/**
 * The images and PDFs an assistant reply names, in order of first appearance
 * and once each — what the gallery lists as `agent` items and what the
 * transcript draws as the reply's thumbnails (spec
 * 2026-10-09-session-media-design § What counts as media). Code blocks are
 * quoted material and name nothing; an inline code span counts only when it
 * is one path and nothing else; a link's label and target are the link's.
 */
export function mediaPathsInReply(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const prose of proseRuns(text)) {
    for (const path of pathsInProse(prose, findMediaPaths)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
