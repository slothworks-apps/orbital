/**
 * One image or PDF of a session, as `GET /api/sessions/:id/media` lists it
 * (spec 2026-10-09-session-media-design § Data). Shared because the desktop
 * and the phone read the same list.
 */
export interface MediaItem {
  /** Stable across reads: `${messageId}:${index}`, the index counting this message's media. */
  id: string;
  kind: 'image' | 'pdf';
  /** `you` attached or pasted it, a tool's result carried it, or the agent named its path in a reply. */
  source: 'you' | 'tool' | 'agent';
  /** The transcript message it belongs to — what Show in transcript scrolls to. */
  messageId: string;
  /** The message's timestamp. */
  ts: string;
  /** `you` and `tool`: the image store ref. */
  ref?: string;
  /** `agent`: the path as the reply wrote it. */
  path?: string;
  /** `agent`: the cwd the reply was written in, which the path resolves against. */
  cwd?: string;
  /** Pixel size, for images whose size is known. */
  w?: number;
  h?: number;
  /** `tool`: the tool_use id of the call whose result carried it, for stacking one run's images. */
  toolRun?: string;
  /** `agent` only: the file now — there, gone, or written after the reply named it. */
  disk?: 'present' | 'missing' | 'changed';
}
