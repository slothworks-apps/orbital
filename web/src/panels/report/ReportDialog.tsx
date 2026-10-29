import { swatch } from '../../lib/palette'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { version as orbitalVersion } from '../../../../desktop/package.json'
import { api } from '../../lib/api'
import { copyToClipboard } from '../../lib/clipboard'
import { reportError } from '../../lib/errors'
import {
  brokeBody,
  environmentLine,
  errorReport,
  ideaBody,
  ISSUE_REPO_URL,
  issueTitle,
  issueUrl as issueFormUrl,
  type IssueEnvironment,
} from '../../lib/issueReport'
import type { DuplicateIssue, ErrorRecord, SimilarIssue } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { AutoHeight } from '../../ui/AutoHeight'
import { Collapse } from '../../ui/Collapse'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Select } from '../../ui/Select'
import { formatRecordForCopy } from '../../lib/errorRecord'
import {
  CHECK_MODEL_SETTING,
  CHECKED_ISSUES,
  checkModels,
  footLine,
  ISSUE_CHECK_ENABLED_KEY,
  ISSUE_REPO_PATH,
  issueNumber,
  pickCheckModel,
  refusalMessage,
  SIMILAR_DEBOUNCE_MS,
  type GhState,
  type ReportKind,
  type ReportPhase,
} from './logic'

export type { ReportKind } from './logic'

/*
 * The review step every report to Orbital's GitHub passes (spec
 * 2026-10-20-report-to-github-design). Every value below is read off the
 * `Report Dialog` component of `Feature - Feedback` (canvas 61a/61d/61h/61g);
 * its script comment decides the copy and which control shows when.
 */

const DIALOG_LABEL = 'Review the issue before it is published'

/** How the app runs, as RUNS AS and the error report's environment say it. */
const RUNS_AS = import.meta.env.DEV ? 'From source (npm run dev)' : 'Desktop app'

const MONO_LABEL = 'font-mono fs-10 tracking-[0.18em] text-ink-900/60'
const FIELD_BOX =
  'm-0 box-border w-full appearance-none rounded-lg border border-line/16 bg-shade/60 outline-none focus:border-[oklch(85%_.12_205/.55)]'
const PROSE_AREA = `${FIELD_BOX} resize-none px-3 py-[9px] fs-13 leading-normal text-ink-100`
const OPEN_INK = swatch('ink-400', 0.85)
const CLOSED_INK = swatch('ink-900', 0.5)

/** Every issue link opens on GitHub, in the browser. */
function IssueLink({ issue, children, className }: { issue: SimilarIssue; children: ReactNode; className: string }) {
  return (
    <a href={issue.url} target="_blank" rel="noreferrer" title="Opens on GitHub" className={className}>
      {children}
    </a>
  )
}

function StateTag({ state }: { state: SimilarIssue['state'] }) {
  return (
    <span
      className="flex-none font-mono fs-9 tracking-[0.12em]"
      style={{ color: state === 'open' ? OPEN_INK : CLOSED_INK }}
    >
      {state === 'open' ? 'OPEN' : 'CLOSED'}
    </span>
  )
}

type CheckState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'matches'; matches: DuplicateIssue[] }
  | { state: 'none' }
  | { state: 'failed'; text: string; detail: string }

export interface ReportDialogProps {
  open: boolean
  kind: ReportKind
  /** The record a kind `error` report is made from. */
  error?: ErrorRecord
  onClose: () => void
}

/**
 * Stacks over the dialog it is opened from — the error log, Settings — which
 * stays mounted beneath; Escape closes only this one, since it is rendered
 * inside the parent's `EscapeBoundary` and so ranks above it.
 */
export function ReportDialog({ open, kind, error, onClose }: ReportDialogProps): JSX.Element {
  // Each opening starts from a fresh draft: the review is keyed on it.
  const [wasOpen, setWasOpen] = useState(open)
  const [opening, setOpening] = useState(0)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpening(opening + 1)
  }
  return (
    <Dialog open={open} variant="review" anchorTop title={DIALOG_LABEL} onClose={onClose}>
      <Review key={opening} kind={kind} error={error} onClose={onClose} />
    </Dialog>
  )
}

