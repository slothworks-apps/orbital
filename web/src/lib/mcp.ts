import { ApiError } from './api'
import type { McpScope, McpServerDefinition, McpServerRow, McpTransport } from './types'

/**
 * The MCP dialog's pure model (spec 2026-10-01-mcp-servers-in-the-session-design;
 * canvas `Feature - MCP dialog` 12a–12d): how a row reads, the arguments line,
 * the add/edit form and how the server's refusals read.
 */

/** Sent as a whole message, it opens the MCP dialog instead of reaching the agent (spec § Where it lives). */
export const MCP_COMMAND = '/mcp'

export function isMcpCommand(text: string): boolean {
  return text.trim() === MCP_COMMAND
}

/** How often the list is fetched again while a server is starting or a login waits, only while the dialog is open (spec § The list). */
export const MCP_REFRESH_MS = 2000

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** The five statuses the SDK knows; anything else is a newer CLI's and is shown as text. */
export type McpStatusKind = 'connected' | 'failed' | 'login' | 'starting' | 'off' | 'unknown'

export function mcpStatusKind(status: string): McpStatusKind {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'failed':
      return 'failed'
    case 'needs-auth':
      return 'login'
    case 'pending':
      return 'starting'
    case 'disabled':
      return 'off'
    default:
      return 'unknown'
  }
}

const STATUS_LABEL: Record<Exclude<McpStatusKind, 'unknown'>, string> = {
  connected: 'CONNECTED',
  failed: 'FAILED',
  login: 'NEEDS LOGIN',
  starting: 'STARTING…',
  off: 'OFF',
}

/** The status word on a row's meta line (canvas 12d, STATUS). */
export function mcpStatusLabel(status: string): string {
  const kind = mcpStatusKind(status)
  return kind === 'unknown' ? status.toUpperCase() : STATUS_LABEL[kind]
}

/**
 * The name a row shows and the origin chip beside it. A plugin's server reads
 * `<server>` under `plugin · <plugin>`; Orbital's own — the one row that cannot
 * be switched — reads `built-in`; a claude.ai connector reads `claude.ai`
 * (canvas `Feature - MCP dialog` 12d), not the SDK's `claudeai`.
 */
export function mcpRowLabels(
  row: Pick<McpServerRow, 'name' | 'origin' | 'plugin' | 'toggleable'>,
): {
  name: string
  origin: string | null
} {
  if (!row.toggleable) return { name: row.name, origin: 'built-in' }
  if (row.plugin) {
    const prefix = `plugin:${row.plugin}:`
    const name =
      row.name.startsWith(prefix) && row.name.length > prefix.length
        ? row.name.slice(prefix.length)
        : row.name
    return { name, origin: `plugin · ${row.plugin}` }
  }
  if (row.origin === CLAUDEAI_ORIGIN) return { name: row.name, origin: 'claude.ai' }
  return { name: row.name, origin: row.origin ?? null }
}

/** How many servers are still starting — while any is, the list is fetched again. */
export function startingCount(servers: readonly McpServerRow[]): number {
  return servers.filter((s) => mcpStatusKind(s.status) === 'starting').length
}

// ---------------------------------------------------------------------------
// Log in (spec § Log in)
// ---------------------------------------------------------------------------

/** The `origin` of a claude.ai connector: logged in on claude.ai, never from Orbital. */
export const CLAUDEAI_ORIGIN = 'claudeai'

/** A row Orbital can start a login for: it needs one, and it is not a claude.ai connector. */
export function isMcpLoginable(row: Pick<McpServerRow, 'status' | 'origin'>): boolean {
  return mcpStatusKind(row.status) === 'login' && row.origin !== CLAUDEAI_ORIGIN
}

/**
 * The rows whose login page was opened and that now wait for the browser,
 * keyed by server name. `reconnected` is set once the window's regaining
 * focus has reconnected the row — once per login attempt.
 */
export type McpLoginWaits = Readonly<Record<string, { reconnected: boolean }>>

/** A login page was opened for `name`: it waits, and a fresh attempt may reconnect again. */
export function startMcpLoginWait(waits: McpLoginWaits, name: string): McpLoginWaits {
  return { ...waits, [name]: { reconnected: false } }
}

/**
 * Drops every wait whose row is gone or no longer needs a login. Answers the
 * same object when nothing changed, so it can feed a state setter safely.
 */
export function settleMcpLoginWaits(
  waits: McpLoginWaits,
  servers: readonly McpServerRow[],
): McpLoginWaits {
  const stillWaiting = new Set(
    servers.filter((s) => mcpStatusKind(s.status) === 'login').map((s) => s.name),
  )
  const names = Object.keys(waits)
  const kept = names.filter((name) => stillWaiting.has(name))
  if (kept.length === names.length) return waits
  const next: Record<string, { reconnected: boolean }> = {}
  for (const name of kept) next[name] = waits[name]
  return next
}

