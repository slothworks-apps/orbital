/**
 * The progress list: the agent's own list of what it is going to do in a
 * session and how far it has got (spec 2026-11-09-progress-list-design, adr
 * progress-list-has-its-own-tool-not-the-clis-tasks). The agent writes it
 * through one MCP tool, and every call carries the whole list, so the list
 * is rebuilt from the tool's calls in the transcript and has no table of its
 * own. The server folds the calls into a figure and validates each new one;
 * the web and the phone fold the same calls into the list and the rows the
 * transcript shows. One fold for all three, so they cannot disagree.
 */

/** The tool's name as the CLI writes it into a transcript: Orbital's `orbital` MCP server, `progress_write`. */
export const PROGRESS_TOOL = 'mcp__orbital__progress_write';

export const PROGRESS_ITEM_STATES = ['pending', 'in_progress', 'done', 'dropped'] as const;
export type ProgressItemState = (typeof PROGRESS_ITEM_STATES)[number];

export interface ProgressItem {
  title: string;
  state: ProgressItemState;
  /** Why the item was dropped; the tool asks for it on every dropped item. */
  reason?: string;
}

/** One call of the tool, as its input carries it. */
export interface ProgressCall {
  items: ProgressItem[];
  /** One sentence the user reads: why items were added or dropped. */
  reason?: string;
  /** A new list for a new task; the previous one stays in the transcript. */
  new_list?: boolean;
}

/** What a call did to the list, for the transcript's rows. */
export type ProgressChange =
  /** The session's first list. */
  | { kind: 'written'; items: ProgressItem[] }
  /** A new list for a new task, in place of `previous`. */
  | { kind: 'new_list'; items: ProgressItem[]; previous: ProgressItem[] }
  /** Items added or dropped, with the call's reason. */
  | { kind: 'changed'; added: string[]; dropped: { title: string; reason?: string }[]; reason?: string }
  /** States moved and nothing else: no row. */
  | { kind: 'ticked' };

function isState(value: unknown): value is ProgressItemState {
  return typeof value === 'string' && (PROGRESS_ITEM_STATES as readonly string[]).includes(value);
}

/** A non-blank string as given, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * A `tool_use` input read as a call, or null when it is not one at all.
 * Tolerant, because a transcript is written by whatever CLI ran: an item
 * without a title is left out, a state nobody knows reads as pending, and a
 * title that repeats keeps its first item.
 */
export function readProgressCall(input: unknown): ProgressCall | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as { items?: unknown; reason?: unknown; new_list?: unknown };
  if (!Array.isArray(raw.items)) return null;
  const items: ProgressItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    if (!entry || typeof entry !== 'object') continue;
    const { title, state, reason } = entry as { title?: unknown; state?: unknown; reason?: unknown };
    const name = text(title);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const why = text(reason);
    items.push({ title: name, state: isState(state) ? state : 'pending', ...(why !== undefined ? { reason: why } : {}) });
  }
  const reason = text(raw.reason);
  return {
    items,
    ...(reason !== undefined ? { reason } : {}),
    ...(raw.new_list === true ? { new_list: true } : {}),
  };
}

/**
 * The list after `call`, and what the call changed. `current` is the list
 * before it, null when the session has none yet.
 *
 * Titles are matched by their exact text. An item of the current list that
 * the call leaves out stays where it was, dropped: a dropped item never
 * leaves the list (spec § Writing the list). A dropped item sent again
 * without a reason keeps the one it was dropped with.
 */
export function applyProgressCall(
  current: ProgressItem[] | null,
  call: ProgressCall,
): { items: ProgressItem[]; change: ProgressChange } {
  if (current === null) return { items: call.items, change: { kind: 'written', items: call.items } };
  if (call.new_list) return { items: call.items, change: { kind: 'new_list', items: call.items, previous: current } };

  const before = new Map(current.map((item) => [item.title, item]));
  const items: ProgressItem[] = call.items.map((item) => {
    const old = before.get(item.title);
    return item.state === 'dropped' && item.reason === undefined && old?.state === 'dropped' && old.reason !== undefined
      ? { ...item, reason: old.reason }
      : item;
  });
  // Each left-out item goes back right after the nearest item before it in
  // the current list that is still on the new one, or first when none is.
  const at = new Set(items.map((item) => item.title));
  current.forEach((old, index) => {
    if (at.has(old.title)) return;
    let after = -1;
    for (let j = index - 1; j >= 0 && after === -1; j--) {
      after = items.findIndex((item) => item.title === current[j].title);
    }
    items.splice(after + 1, 0, { title: old.title, state: 'dropped', ...(old.reason !== undefined && old.state === 'dropped' ? { reason: old.reason } : {}) });
    at.add(old.title);
  });

  // Added: a title the list did not carry, or one it carried dropped and now takes back.
  const added = call.items
    .filter((item) => {
      const old = before.get(item.title);
      return old === undefined || (old.state === 'dropped' && item.state !== 'dropped');
    })
    .map((item) => item.title);
  const dropped = items
    .filter((item) => item.state === 'dropped' && before.has(item.title) && before.get(item.title)!.state !== 'dropped')
    .map((item) => ({ title: item.title, ...(item.reason !== undefined ? { reason: item.reason } : {}) }));
  if (added.length === 0 && dropped.length === 0) return { items, change: { kind: 'ticked' } };
  return {
    items,
    change: { kind: 'changed', added, dropped, ...(call.reason !== undefined ? { reason: call.reason } : {}) },
  };
}

/** Done of the items that count: a dropped item does not. */
export function progressFigure(items: ProgressItem[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const item of items) {
    if (item.state === 'dropped') continue;
    total += 1;
    if (item.state === 'done') done += 1;
  }
  return { done, total };
}