function Review({ kind, error, onClose }: { kind: ReportKind; error?: ErrorRecord; onClose: () => void }) {
  const cli = useOrbital((s) => s.settings.claude_code_version) ?? ''
  const keptModel = useOrbital((s) => s.settings[CHECK_MODEL_SETTING])
  const checkEnabled = useOrbital((s) => s.settings[ISSUE_CHECK_ENABLED_KEY] === 'true')
  const catalog = useOrbital((s) => s.models)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const [gh, setGh] = useState<GhState>(null)
  const [login, setLogin] = useState<string | null>(null)
  const [osVersion, setOsVersion] = useState<string | null>(null)

  const prefill = (os: string) =>
    kind === 'error' && error
      ? errorReport(error, formatRecordForCopy(error), environmentLine({ orbital: orbitalVersion, runs: RUNS_AS, cli, os }))
      : { title: '', body: '' }

  const [title, setTitle] = useState(() => prefill('').title)
  const [body, setBody] = useState(() => prefill('').body)
  const bodyEdited = useRef(false)
  const [what, setWhat] = useState('')
  const [repro, setRepro] = useState('')
  const [way, setWay] = useState('')
  const [like, setLike] = useState('')
  const [env, setEnv] = useState<IssueEnvironment>({ orbital: orbitalVersion, runs: RUNS_AS, cli, os: '' })
  const osEdited = useRef(false)

  const [phase, setPhase] = useState<ReportPhase>('edit')
  const [refusal, setRefusal] = useState('')
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    api
      .ghStatus()
      .then((r) => live.current && setGh(r?.status ?? 'missing'))
      .catch(() => live.current && setGh('missing'))
    api
      .issueEnvironment()
      .then((r) => {
        if (!live.current || !r) return
        setLogin(r.ghLogin)
        // The server words it for a device row (`macOS 15.1`); the field is already labelled MACOS.
        setOsVersion(r.osVersion?.replace(/^macOS\s+/, '') ?? null)
      })
      .catch(() => {})
  }, [])

  // The macOS version arrives after the dialog opened; it fills in what the
  // user has not touched yet, and nothing they have.
  useEffect(() => {
    if (!osVersion) return
    if (!osEdited.current) setEnv((e) => ({ ...e, os: osVersion }))
    if (!bodyEdited.current && kind === 'error') setBody(prefill(osVersion).body)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the version lands
  }, [osVersion])

  const markdown =
    kind === 'error' ? body : kind === 'broke' ? brokeBody({ what, repro }, env) : ideaBody({ way, like })
  const sendTitle = issueTitle(title)
  const hasTitle = sendTitle.length > 0
  const locked = phase === 'sending' || phase === 'done'
  const fieldOpacity = locked ? 0.6 : 1
  const viaGh = gh === 'ready' && phase !== 'opened'

  function openInBrowser() {
    const { url, truncated: cut } = issueFormUrl(sendTitle, markdown)
    window.open(url, '_blank', 'noopener')
    // The link carries what fits; the clipboard carries all of it.
    if (cut) void copyToClipboard(markdown)
    setTruncated(cut)
    setPhase('opened')
  }

  async function create() {
    setPhase('sending')
    try {
      const result = await api.createIssue({
        title: sendTitle,
        body: markdown,
        ...(kind === 'error' && error ? { errorId: error.id } : {}),
      })
      if (!live.current) return
      if ('url' in result) {
        setCreatedUrl(result.url)
        setPhase('done')
      } else if (result.error === 'timeout') {
        // GitHub may have it all the same: never "nothing was published" here.
        setPhase('late')
      } else {
        // gh went away between the dialog opening and the send: the browser
        // takes it from here.
        setGh(result.error)
        openInBrowser()
      }
    } catch (err) {
      if (!live.current) return
      setRefusal(refusalMessage(err))
      setPhase('error')
    }
  }

  const primary = () => (viaGh ? void create() : openInBrowser())
  const primaryLabel =
    phase === 'sending'
      ? 'Creating…'
      : phase === 'error' || phase === 'late'
        ? 'Try again'
        : viaGh
          ? 'Create issue'
          : 'Open on GitHub ↗'
  const primaryOff = phase === 'sending' || !hasTitle || gh === null

  const number = issueNumber(createdUrl)
  const eyebrow =
    phase === 'done'
      ? `PUBLISHED · ISSUE #${number ?? ''}`
      : kind === 'error'
        ? 'REPORT · FROM THE ERROR LOG'
        : kind === 'idea'
          ? 'FEEDBACK · AN IDEA'
          : 'FEEDBACK · SOMETHING BROKE'
  const via = gh === null ? '' : viaGh ? (login ? `as @${login} · gh` : 'gh') : 'in your browser'
  const foot = footLine({ phase, gh, kind, length: markdown.length, truncated })

  return (
    <>
      <div className="flex shrink-0 items-start gap-3 border-b border-line/10 pb-4 pl-[26px] pr-[18px] pt-[22px]">
        <div className="min-w-0 flex-1">
          <div key={eyebrow} className="orbital-arrive font-mono fs-10 tracking-[0.2em] text-ink-900/65">
            {eyebrow}
          </div>
          <h2 className="mt-1.5 fs-20 leading-(--text-xl--line-height) font-bold tracking-[-0.01em]">{phase === 'done' ? 'Issue created' : 'Review the issue'}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-[30px] w-[30px] shrink-0 cursor-pointer place-items-center rounded-[7px] fs-16 leading-(--text-base--line-height) text-ink-900/70 transition-colors hover:bg-line/8 hover:text-ink-100"
        >
          ×
        </button>
      </div>

      <div className="mx-[26px] mt-4 flex shrink-0 items-start gap-3 rounded-[10px] border border-line/16 bg-shade/45 px-3.5 py-[11px]">
        <span className="mt-px flex-none rounded border border-ink-500/50 px-[7px] py-0.5 font-mono fs-9.5 tracking-[0.16em] text-ink-100">
          PUBLIC
        </span>
        <div className="min-w-0 flex-1 fs-12.5 leading-normal text-pretty text-ink-400/92">
          Published as a public issue on{' '}
          <span className="font-mono fs-11.5 text-ink-100">github.com/{ISSUE_REPO_PATH}</span>. Anyone can read
          it, so take out paths, repo names or anything private first.
        </div>
        <span className="mt-0.5 flex-none whitespace-nowrap font-mono fs-10.5 text-ink-900/60">{via}</span>
      </div>

      <AutoHeight scroll className="mt-4">
        <div className="flex items-stretch border-t border-line/8">
          <div className="flex min-w-0 flex-1 flex-col gap-3.5 pb-[18px] pl-[26px] pr-6 pt-4">
            <label className="flex flex-col gap-1.5">
              <span className={MONO_LABEL}>TITLE</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                readOnly={locked}
                placeholder={kind === 'idea' ? 'The idea, in one line' : 'What broke, in one line'}
                style={{ opacity: fieldOpacity }}
                className={`${FIELD_BOX} px-3 py-[9px] fs-13.5 font-semibold text-ink-100`}
              />
            </label>

            {kind === 'error' && (
              <label className="flex flex-col gap-1.5">
                <span className={`flex items-baseline gap-2 ${MONO_LABEL}`}>
                  BODY
                  <span className="flex-1" />
                  <span className="tracking-[0.04em] text-ink-900/55">markdown</span>
                </span>
                <textarea
                  value={body}
                  onChange={(e) => {
                    bodyEdited.current = true
                    setBody(e.target.value)
                  }}
                  readOnly={locked}
                  style={{ opacity: fieldOpacity }}
                  className={`${FIELD_BOX} h-[268px] resize-none whitespace-pre-wrap px-3 py-2.5 font-mono fs-11 leading-[1.6] text-ink-500/90 [scrollbar-color:color-mix(in_oklab,_var(--color-line)_25%,_transparent)_transparent] [scrollbar-width:thin]`}
                />
              </label>
            )}

            {kind === 'broke' && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className={MONO_LABEL}>WHAT HAPPENED</span>
                  <textarea
                    value={what}
                    onChange={(e) => setWhat(e.target.value)}
                    readOnly={locked}
                    placeholder="What you did, what you saw"
                    style={{ opacity: fieldOpacity }}
                    className={`${PROSE_AREA} h-[92px]`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={MONO_LABEL}>
                    HOW TO REPRODUCE <span className="text-ink-900/60">· OPTIONAL</span>
                  </span>
                  <textarea
                    value={repro}
                    onChange={(e) => setRepro(e.target.value)}
                    readOnly={locked}
                    placeholder="1. …"
                    style={{ opacity: fieldOpacity }}
                    className={`${PROSE_AREA} h-[72px]`}
                  />
                </label>
                <div className="flex flex-col gap-2">
                  <span className={`flex items-baseline gap-2 ${MONO_LABEL}`}>
                    ENVIRONMENT
                    <span className="flex-1" />
                    <span className="tracking-[0.04em] text-ink-900/50">filled in · edit if it's wrong</span>
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ['ORBITAL', 'orbital'],
                        ['RUNS AS', 'runs'],
                        ['CLAUDE CODE', 'cli'],
                        ['MACOS', 'os'],
                      ] as const
                    ).map(([label, field]) => (
                      <label
                        key={field}
                        style={{ opacity: fieldOpacity }}
                        className="flex items-center gap-2 rounded-lg border border-line/14 bg-shade/60 pl-[11px] focus-within:border-[oklch(85%_.12_205/.55)]"
                      >
                        <span className="w-[78px] flex-none font-mono fs-9.5 tracking-[0.12em] text-ink-900/55">
                          {label}
                        </span>
                        <input
                          type="text"
                          value={env[field]}
                          onChange={(e) => {
                            if (field === 'os') osEdited.current = true
                            const value = e.target.value
                            setEnv((prev) => ({ ...prev, [field]: value }))
                          }}
                          readOnly={locked}
                          className="m-0 min-w-0 flex-1 appearance-none border-0 bg-transparent py-2 pr-2.5 font-mono fs-11.5 text-ink-100 outline-none"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            {kind === 'idea' && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className={MONO_LABEL}>WHAT GETS IN YOUR WAY</span>
                  <textarea
                    value={way}
                    onChange={(e) => setWay(e.target.value)}
                    readOnly={locked}
                    placeholder="The moment it slows you down"
                    style={{ opacity: fieldOpacity }}
                    className={`${PROSE_AREA} h-[118px]`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={MONO_LABEL}>WHAT YOU WOULD LIKE</span>
                  <textarea
                    value={like}
                    onChange={(e) => setLike(e.target.value)}
                    readOnly={locked}
                    placeholder="What Orbital would do instead"
                    style={{ opacity: fieldOpacity }}
                    className={`${PROSE_AREA} h-[118px]`}
                  />
                </label>
              </>
            )}

            {/* The column's 14px gap travels inside the collapsing box, so the
                block's arrival and departure move nothing by a gap's height. */}
            <Collapse open={phase === 'late'} stagger className="-mt-3.5">
              <div className="pt-3.5">
                <div
                  role="status"
                  className="flex flex-col gap-[9px] rounded-[10px] border border-line/14 bg-shade/50 px-3.5 py-3"
                >
                  <div className="fs-13 leading-[1.45] text-ink-100">
                    gh did not answer in time. The issue may have been created all the same — look before you send
                    it again; your text is kept.
                  </div>
                  <div className="flex gap-1.5">
                    <Button variant="pill" size="pill" onClick={() => window.open(`${ISSUE_REPO_URL}/issues?q=is%3Aissue+author%3A%40me`, '_blank', 'noopener')}>
                      Your issues on GitHub ↗
                    </Button>
                  </div>
                </div>
              </div>
            </Collapse>
            <Collapse open={phase === 'error'} stagger className="-mt-3.5">
              <div className="pt-3.5">
                <div
                  role="alert"
                  className="flex flex-col gap-[9px] rounded-[10px] border border-line/14 bg-shade/50 px-3.5 py-3"
                >
                  <div className="flex items-center gap-[9px] fs-13 leading-[1.45] text-ink-100">
                    {/* 61d D4: the error log's one red dot, oklch(66% .2 25). */}
                    <span aria-hidden className="block h-[7px] w-[7px] flex-none rounded-full bg-[oklch(66%_.2_25)]" />
                    gh refused the issue. Nothing was published; your text is kept.
                  </div>
                  <pre data-selectable className="m-0 whitespace-pre-wrap break-words rounded-[7px] bg-space/60 px-2.5 py-2 font-mono fs-10.5 leading-[1.6] text-ink-700/80">
                    {refusal}
                  </pre>
                  <div className="flex gap-1.5">
                    <Button variant="pill" size="pill" onClick={openInBrowser}>
                      Open on GitHub instead ↗
                    </Button>
                  </div>
                </div>
              </div>
            </Collapse>
          </div>

          <Rail
            title={sendTitle}
            markdown={markdown}
            ghReady={gh === 'ready'}
            checkEnabled={checkEnabled}
            keptModel={keptModel}
            catalog={catalog}
          />
        </div>
      </AutoHeight>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-line/10 pb-4 pl-[26px] pr-5 pt-3.5">
        <span
          key={foot.text}
          style={{ color: foot.bright ? swatch('ink-400', 0.92) : swatch('ink-900', 0.55) }}
          className="orbital-arrive min-w-0 flex-1 font-mono fs-10.5 leading-normal tracking-[0.03em] text-pretty"
        >
          {foot.text}
        </span>
        <Button variant="ghost" size="lg" onClick={onClose}>
          {phase === 'done' || phase === 'opened' ? 'Close' : 'Cancel'}
        </Button>
        {phase === 'done' && createdUrl ? (
          <a
            href={createdUrl}
            target="_blank"
            rel="noreferrer"
            title={`Open issue #${number ?? ''} on GitHub`}
            className="orbital-arrive flex items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[oklch(85%_.12_205/.55)] bg-[oklch(85%_.12_205/.08)] px-4 py-2 font-mono fs-13 text-accent no-underline transition-colors hover:bg-[oklch(85%_.12_205/.14)]"
          >
            #{number ?? ''} ↗
          </a>
        ) : (
          <Button variant="primary" size="lg" onClick={primary} disabled={primaryOff}>
            {primaryLabel}
          </Button>
        )}
      </div>
    </>
  )
}

/**
 * The right column (canvas 61h): issues with a similar title, searched as the
 * title is typed, and below it the opt-in Check with Claude. Neither ever
 * disables sending.
 */
function Rail({
  title,
  markdown,
  ghReady,
  checkEnabled,
  keptModel,
  catalog,
}: {
  title: string
  markdown: string
  ghReady: boolean
  /** Labs → Check reports with Claude; without it the rail is the title search alone. */
  checkEnabled: boolean
  keptModel: string | undefined
  catalog: Parameters<typeof checkModels>[0]
}) {
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  // --- Similar issues, by title -------------------------------------------
  const query = title.trim()
  const autoOn = query.length > 3
  // `issues: null` — GitHub could not be searched: the rail then says nothing
  // about duplicates rather than "none" (spec → Before sending).
  const [similar, setSimilar] = useState<{ issues: SimilarIssue[] | null } | null>(null)
  useEffect(() => {
    if (!autoOn) {
      setSimilar(null)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      api
        .similarIssues(query)
        .then((issues) => current && setSimilar({ issues: issues ?? null }))
        .catch(() => current && setSimilar({ issues: null }))
    }, SIMILAR_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, autoOn])
  const searchable = similar === null || similar.issues !== null
  const list = similar?.issues ?? []

  // --- Check with Claude ---------------------------------------------------
  const models = useMemo(() => checkModels(catalog), [catalog])
  const model = pickCheckModel(models, keptModel)
  const modelName = model?.name ?? 'Claude'
  const [check, setCheck] = useState<CheckState>({ state: 'idle' })
  const checking = check.state === 'checking'

  function pickModel(value: string) {
    useOrbital.setState((s) => ({ settings: { ...s.settings, [CHECK_MODEL_SETTING]: value } }))
    api.patchSettings({ [CHECK_MODEL_SETTING]: value }).catch((err) => reportError(err, 'Could not keep the model'))
  }

  async function runCheck() {
    if (!model) return
    setCheck({ state: 'checking' })
    try {
      const result = await api.checkDuplicateIssues({ title, body: markdown, model: model.value })
      if (!live.current) return
      if ('matches' in result) {
        setCheck(result.matches.length > 0 ? { state: 'matches', matches: result.matches } : { state: 'none' })
      } else if (result.error === 'list') {
        setCheck({
          state: 'failed',
          text: 'Couldn’t list the repo’s issues, so Claude had nothing to compare against.',
          detail: ghReady ? 'gh issue list' : 'api.github.com',
        })
      } else if (result.error === 'ask') {
        setCheck({ state: 'failed', text: 'Couldn’t ask Claude.', detail: 'the model call failed or took too long' })
      } else if (result.error === 'reply') {
        setCheck({ state: 'failed', text: 'Couldn’t read Claude’s answer.', detail: 'the reply wasn’t a list of issue numbers' })
      } else {
        setCheck({ state: 'failed', text: 'Couldn’t ask Claude.', detail: '' })
      }
    } catch (err) {
      if (!live.current) return
      setCheck({ state: 'failed', text: 'Couldn’t ask Claude.', detail: err instanceof Error ? err.message : '' })
    }
  }

  const checkOff = checking || !title
  const checkLabel = checking ? 'Checking…' : check.state === 'idle' ? 'Check with Claude' : 'Check again'

  return (
    <div className="box-border flex w-[300px] flex-none flex-col gap-3 border-l border-line/8 bg-shade/22 pb-[18px] pl-5 pr-[22px] pt-4">
      <div className="flex items-baseline gap-2">
        <span className={MONO_LABEL}>SIMILAR ISSUES</span>
        <span className="flex-1" />
        {autoOn && searchable && (
          <span className="font-mono fs-10 text-ink-900/60">
            by title · {ghReady ? 'gh' : 'api.github.com'}
          </span>
        )}
      </div>
      {!autoOn && (
        <div className="orbital-arrive fs-12 leading-normal text-pretty text-ink-900/60">
          Type a title and issues with similar titles show up here.
        </div>
      )}
      {autoOn && list.length > 0 && (
        <ul aria-label="Similar issues" className="flex flex-col">
          {list.map((issue) => (
            <li key={issue.number} className="orbital-arrive">
              <IssueLink
                issue={issue}
                className="-mx-2 flex items-baseline gap-2 rounded-[7px] p-2 text-inherit no-underline transition-colors hover:bg-line/6"
              >
                <span className="flex-none font-mono fs-11 text-ink-400/85">#{issue.number}</span>
                <span className="min-w-0 flex-1 fs-12.5 leading-[1.4] text-pretty text-ink-400/90">
                  {issue.title}
                </span>
                <StateTag state={issue.state} />
              </IssueLink>
            </li>
          ))}
        </ul>
      )}

      {checkEnabled && (
        <>
        <div className="flex items-center gap-1.5 border-t border-line/8 pt-3">
          <span className={MONO_LABEL}>CLAUDE</span>
          <span className="flex-1" />
          {model && (
            <Select
              variant="chip"
              aria-label="Model for the check"
              options={models.map((m) => ({ value: m.value, label: m.name, sub: m.desc || undefined }))}
              value={model.value}
              onChange={pickModel}
              disabled={checking}
              footer="uses your plan · kept for next time"
            />
          )}
          <Button variant="pill" size="pill" onClick={() => void runCheck()} disabled={checkOff}>
            {checkLabel}
          </Button>
        </div>

        <div key={check.state} className="orbital-arrive">
          {check.state === 'idle' && (
            <div className="fs-12 leading-normal text-pretty text-ink-900/60">
              Reads your draft next to the repo's open and closed issues and says which look like the same thing. Runs{' '}
              <span className="font-mono fs-11">claude -p</span> on the model you pick.
            </div>
          )}
          {check.state === 'checking' && (
            <div className="flex flex-col gap-[5px]">
              <div className="fs-12.5 leading-normal text-ink-400/90">
                {modelName} is reading your draft and {CHECKED_ISSUES} recent issues.
              </div>
              <div className="font-mono fs-10 leading-normal text-ink-900/50">
                usually under a minute · keep editing or send
              </div>
            </div>
          )}
          {check.state === 'matches' && (
            <div className="flex flex-col gap-0.5">
              <span className="pb-1 font-mono fs-10 text-ink-900/55">
                {check.matches.length === 1 ? '1 looks like the same issue' : `${check.matches.length} look like the same issue`}
              </span>
              <ul aria-label="Issues Claude matched" className="flex flex-col gap-0.5">
                {check.matches.map((issue) => (
                  <li key={issue.number}>
                    <IssueLink
                      issue={issue}
                      className="-mx-2 flex flex-col gap-1 rounded-[7px] p-2 text-inherit no-underline transition-colors hover:bg-line/6"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="flex-none font-mono fs-11 text-ink-100">#{issue.number}</span>
                        <span className="min-w-0 flex-1 fs-12.5 font-semibold leading-[1.4] text-pretty text-ink-100">
                          {issue.title}
                        </span>
                        <StateTag state={issue.state} />
                      </span>
                      <span className="fs-12 leading-[1.45] text-pretty text-ink-800/75">{issue.why}</span>
                    </IssueLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {check.state === 'none' && (
            <div className="fs-12.5 leading-normal text-pretty text-ink-400/90">
              Nothing looks like the same issue.
            </div>
          )}
          {check.state === 'failed' && (
            <div className="flex flex-col gap-1.5">
              <div className="fs-12.5 leading-normal text-pretty text-ink-400/90">{check.text}</div>
              {check.detail && (
                <div className="whitespace-pre-wrap font-mono fs-10 leading-[1.55] text-ink-900/55">
                  {check.detail}
                </div>
              )}
            </div>
          )}
        </div>
        </>
      )}

      <span className="flex-1" />
      {checkEnabled && (
        <div className="font-mono fs-10 leading-[1.55] text-ink-900/60">matches never block sending</div>
      )}
    </div>
  )
}