/**
 * What the window regaining focus does: every waiting row that still needs a
 * login and has not been reconnected in this attempt is reconnected, and is
 * marked so the next focus leaves it alone.
 */
export function mcpLoginFocus(
  waits: McpLoginWaits,
  servers: readonly McpServerRow[],
): { reconnect: string[]; waits: McpLoginWaits } {
  const needsLogin = new Set(
    servers.filter((s) => mcpStatusKind(s.status) === 'login').map((s) => s.name),
  )
  const reconnect = Object.keys(waits).filter(
    (name) => !waits[name].reconnected && needsLogin.has(name),
  )
  if (reconnect.length === 0) return { reconnect, waits }
  const next = { ...waits }
  for (const name of reconnect) next[name] = { reconnected: true }
  return { reconnect, waits: next }
}

/** The list is fetched again every MCP_REFRESH_MS while a server is starting or a login waits for the browser. */
export function shouldRefreshMcpList(
  servers: readonly McpServerRow[],
  waits: McpLoginWaits,
): boolean {
  return startingCount(servers) > 0 || Object.keys(waits).length > 0
}

/** Only Orbital's own server: the dialog's "no servers of your own yet" state (canvas 12c, NO SERVERS). */
export function hasOwnServers(servers: readonly McpServerRow[]): boolean {
  return servers.some((s) => s.toggleable)
}

// ---------------------------------------------------------------------------
// The arguments line
// ---------------------------------------------------------------------------

export type SplitResult = { ok: true; words: string[] } | { ok: false; error: string }

/**
 * Splits the ARGS line into words by shell rules (spec § Add and edit):
 * whitespace separates, single quotes take everything literally, double quotes
 * group and let a backslash escape `"`, `\`, `$` and a backtick, and outside
 * quotes a backslash escapes any character. Nothing is expanded — no
 * variables, no globs, no `~`. An unterminated quote is an error.
 */
export function splitArgs(line: string): SplitResult {
  const words: string[] = []
  let word = ''
  // A word exists once anything opened it, so `''` is an empty word rather than nothing.
  let inWord = false
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (/\s/.test(c)) {
      if (inWord) {
        words.push(word)
        word = ''
        inWord = false
      }
      i++
      continue
    }
    inWord = true
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close === -1) return { ok: false, error: 'Unterminated single quote.' }
      word += line.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (c === '"') {
      i++
      let closed = false
      while (i < line.length) {
        const d = line[i]
        if (d === '"') {
          closed = true
          i++
          break
        }
        if (d === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
          word += line[i + 1]
          i += 2
          continue
        }
        word += d
        i++
      }
      if (!closed) return { ok: false, error: 'Unterminated double quote.' }
      continue
    }
    if (c === '\\') {
      // A trailing backslash has nothing to escape and stays itself.
      if (i + 1 < line.length) {
        word += line[i + 1]
        i += 2
      } else {
        word += c
        i++
      }
      continue
    }
    word += c
    i++
  }
  if (inWord) words.push(word)
  return { ok: true, words }
}

/** Characters a word can carry without quoting. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Joins a stored argument list back into one line for the edit form, quoting
 * every word that needs it, so that `splitArgs(joinArgs(words))` gives
 * `words` back. A word is single-quoted, and a `'` inside it is written `'\''`.
 */
