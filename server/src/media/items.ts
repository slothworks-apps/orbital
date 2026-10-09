/**
 * Every image and PDF of a session, from its parsed transcript (spec
 * 2026-10-09-session-media-design § What counts as media, § Data). Nothing
 * is persisted: the list is derived from the messages the transcript route
 * already caches, plus one `stat` per file a reply named.
 */
import { statSync } from 'node:fs';
import type { MediaItem } from '@orbital/shared/media';
import { isPdfPath, mediaPathsInReply } from '@orbital/shared/paths';
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

/**
 * The session's media, oldest first, from its transcript messages:
 *
 * - `you`: the images of a user row — attached in Orbital or pasted in the CLI.
 * - `tool`: the images of a tool_result, grouped by the tool_use id they answer.
 * - `agent`: the images and PDFs an assistant reply's text names
 *   (`mediaPathsInReply`), each located with `locate`. A path in a tool's
 *   input is never one: a `Read` of an image is already its result's `tool`
 *   item, and a `Write` the agent does not mention is noise.
 *
 * An assistant row carrying an image block has no source in the spec and is
 * left out.
 */
export function mediaItems(messages: readonly ChatMessage[], locate: LocateMedia): MediaItem[] {
  const out: MediaItem[] = [];
  // A tool_result names only the call it answers; the call, earlier in the
  // transcript, carries the tool's name.
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool_use' && m.toolUseId && m.toolName) toolNames.set(m.toolUseId, m.toolName);
    if (m.role === 'user' && m.images?.length) {
      m.images.forEach((image, i) => out.push(refItem(m, i, image, 'you')));
    } else if (m.role === 'tool_result' && m.images?.length) {
      const tool = m.toolUseId ? toolNames.get(m.toolUseId) : undefined;
      m.images.forEach((image, i) => out.push(refItem(m, i, image, 'tool', tool)));
    } else if (m.role === 'assistant' && m.text) {
      const ts = m.timestamp ?? '';
      mediaPathsInReply(m.text).forEach((path, i) => {
        const location = locate(path, m.cwd);
        if (location.kind === 'outside') return;
        out.push({
          id: `${m.id}:${i}`,
          kind: isPdfPath(path) ? 'pdf' : 'image',
          source: 'agent',
          messageId: m.id,
          ts,
          path,
          ...(m.cwd ? { cwd: m.cwd } : {}),
          disk: location.kind === 'not_found' ? 'missing' : diskState(location, ts),
        });
      });
    }
  }
  return out;
}
