/**
 * Tracks the most recent tool calls per session, for display on cards and
 * ships. Kept in memory only — dropped when a session ends — and fed from
 * wherever tool_use blocks pass: the Runner's stream and transcript tails.
 */

export interface RecentTool {
  name: string;
  summary: string | null;
  at: number;
}

/** Maximum number of recent tool calls kept per session. */
const MAX_RECENT_TOOLS = 30;

/**
 * Extracts a summary from a tool's input, tailored to each tool type.
 * File contents, edit strings, and command output are never included.
 * Collapses whitespace and caps at 80 characters with ellipsis.
 */
function extractSummary(toolName: string, toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;

  const input = toolInput as Record<string, unknown>;

  // File operations: prefer cwd-relative path if session cwd known
  if (toolName === 'Edit' || toolName === 'Read' || toolName === 'Write') {
    const path = input.file_path ?? input.path;
    if (typeof path === 'string') return truncate(path);
    return null;
  }

  // Bash: first line of command
  if (toolName === 'Bash') {
    const cmd = input.command;
    if (typeof cmd === 'string') {
      const firstLine = cmd.split('\n')[0];
      return truncate(firstLine);
    }
    return null;
  }

  // Grep/Glob: search pattern
  if (toolName === 'Grep' || toolName === 'Glob') {
    const pattern = input.pattern;
    if (typeof pattern === 'string') return truncate(pattern);
    return null;
  }

  // WebFetch: URL
  if (toolName === 'WebFetch') {
    const url = input.url;
    if (typeof url === 'string') return truncate(url);
    return null;
  }

  // WebSearch: query
  if (toolName === 'WebSearch') {
    const query = input.query;
    if (typeof query === 'string') return truncate(query);
    return null;
  }

  // Agent/Task: description or subagent_type
  if (toolName === 'Agent' || toolName === 'Task') {
    const desc = input.description;
    if (typeof desc === 'string') return truncate(desc);
    const subType = input.subagent_type;
    if (typeof subType === 'string') return truncate(subType);
    return null;
  }

  // Skill: skill name
  if (toolName === 'Skill') {
    const skill = input.skill;
    if (typeof skill === 'string') return truncate(skill);
    return null;
  }

  // MCP tools: first short string argument
  if (toolName.startsWith('mcp__')) {
    for (const value of Object.values(input)) {
      if (typeof value === 'string') return truncate(value);
    }
    return null;
  }

  // Unknown tool: return null
  return null;
}

/** Truncate to 80 chars and collapse whitespace. */
function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? collapsed.slice(0, 77) + '…' : collapsed;
}

/**
 * Per-session store of recent tool calls. The Runner feeds it from
 * tool_use blocks in messages, and the transcript tail feeds it from
 * the transcript path. Dropped when a session ends.
 */
export class RecentToolsStore {
  private tools = new Map<string, RecentTool[]>();

  /**
   * Record a tool call. Returns true if this call was added (always true
   * unless `toolName` extraction fails entirely).
   */
  record(sessionId: string, toolName: string, toolInput: unknown, at: number): boolean {
    const summary = extractSummary(toolName, toolInput);
    // Still record even if summary is null — the tool was called
    const tool: RecentTool = { name: toolName, summary, at };

    let calls = this.tools.get(sessionId);
    if (!calls) {
      calls = [];
      this.tools.set(sessionId, calls);
    }

    calls.push(tool);
    // Keep only the most recent MAX_RECENT_TOOLS
    if (calls.length > MAX_RECENT_TOOLS) {
      calls.splice(0, calls.length - MAX_RECENT_TOOLS);
    }
    return true;
  }

  /** Get all recent tools for a session. */
  all(sessionId: string): RecentTool[] {
    return [...(this.tools.get(sessionId) ?? [])];
  }

  /** Forget a session entirely — it ended. */
  drop(sessionId: string): void {
    this.tools.delete(sessionId);
  }
}