export function joinArgs(words: readonly string[]): string {
  return words.map((w) => (SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** One env variable or header row. Blank rows are kept for the form and dropped on save. */
export interface McpKvRow {
  key: string
  value: string
}

export interface McpForm {
  name: string
  scope: McpScope
  transport: McpTransport
  command: string
  /** The arguments as one line, split on save. */
  args: string
  url: string
  env: McpKvRow[]
  headers: McpKvRow[]
}

export function blankKvRow(): McpKvRow {
  return { key: '', value: '' }
}

/** A new server: this project, only me — the default scope (spec § Add and edit). */
export function emptyMcpForm(): McpForm {
  return {
    name: '',
    scope: 'local',
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    env: [blankKvRow()],
    headers: [blankKvRow()],
  }
}

function rowsOf(record: Record<string, string> | undefined): McpKvRow[] {
  const rows = Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))
  return rows.length > 0 ? rows : [blankKvRow()]
}

/** The edit form, filled with the server's current definition. */
export function mcpFormFromDefinition(definition: McpServerDefinition): McpForm {
  const form = { ...emptyMcpForm(), name: definition.name, scope: definition.scope }
  if (definition.transport === 'stdio') {
    return {
      ...form,
      transport: 'stdio',
      command: definition.command,
      args: joinArgs(definition.args),
      env: rowsOf(definition.env),
    }
  }
  return {
    ...form,
    transport: definition.transport,
    url: definition.url,
    headers: rowsOf(definition.headers),
  }
}

export interface McpFormErrors {
  name?: string
  command?: string
  args?: string
  url?: string
}

/**
 * The checks the form runs before anything is sent; the CLI's own validation
 * still has the last word. Copy from canvas 12a's demo.
 */
export function validateMcpForm(form: McpForm): McpFormErrors {
  const errors: McpFormErrors = {}
  const name = form.name.trim()
  if (!name) errors.name = 'Give the server a name.'
  else if (/\s/.test(name)) errors.name = 'No spaces — the CLI uses the name as an id.'
  if (form.transport === 'stdio') {
    if (!form.command.trim()) errors.command = 'A command is required for stdio.'
    const split = splitArgs(form.args)
    if (!split.ok) errors.args = split.error
  } else if (!/^https?:\/\//.test(form.url.trim())) {
    errors.url = 'Must start with http:// or https://'
  }
  return errors
}

export function hasMcpFormErrors(errors: McpFormErrors): boolean {
  return Object.values(errors).some(Boolean)
}

function recordOf(rows: readonly McpKvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

/**
 * The request body for a valid form. Only the chosen transport's fields go:
 * a stdio server carries command, args and env, a remote one url and
 * headers. Rows without a key are dropped. Throws on an arguments line that
 * does not split — validate first.
 */
export function mcpRequestBody(form: McpForm): McpServerDefinition {
  const base = { name: form.name.trim(), scope: form.scope }
  if (form.transport === 'stdio') {
    const split = splitArgs(form.args)
    if (!split.ok) throw new Error(split.error)
    return {
      ...base,
      transport: 'stdio',
      command: form.command.trim(),
      args: split.words,
      env: recordOf(form.env),
    }
  }
  return {
    ...base,
    transport: form.transport,
    url: form.url.trim(),
    headers: recordOf(form.headers),
  }
}

/** A form compared for what it would save: blank kv rows and surrounding whitespace do not count. */
function comparable(form: McpForm): string {
  const rows = (list: readonly McpKvRow[]) =>
    list.filter((r) => r.key.trim() || r.value).map((r) => [r.key.trim(), r.value])
  return JSON.stringify([
    form.name.trim(),
    form.scope,
    form.transport,
    form.command.trim(),
    form.args.trim(),
    form.url.trim(),
    rows(form.env),
    rows(form.headers),
  ])
}

/** Whether Esc or ← Servers would throw something away and has to ask first (spec § Add and edit). */
export function isMcpFormDirty(form: McpForm, initial: McpForm): boolean {
  return comparable(form) !== comparable(initial)
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export interface McpFailure {
  status: number | null
  /** The route's error code (`cli_refused`, `not_editable`, `not_running` …), when it sent one. */
  code: string | null
  /** The route's message — the CLI's own output on `cli_refused` — else its code, else the raw body. */
  message: string
  /** The command line Orbital ran, every env and header value masked — on `cli_refused`. */
  command: string | null
}

/**
 * Reads a failed MCP request. The routes answer `{ error: <code>, message?,
 * command? }`, and an `ApiError`'s message is that body verbatim.
 */
export function mcpFailure(err: unknown): McpFailure {
  if (!(err instanceof ApiError)) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: null, code: null, message, command: null }
  }
  const raw = {
    status: err.status,
    code: null,
    message: err.message || `HTTP ${err.status}`,
    command: null,
  }
  let body: { error?: unknown; message?: unknown; command?: unknown }
  try {
    body = JSON.parse(err.message) as typeof body
  } catch {
    return raw
  }
  if (typeof body !== 'object' || body === null) return raw
  const code = typeof body.error === 'string' && body.error ? body.error : null
  const message = typeof body.message === 'string' && body.message ? body.message : null
  return {
    status: err.status,
    code,
    message: message ?? code ?? raw.message,
    command: typeof body.command === 'string' && body.command ? body.command : null,
  }
}

/** 503 `cli_missing`: `claude` is not on PATH, so add, edit and remove cannot run (spec § Config — through the CLI). */
export function isCliMissing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503
}

/**
 * 409 `not_running`: the session has no process here (spec § Where it lives).
 * The restart route's other 409s — `busy`, `terminal_session` — are not this.
 */
export function isSessionNotRunning(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && mcpFailure(err).code === 'not_running'
}
