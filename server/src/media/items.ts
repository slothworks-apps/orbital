/**
 * Every image and PDF of a session, from its parsed transcript (spec
 * 2026-10-09-session-media-design § What counts as media, § Data). Nothing
 * is persisted: the list is derived from the messages the transcript route
 * already caches, plus one `stat` per file a reply named.
 */
import { statSync } from 'node:fs';
import type { MediaItem } from '@orbital/shared/media';
import { resolve } from 'node:path';
import { isImagePath, isPdfPath, isScreenshotTool, mediaPathsInReply, scanPaths, writtenImagePaths } from '@orbital/shared/paths';
import { expandHome } from '../paths.js';
import type { ChatMessage, ImageRefEntry } from '../types.js';
import { readInSandboxes, resolveForSession, type NamedCheck } from '../files/preview.js';

export type { MediaItem };

/**
 * Where a path a reply named is now: on disk (with its `mtime`), nowhere, or
 * somewhere the session may not show — which leaves the item out.
 */
export type MediaLocation = { kind: 'ok'; mtimeMs: number } | { kind: 'not_found' } | { kind: 'outside' };

export type LocateMedia = (path: string, cwd: string | undefined) => MediaLocation;

/**
 * Locates a named path within the bounds the file routes read in: the
 * sandboxes `fileSandboxes` gives for the message's `cwd`, each widened by
 * `named` as `resolveForSession` does. One `stat`, no read.
 */
export function locateOnDisk(sandboxes: (cwd: string | undefined) => string[], named: NamedCheck): LocateMedia {
  return (path, cwd) =>
    readInSandboxes<MediaLocation>(sandboxes(cwd), (dir) => {
      const confined = resolveForSession(dir, path, named);
      if (confined.kind !== 'ok') return confined;
      try {
        const stat = statSync(confined.path);
        return stat.isDirectory() ? { kind: 'not_found' } : { kind: 'ok', mtimeMs: stat.mtimeMs };
      } catch {
        return { kind: 'not_found' };
      }
    });
}

function refItem(
  m: ChatMessage, index: number, image: ImageRefEntry, source: 'you' | 'tool', tool?: string,
): MediaItem {
  return {
    id: `${m.id}:${index}`,
    kind: 'image',
    source,
    messageId: m.id,
    ts: m.timestamp ?? '',
    ref: image.ref,
    ...(image.w && image.h ? { w: image.w, h: image.h } : {}),
    ...(source === 'tool' && m.toolUseId ? { toolRun: m.toolUseId } : {}),
    ...(tool ? { tool } : {}),
  };
}

/** Whether the file changed after the reply named it, by its `mtime` against the reply's timestamp. */
function diskState(location: Extract<MediaLocation, { kind: 'ok' }>, ts: string): 'present' | 'changed' {
  const named = Date.parse(ts);
  return !Number.isNaN(named) && location.mtimeMs > named ? 'changed' : 'present';
}

/** Where a written or named path points, for comparing two spellings of one file. */
function pathKey(path: string, cwd: string | undefined): string {
  return resolve(cwd ?? '/', expandHome(path));
}

/**
 * The session's media before any file is looked at, oldest first, from its
 * transcript messages:
 *
 * - `you`: the images of a user row — attached in Orbital or pasted in the CLI.
 * - `tool`: the images of a tool_result, grouped by the tool_use id they answer.
 * - `agent`: the images and PDFs an assistant reply's text names
 *   (`mediaPathsInReply`).
 * - `written`: the images a tool call's input writes (`writtenImagePaths`),
 *   and those a screenshot tool's result text names — spec
 *   2026-10-13-session-media-more-design § Written images. One the same turn's
 *   replies name is that reply's `agent` item instead; one the call's own
 *   result already carried as an image is that `tool` item; a path written
 *   twice in a turn is one item.
 *
 * An assistant row carrying an image block has no source in the spec and is
 * left out. `agent` and `written` items carry no `disk` yet: `locateMedia`
 * decides it, and whether they stay.
 */
