import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ChatMessage } from '../types.js';
import { entriesToMessages, parseTranscript, type ImageWriter } from '../transcript/parser.js';

const SUBAGENT_DIR = 'subagents';
const META_FILE = /^(agent-.*)\.meta\.json$/;

/** Where the CLI puts a session's subagent files, beside its transcript. */
export function subagentDirOf(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), SUBAGENT_DIR);
}

/**
 * Each dispatched subagent's messages, keyed by the `toolUseId` of the
 * `Agent` call that dispatched it — the join the walkthrough needs to make
 * an agent's writes a step in the parent's story (spec § The spine). The
 * layout is `docs/domains/subagents-in-transcripts.md`: beside the session
 * file, `<id>/subagents/agent-<x>.jsonl` with `agent-<x>.meta.json` naming
 * the `toolUseId`. An agent with no readable meta, or a meta with no
 * `toolUseId`, is not joinable and is skipped; an unreadable transcript costs
 * that agent only.
 */
export function readSubagentMessages(transcriptPath: string, images?: ImageWriter): Map<string, ChatMessage[]> {
  const out = new Map<string, ChatMessage[]>();
  for (const file of subagentFiles(transcriptPath)) {
    const messages = readSubagentFile(file.transcript, images);
    if (messages) out.set(file.toolUseId, messages);
  }
  return out;
}

/** One subagent's files: its transcript, its meta, and the `Agent` call it joins back to. */
export interface SubagentFile {
  toolUseId: string;
  transcript: string;
  meta: string;
}

/**
 * The joinable subagents of a session, in directory order: each with a
 * readable meta naming its `toolUseId` (see `readSubagentMessages`).
 */
export function subagentFiles(transcriptPath: string): SubagentFile[] {
  const dir = subagentDirOf(transcriptPath);
  const out: SubagentFile[] = [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const file of files) {
    const m = META_FILE.exec(file);
    if (!m) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { toolUseId?: unknown };
      if (typeof meta.toolUseId === 'string' && meta.toolUseId) {
        out.push({ toolUseId: meta.toolUseId, transcript: join(dir, `${m[1]}.jsonl`), meta: join(dir, file) });
      }
    } catch { /* no readable meta: not joinable */ }
  }
  return out;
}

/** One subagent's messages, as the parent's own would read; null when its file is unreadable. */
export function readSubagentFile(path: string, images?: ImageWriter): ChatMessage[] | null {
  try {
    const entries = parseTranscript(readFileSync(path, 'utf8')).map((e) => ({ ...e, isSidechain: false }));
    return entriesToMessages(entries, images);
  } catch {
    // This agent's file is unreadable; the parent's story goes on without it.
    return null;
  }
}
