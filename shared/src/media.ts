/**
 * One image or PDF of a session, as `GET /api/sessions/:id/media` lists it
 * (spec 2026-10-09-session-media-design § Data). Shared because the desktop
 * and the phone read the same list.
 */
export interface MediaItem {
  /** Stable across reads: `${messageId}:${index}`, the index counting this message's media. */
  id: string;
  kind: 'image' | 'pdf';
  /**
   * `you` attached or pasted it, a tool's result carried it, the agent named
   * its path in a reply, or a tool call wrote it to a path no reply named
   * (spec 2026-10-13-session-media-more-design). A reader that does not know a
   * source shows the item by its `ref` or `path` and leaves the source unsaid.
   */
  source: 'you' | 'tool' | 'agent' | 'written';
  /** The transcript message it belongs to — what Show in transcript scrolls to. */
  messageId: string;
  /** The message's timestamp. */
  ts: string;
  /** `you` and `tool`: the image store ref. */
  ref?: string;
  /** `agent` and `written`: the path as the reply or the tool call wrote it. */
  path?: string;
  /** `agent` and `written`: the cwd it was written in, which the path resolves against. */
  cwd?: string;
  /** Pixel size, for images whose size is known. */
  w?: number;
  h?: number;
  /** `tool`: the tool_use id of the call whose result carried it, for stacking one run's images. */
  toolRun?: string;
  /** `tool` and `written`: the name of the tool that carried or wrote it, as the transcript records it. */
  tool?: string;
  /** `agent` only: the file now — there, gone, or written after the reply named it. */
  disk?: 'present' | 'missing' | 'changed';
  /**
   * A subagent's: it came from that subagent's own transcript, and
   * `messageId` is the parent's `Agent` call that launched it. `name` is the
   * moon's name — the call's description, else its subagent type.
   */
  subagent?: { toolUseId: string; name: string };
}