export function mediaCandidates(messages: readonly ChatMessage[]): MediaItem[] {
  const out: MediaItem[] = [];
  // A tool_result names only the call it answers; the call, earlier in the
  // transcript, carries the tool's name.
  const toolNames = new Map<string, string>();
  // For the written items' de-duplication: each one's turn, file and call,
  // the files each turn's replies named, and the calls whose result carried an image.
  const written = new Map<MediaItem, { turn: number; key: string; call?: string }>();
  const named = new Set<string>();
  const imaged = new Set<string>();
  let turn = 0;
  const writtenItem = (m: ChatMessage, i: number, path: string, tool: string | undefined, call: string | undefined) => {
    const item: MediaItem = {
      id: `${m.id}:${i}`,
      kind: 'image',
      source: 'written',
      messageId: m.id,
      ts: m.timestamp ?? '',
      path,
      ...(m.cwd ? { cwd: m.cwd } : {}),
      ...(tool ? { tool } : {}),
    };
    written.set(item, { turn, key: pathKey(path, m.cwd), call });
    out.push(item);
  };
  for (const m of messages) {
    if (m.role === 'tool_use' && m.toolUseId && m.toolName) toolNames.set(m.toolUseId, m.toolName);
    if (m.role === 'user') {
      turn += 1;
      m.images?.forEach((image, i) => out.push(refItem(m, i, image, 'you')));
    } else if (m.role === 'tool_result') {
      const tool = m.toolUseId ? toolNames.get(m.toolUseId) : undefined;
      if (m.images?.length) {
        if (m.toolUseId) imaged.add(m.toolUseId);
        m.images.forEach((image, i) => out.push(refItem(m, i, image, 'tool', tool)));
      } else if (tool && isScreenshotTool(tool) && m.text) {
        // Saved to a file and said so, with no image in the answer.
        scanPaths(m.text, isImagePath).forEach((match, i) => writtenItem(m, i, match.path, tool, m.toolUseId));
      }
    } else if (m.role === 'tool_use' && m.toolName) {
      writtenImagePaths(m.toolName, m.toolInput).forEach((path, i) => writtenItem(m, i, path, m.toolName, m.toolUseId));
    } else if (m.role === 'assistant' && m.text) {
      const ts = m.timestamp ?? '';
      mediaPathsInReply(m.text).forEach((path, i) => {
        named.add(`${turn}\0${pathKey(path, m.cwd)}`);
        out.push({
          id: `${m.id}:${i}`,
          kind: isPdfPath(path) ? 'pdf' : 'image',
          source: 'agent',
          messageId: m.id,
          ts,
          path,
          ...(m.cwd ? { cwd: m.cwd } : {}),
        });
      });
    }
  }
  if (written.size === 0) return out;
  const seen = new Set<string>();
  return out.filter((item) => {
    const w = written.get(item);
    if (!w) return true;
    const at = `${w.turn}\0${w.key}`;
    if (named.has(at) || seen.has(at) || (w.call !== undefined && imaged.has(w.call))) return false;
    seen.add(at);
    return true;
  });
}

/**
 * Candidates with their files looked at: an `agent` item gets its `disk`,
 * and is left out where the session may not show it; a `written` item stays
 * only while its file is there to show.
 */
export function locateMedia(candidates: readonly MediaItem[], locate: LocateMedia): MediaItem[] {
  const out: MediaItem[] = [];
  for (const item of candidates) {
    if (item.source !== 'agent' && item.source !== 'written') {
      out.push(item);
      continue;
    }
    const location = locate(item.path ?? '', item.cwd);
    if (location.kind === 'outside') continue;
    if (item.source === 'written') {
      if (location.kind === 'ok') out.push(item);
      continue;
    }
    out.push({ ...item, disk: location.kind === 'not_found' ? 'missing' : diskState(location, item.ts) });
  }
  return out;
}

/** The media of one transcript's messages, oldest first: `mediaCandidates`, located. */
export function mediaItems(messages: readonly ChatMessage[], locate: LocateMedia): MediaItem[] {
  return locateMedia(mediaCandidates(messages), locate);
}
