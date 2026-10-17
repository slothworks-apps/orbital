import { tool } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import type { SessionSource, SessionStatus } from '../types.js';

/**
 * The `orbital` server's tools for looking after other sessions: list them,
 * and archive the ones that are done (spec
 * 2026-10-12-a-session-archives-sessions-design). Archiving is the user's
 * End — the same stamp, the same exit from the map.
 */

export interface ListedSession {
  id: string;
  title: string;
  cwd: string;
  source: SessionSource;
  status: SessionStatus;
  /** A process holds the session now: the Runner's, or a terminal CLI. */
  alive: boolean;
  pinned: boolean;
  /** ISO time of the last activity, null for a session that has none yet. */
  lastAt: string | null;
  /** ISO time the session was archived (ended), null while it is not. */
  archivedAt: string | null;
  /** The session that is calling the tool. */
  self: boolean;
}

export interface ListSessionsInput {
  cwd?: string;
  includeArchived?: boolean;
  limit?: number;
}

export type ArchiveOutcome =
  | { id: string; result: 'archived' | 'already_archived' | 'not_found' }
  | { id: string; result: 'refused'; reason: string };

/** The back end, assigned by the routes, which own the rows and `endSession`. */
export interface SessionKeeper {
  list(callerId: string, input: ListSessionsInput): ListedSession[];
  archive(callerId: string, ids: string[], force: boolean): Promise<ArchiveOutcome[]>;
}

/** Needs no permission card: it only reads. */
export const LIST_SESSIONS_TOOL = 'mcp__orbital__list_sessions';

const LIST_DESCRIPTION = [
  'List Orbital sessions — the planets on the user\'s map — with their id, title, cwd, status (working, needs_input, idle, ended), whether a process is alive, and the time of their last activity.',
  'Use it to find sessions to look after, for example before archiving ones that are done. Archived sessions (status ended) are left out unless include_archived is set.',
].join(' ');

const ARCHIVE_DESCRIPTION = [
  'Archive Orbital sessions by id: the same as the user pressing End — the session leaves the map and moves to history, and its process stops. The user can bring it back.',
  'Use it to clean up sessions that are finished or no longer used, when the user asked you to look after sessions. Call list_sessions first to get the ids.',
  'Refused unless force is set: a session that is working or waiting for the user\'s input, and one the user pinned. Never forced: this session itself, and a terminal session that is still running.',
  'Archiving an archived session does nothing. The result lists, for every id, what was done.',
].join(' ');

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  return { content: [{ type: 'text' as const, text: `Failed: ${(err as Error).message}` }], isError: true };
}

export function listSessionsTool(callerId: string, keeper: SessionKeeper) {
  return tool(
    'list_sessions',
    LIST_DESCRIPTION,
    {
      cwd: z.string().optional().describe('Only sessions working in this directory or below it. Absolute; `~` is expanded.'),
      include_archived: z.boolean().optional().describe('Include archived (ended) sessions. Default false.'),
      limit: z.number().int().min(1).max(200).optional().describe('At most this many, most recent first. Default 50.'),
    },
    (args) => {
      try {
        return Promise.resolve(text(keeper.list(callerId, { cwd: args.cwd, includeArchived: args.include_archived, limit: args.limit })));
      } catch (err) {
        return Promise.resolve(failure(err));
      }
    },
  );
}

export function archiveSessionTool(callerId: string, keeper: SessionKeeper) {
  return tool(
    'archive_session',
    ARCHIVE_DESCRIPTION,
    {
      ids: z.array(z.string().min(1)).min(1).describe('Ids of the sessions to archive, from list_sessions.'),
      force: z.boolean().optional().describe('Archive working, waiting and pinned sessions too, stopping a running turn. Only when the user asked for exactly that.'),
    },
    async (args) => {
      try {
        return text(await keeper.archive(callerId, args.ids, args.force === true));
      } catch (err) {
        return failure(err);
      }
    },
  );
}
