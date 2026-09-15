import type { ChatMessage } from '../types.js';

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: { role: string; content: string | Array<Record<string, unknown>> };
}

export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') return null;
    return obj as TranscriptEntry;
  } catch {
    return null;
  }
}

export function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

function textOf(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function extractMeta(entries: TranscriptEntry[]) {
  let cwd = '';
  let title = '';
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let messageCount = 0;
  for (const e of entries) {
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain) continue;
    messageCount++;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(t)) {
      if (firstAt === null) firstAt = t;
      lastAt = t;
    }
    if (!title && e.type === 'user' && e.message) {
      const text = textOf(e.message.content).trim();
      if (text) title = text.slice(0, 120);
    }
  }
  return { cwd, title, firstAt, lastAt, messageCount };
}

export function entriesToMessages(entries: TranscriptEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message || e.isSidechain) continue;
    const base = { timestamp: e.timestamp };
    const content = e.message.content;
    if (typeof content === 'string') {
      out.push({ id: `${e.uuid}:0`, role: e.type, text: content, ...base });
      continue;
    }
    content.forEach((block, i) => {
      const id = `${e.uuid}:${i}`;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ id, role: e.type as 'user' | 'assistant', text: block.text, ...base });
      } else if (block.type === 'tool_use') {
        out.push({
          id, role: 'tool_use', toolName: String(block.name ?? ''),
          toolInput: block.input, toolUseId: String(block.id ?? ''), ...base,
        });
      } else if (block.type === 'tool_result') {
        out.push({
          id, role: 'tool_result', toolUseId: String(block.tool_use_id ?? ''),
          text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          ...base,
        });
      }
    });
  }
  return out;
}
