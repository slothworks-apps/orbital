import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ChatMessage } from '../types.js';
import { entriesToMessages, parseTranscript, type ImageWriter } from '../transcript/parser.js';

const SUBAGENT_DIR = 'subagents';
const META_FILE = /^(agent-.*)\.meta\.json$/;

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
  const dir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), SUBAGENT_DIR);
  const out = new Map<string, ChatMessage[]>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const file of files) {
    const m = META_FILE.exec(file);
    if (!m) continue;
    let toolUseId: string | null = null;
    try {
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { toolUseId?: unknown };
      if (typeof meta.toolUseId === 'string' && meta.toolUseId) toolUseId = meta.toolUseId;
    } catch { continue; }
    if (!toolUseId) continue;
    try {
      const entries = parseTranscript(readFileSync(join(dir, `${m[1]}.jsonl`), 'utf8'))
        .map((e) => ({ ...e, isSidechain: false }));
      out.set(toolUseId, entriesToMessages(entries, images));
    } catch {
      // This agent's file is unreadable; the parent's story goes on without it.
    }
  }
  return out;
}
