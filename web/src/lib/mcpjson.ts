import { api } from './api'

/**
 * The New session question about a project's `.mcp.json` servers (spec
 * 2026-10-08-mcpjson-approval-design § Clients; canvas `Feature - MCP
 * approval` 47a–47e). Shared by the desktop dialog and the phone's sheet:
 * which servers to ask about, how each is labelled, and what the footer says.
 */

/** Where a server's code comes from, as the Mac reads it from the command. */
export type McpjsonSource = 'npm' | 'pypi' | 'docker' | 'file' | 'url' | 'program'

/** One server nobody has decided, as `GET /api/mcpjson` lists it. */
export interface McpjsonServer {
  name: string
  /** The command as written; for a remote server, its URL. */
  command: string
  args: string[]
  source: McpjsonSource
  /** For `source: 'file'`, the path relative to the project. */
  file?: string
}

export type McpjsonAnswer = 'allow' | 'deny'

/** The answers given so far, by server name; an unanswered server has no key. */
export type McpjsonAnswers = Readonly<Record<string, McpjsonAnswer>>

/** What `POST /api/sessions` records. */
export interface McpjsonDecisions {
  allow: string[]
  deny: string[]
}

/**
 * Canvas 47e "Source label". `url` has no label on the canvas, which draws
 * only servers that run a command; it is named the way the others are.
 */
const SOURCE_LABELS: Record<McpjsonSource, string> = {
  npm: 'PACKAGE · NPM',
  pypi: 'PACKAGE · PYPI',
  docker: 'CONTAINER · DOCKER',
  file: 'FILE IN THIS PROJECT',
  url: 'REMOTE · URL',
  program: 'PROGRAM',
}

export function sourceLabel(source: McpjsonSource): string {
  return SOURCE_LABELS[source] ?? SOURCE_LABELS.program
}

/** An argument as a shell would need it written to mean the same thing. */
function shellWord(arg: string): string {
  return arg === '' || /[\s"'\\$`]/.test(arg) ? JSON.stringify(arg) : arg
}

/**
 * What the well shows: the command and its arguments on one line, an
 * argument with a space or a quote in it quoted, so where one argument ends
 * is never ambiguous. Never shortened (47e "Server row").
 */
export function commandLine(server: Pick<McpjsonServer, 'command' | 'args'>): string {
  return [server.command, ...server.args.map(shellWord)].join(' ')
}

/** The answers as the launch sends them; null until every server has one. */
export function decisionsOf(servers: readonly McpjsonServer[], answers: McpjsonAnswers): McpjsonDecisions | null {
  if (!servers.every((s) => answers[s.name])) return null
  return {
    allow: servers.filter((s) => answers[s.name] === 'allow').map((s) => s.name),
    deny: servers.filter((s) => answers[s.name] === 'deny').map((s) => s.name),
  }
}

/** The footer line (47a/47b, 47e "Start session"): what is left to answer, then the tally. */
export function answerSummary(servers: readonly McpjsonServer[], answers: McpjsonAnswers): string {
  const answered = servers.filter((s) => answers[s.name]).length
  const allowed = servers.filter((s) => answers[s.name] === 'allow').length
  const single = servers.length === 1
  if (answered < servers.length) return single ? "choose Allow or Don't allow" : `${answered} of ${servers.length} answered`
  if (single) return `${allowed ? 'allowed' : 'not allowed'} · remembered for this project`
  return `${allowed} allowed · ${servers.length - allowed} not allowed · remembered`
}

/** The question's title, one server or several (47a, 47b). */
export function questionTitle(count: number): string {
  return count === 1 ? 'This project wants to run an MCP server' : 'This project wants to run MCP servers'
}

/**
 * The sentence after `.mcp.json` in the question's intro (47a, 47b; 47c and
 * 47d name the Mac, since the programs run there and not on the phone).
 */
export function questionIntro(count: number, where: string): string {
  return count === 1
    ? ` asks to start this program on ${where} when Claude starts. Orbital remembers your choice for this project.`
    : ` asks to start these programs on ${where} when Claude starts. Orbital remembers your choices for this project.`
}

/**
 * The servers to ask about before a launch from `cwd`. A read that fails
 * asks about nothing, and the launch goes ahead without answers: the Mac
 * keeps every undecided server out of a launch that carries none (spec §
 * Behaviour 1), so nothing runs unasked, and the next launch asks again. It
 * is also what a Mac too old to have the route answers a newer phone with.
 */
export async function undecidedBeforeLaunch(cwd: string, claudeDirId?: number): Promise<McpjsonServer[]> {
  try {
    return (await api.mcpjson(cwd, claudeDirId)) ?? []
  } catch (err) {
    console.warn('orbital: could not read the project`s undecided .mcp.json servers', err)
    return []
  }
}
