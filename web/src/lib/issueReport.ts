/**
 * A report to Orbital's GitHub (spec 2026-10-20-report-to-github-design,
 * canvas `Feature - Feedback` 61g PREFILL): its title and markdown body for
 * each way in, and the link that opens GitHub's new-issue form with both
 * filled in when `gh` cannot send it.
 */

export const ISSUE_REPO_URL = 'https://github.com/slothworks-apps/orbital'

/**
 * Past this a GitHub URL is refused; the body is cut to fit under it. A
 * little under the real limit, for the host and path.
 */
export const MAX_ISSUE_URL_CHARS = 8000

/** GitHub refuses a longer title (`MAX_TITLE_CHARS` on the server). */
export const MAX_ISSUE_TITLE_CHARS = 256

/** GitHub refuses a longer body (`MAX_BODY_CHARS` on the server). */
export const MAX_ISSUE_BODY_CHARS = 65_536

const NOT_GIVEN = '_not given_'

const CUT_NOTE = '… cut to fit the link — the full record is on your clipboard, paste it here.'

/** What a bug report says about the machine it came from; every field editable in the dialog. */
export interface IssueEnvironment {
  orbital: string
  runs: string
  cli: string
  os: string
}

export interface BrokeFields {
  what: string
  repro: string
}

export interface IdeaFields {
  way: string
  like: string
}

/** A title GitHub accepts: one line, and no longer than it allows. */
export function issueTitle(text: string): string {
  const line = text.trim().split('\n')[0].trim()
  const chars = Array.from(line)
  return chars.length <= MAX_ISSUE_TITLE_CHARS ? line : chars.slice(0, MAX_ISSUE_TITLE_CHARS - 1).join('') + '…'
}

/**
 * Text as a fenced block whose fence no run of backticks inside it can close —
 * a stack trace or a response body can hold one.
 */
export function fenced(text: string, lang = ''): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

/**
 * `blank`: what an empty section says. A report sent from the review step
 * says `_not given_`; a form the person still fills in on GitHub leaves the
 * line empty for them to type on.
 */
function sections(parts: [heading: string, text: string][], blank = NOT_GIVEN): string {
  return parts.map(([heading, text]) => `## ${heading}\n${text.trim() || blank}`).join('\n\n') + '\n'
}

/** 61g ERROR: kind + message as the title; the record verbatim in a text fence. */
export function errorReport(
  error: { kind: string; message: string },
  record: string,
  envLine: string,
): { title: string; body: string } {
  const kind = error.kind.replace(/_/g, ' ')
  const label = (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/^Api\b/, 'API')
  return {
    title: issueTitle(`${label}: ${error.message}`),
    body: sections([
      ['What happened', error.message],
      ['Record', fenced(record, 'text')],
      ['Environment', envLine],
    ]),
  }
}

/** The one-line environment an error report closes with. */
export function environmentLine(env: IssueEnvironment): string {
  return [`orbital ${env.orbital}`, env.cli && `claude-code ${env.cli}`, env.os && `macOS ${env.os}`]
    .filter(Boolean)
    .join(' · ')
}

/** 61g BROKE. */
export function brokeBody(fields: BrokeFields, env: IssueEnvironment, blank = NOT_GIVEN): string {
  const environment = [
    `Orbital ${env.orbital}`,
    env.runs,
    env.cli && `Claude Code ${env.cli}`,
    env.os && `macOS ${env.os}`,
  ]
    .filter((part) => part && part.trim())
    .join(' · ')
  return sections([
    ['What happened', fields.what],
    ['How to reproduce', fields.repro],
    ['Environment', environment],
  ], blank)
}

/** 61g IDEA. */
export function ideaBody(fields: IdeaFields, blank = NOT_GIVEN): string {
  return sections([
    ['What gets in the way', fields.way],
    ['What I would like', fields.like],
  ], blank)
}

/** The first `text` fence: the record, which is what gives way when the link is too long. */
const RECORD_FENCE = /^(`{3,})text\n([\s\S]*?)\n\1$/m

/**
 * GitHub's new-issue form with the title and body filled in. When the URL
 * would be too long the record is cut — the text before and after it stays
 * whole — or, with no record, the end of the body; `truncated` says so and
 * the caller puts the whole body on the clipboard.
 */
export function issueUrl(title: string, body: string): { url: string; truncated: boolean } {
  const build = (text: string) => `${ISSUE_REPO_URL}/issues/new?${new URLSearchParams({ title, body: text })}`
  const full = build(body)
  if (full.length <= MAX_ISSUE_URL_CHARS) return { url: full, truncated: false }

  const record = RECORD_FENCE.exec(body)
  const [head, inner, tail] = record
    ? [
        body.slice(0, record.index + record[1].length + 'text\n'.length),
        record[2],
        body.slice(record.index + record[0].length - record[1].length - 1),
      ]
    : ['', body, '']
  const chars = Array.from(inner)
  const withLength = (n: number) =>
    build(`${head}${chars.slice(0, n).join('')}\n${CUT_NOTE}${record ? '' : '\n'}${tail}`)
  // The longest prefix that fits: the encoded length grows with the prefix, so bisect.
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (withLength(mid).length <= MAX_ISSUE_URL_CHARS) lo = mid
    else hi = mid - 1
  }
  return { url: withLength(lo), truncated: true }
}

/** What the phone's report says about the phone (61g PHONE): nothing else. */
export interface PhoneEnvironment {
  /** The phone app's version, `version` in `mobile/package.json`. */
  app: string
  /** The system and its version as people name it: `iOS 18.1`, `Android 15`. */
  os: string
  /** The device model as the system reports it; empty when it does not. */
  model: string
}

export type PhoneReportKind = 'broke' | 'idea'

/**
 * 61i: Send feedback on the phone. The desktop's two kinds with an empty
 * title, the bug report's environment being the phone app, its system and
 * its model.
 */
export function phoneReport(kind: PhoneReportKind, env: PhoneEnvironment): { title: string; body: string } {
  if (kind === 'idea') return { title: '', body: ideaBody({ way: '', like: '' }, '') }
  const runs = [env.os, env.model].filter((part) => part.trim()).join(' · ')
  return { title: '', body: brokeBody({ what: '', repro: '' }, { orbital: `mobile ${env.app}`, runs, cli: '', os: '' }, '') }
}
