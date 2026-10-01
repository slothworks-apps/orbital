import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useOrbital } from '../store/store'
import { useMcpUi } from '../store/mcp'
import { api, ApiError } from '../lib/api'
import { reportError } from '../lib/errors'
import {
  MCP_REFRESH_MS,
  blankKvRow,
  emptyMcpForm,
  hasMcpFormErrors,
  hasOwnServers,
  isCliMissing,
  isMcpFormDirty,
  isMcpLoginable,
  isSessionNotRunning,
  mcpFailure,
  mcpFormFromDefinition,
  mcpLoginFocus,
  mcpRequestBody,
  mcpRowLabels,
  mcpStatusKind,
  mcpStatusLabel,
  settleMcpLoginWaits,
  shouldRefreshMcpList,
  startMcpLoginWait,
  startingCount,
  validateMcpForm,
} from '../lib/mcp'
import type { McpForm, McpFormErrors, McpKvRow, McpLoginWaits, McpStatusKind } from '../lib/mcp'
import type { McpScope, McpServerRow, McpTransport } from '../lib/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Toggle } from '../ui/Checkbox'

/*
 * The MCP dialog (spec 2026-10-01-mcp-servers-in-the-session-design; canvas
 * `Feature - MCP dialog` 12a–12d). Opened by `/mcp` in the composer, for one
 * running Orbital session: its servers, what each can do, and an add/edit form
 * that replaces the list inside the same dialog.
 *
 * Red here is the error log's — oklch(60% .2 25) → #de3b3d — and its inks:
 * oklch(85% .1 25) → #ffb4ad, oklch(82% .1 25) → #ffaba3 (field errors).
 */

/**
 * Mounts the dialog for whichever session `/mcp` opened it for. The panel is
 * keyed on the open, so every open starts from a fresh fetch; the last
 * session is kept after a close so the content stays through the exit
 * transition.
 */
export function McpDialog() {
  const sessionId = useMcpUi((s) => s.sessionId)
  const seq = useMcpUi((s) => s.seq)
  const close = useMcpUi((s) => s.close)
  const [shownId, setShownId] = useState<string | null>(null)
  if (sessionId !== null && sessionId !== shownId) setShownId(sessionId)
  if (shownId === null) return null
  return <McpPanel key={seq} sessionId={shownId} open={sessionId !== null} onClose={close} />
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; servers: McpServerRow[] }
  | { kind: 'error'; detail: string }
  | { kind: 'asleep' }

interface DialogParts {
  title: string
  eyebrow: ReactNode
  headerMeta?: ReactNode
  aboveFooter?: ReactNode
  footerLead?: ReactNode
  footer?: ReactNode
  body: ReactNode
}

type Refusal = { cli: boolean; command: string | null; message: string }

interface FormState {
  mode: 'add' | 'edit'
  /** The server being edited: its key, the name it shows and the config it lives in. */
  original: { name: string; label: string; origin: string } | null
  /** Null until an edit's definition has been read. */
  initial: McpForm | null
  form: McpForm | null
  loadError: string | null
  errors: McpFormErrors
  refusal: Refusal | null
  saving: boolean
  /** The one env/header row whose value is shown; every other stays masked. */
  revealed: number | null
  confirmRemove: boolean
  /** Where a dirty form was about to go when it stopped to ask. */
  confirmDiscard: 'list' | 'close' | null
}

const MONO_LABEL = 'font-mono text-[10px] tracking-[0.16em] text-[rgba(160,190,225,.6)]'

function McpPanel({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string
  open: boolean
  onClose: () => void
}) {
  const session = useOrbital((s) => s.sessions[sessionId])
  const decisionPending = useOrbital((s) => s.pendingDecisions[sessionId] != null)
  const ended = session?.status === 'ended'
  const title = session?.title || 'Untitled session'

  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [cliMissing, setCliMissing] = useState(false)
  const [formState, setFormState] = useState<FormState | null>(null)
  /** Rows whose login page is open in the browser (spec § Log in). */
  const [loginWaits, setLoginWaits] = useState<McpLoginWaits>({})
  /** A login that could not be started, by row: the server's message. */
  const [loginErrors, setLoginErrors] = useState<Record<string, string>>({})

  // Every request takes a number; a response older than one already shown is
  // dropped, so a slow refresh cannot undo what an action just answered.
  const requested = useRef(0)
  const applied = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const accept = useCallback((id: number, servers: McpServerRow[]) => {
    if (!alive.current || id < applied.current) return
    applied.current = id
    setList({ kind: 'ready', servers })
  }, [])

  const load = useCallback(async () => {
    const id = ++requested.current
    try {
      const { servers } = await api.mcpServers(sessionId)
      accept(id, servers)
    } catch (err) {
      if (!alive.current || id < applied.current) return
      applied.current = id
      if (isSessionNotRunning(err)) {
        setList({ kind: 'asleep' })
        return
      }
      const failure = mcpFailure(err)
      const status = failure.status === null ? '' : ` → ${failure.status}`
      setList({
        kind: 'error',
        detail: `GET /api/sessions/${sessionId}/mcp${status}\n${failure.message}`,
      })
    }
  }, [sessionId, accept])

  // An ended session has no process and `/mcp` does not start one.
  useEffect(() => {
    if (!ended) void load()
  }, [ended, load])

  // A login stops waiting once its row leaves needs-auth (or is gone), and
  // every wait ends with the dialog.
  const listServers = list.kind === 'ready' ? list.servers : null
  useEffect(() => {
    if (!open) setLoginWaits({})
    else if (listServers) setLoginWaits((w) => settleMcpLoginWaits(w, listServers))
  }, [open, listServers])

  // The CLI pushes no status change, so a starting server — or a login being
  // finished in the browser — is pulled again every MCP_REFRESH_MS, only while
  // the dialog is open. Keyed on the list, so each answer arms the next pull.
  const starting = listServers ? startingCount(listServers) : 0
  const refresh = listServers !== null && shouldRefreshMcpList(listServers, loginWaits)
  useEffect(() => {
    if (!open || !refresh) return
    const timer = setTimeout(() => void load(), MCP_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [open, refresh, list, load])

  /** A failed action: the CLI missing turns add/edit/remove off; anything else is a toast and an error-log entry. */
  const actionFailed = useCallback((err: unknown, what: string) => {
    if (!alive.current) return
    if (isCliMissing(err)) {
      setCliMissing(true)
      return
    }
    if (isSessionNotRunning(err)) {
      setList({ kind: 'asleep' })
      return
    }
    const failure = mcpFailure(err)
    const message = [`${what}: ${failure.message}`, failure.command].filter(Boolean).join('\n')
    reportError(err instanceof ApiError ? new ApiError(message, err.status, err.url) : err, what)
  }, [])

  const runRowAction = useCallback(
    async (
      name: string,
      label: string,
      what: string,
      call: () => Promise<{ servers: McpServerRow[]; restartNeeded?: boolean }>,
    ) => {
      setBusy((b) => ({ ...b, [name]: label }))
      setConfirmRemove(null)
      const id = ++requested.current
      try {
        const result = await call()
        accept(id, result.servers)
        if (result.restartNeeded && alive.current) setRestartNeeded(true)
      } catch (err) {
        actionFailed(err, what)
      } finally {
        if (alive.current) {
          setBusy((b) => {
            const next = { ...b }
            delete next[name]
            return next
          })
        }
      }
    },
    [accept, actionFailed],
  )

  const reconnectByName = useCallback(
    (name: string) =>
      void runRowAction(name, 'reconnecting…', `Couldn't reconnect ${name}`, () =>
        api.reconnectMcpServer(sessionId, name),
      ),
    [runRowAction, sessionId],
  )
  const reconnect = (row: McpServerRow) => reconnectByName(row.name)

  // Back from the browser: a row that still needs a login is reconnected once
  // per attempt — the CLI may not connect it by itself after the callback.
  useEffect(() => {
    if (!open || !listServers || Object.keys(loginWaits).length === 0) return
    const onFocus = () => {
      const { reconnect: names, waits } = mcpLoginFocus(loginWaits, listServers)
      if (names.length === 0) return
      setLoginWaits(waits)
      for (const name of names) reconnectByName(name)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open, listServers, loginWaits, reconnectByName])

  const logIn = async (row: McpServerRow) => {
    const name = row.name
    setBusy((b) => ({ ...b, [name]: 'opening login…' }))
    setConfirmRemove(null)
    setLoginErrors((e) => {
      if (!(name in e)) return e
      const next = { ...e }
      delete next[name]
      return next
    })
    try {
      const { authUrl } = await api.mcpLogin(sessionId, name)
      if (!alive.current) return
      // The desktop app hands a new window's URL to the system browser.
      window.open(authUrl, '_blank', 'noopener')
      setLoginWaits((w) => startMcpLoginWait(w, name))
    } catch (err) {
      if (!alive.current) return
      if (isSessionNotRunning(err)) {
        actionFailed(err, `Couldn't log in to ${name}`)
        return
      }
      setLoginErrors((e) => ({ ...e, [name]: mcpFailure(err).message }))
    } finally {
      if (alive.current) {
        setBusy((b) => {
          const next = { ...b }
          delete next[name]
          return next
        })
      }
    }
  }
  const toggle = (row: McpServerRow, enabled: boolean) =>
    void runRowAction(
      row.name,
      enabled ? 'switching on…' : 'switching off…',
      `Couldn't switch ${row.name} ${enabled ? 'on' : 'off'}`,
      () => api.setMcpServerEnabled(sessionId, row.name, enabled),
    )
  const remove = (name: string) =>
    void runRowAction(name, 'removing…', `Couldn't remove ${name}`, () =>
      api.removeMcpServer(sessionId, name),
    )

  const restartBlocked = session?.status === 'working' || decisionPending
  const restart = async () => {
    if (restarting || restartBlocked) return
    setRestarting(true)
    const id = ++requested.current
    try {
      const { servers } = await api.restartMcpSession(sessionId)
      accept(id, servers)
      if (alive.current) setRestartNeeded(false)
    } catch (err) {
      // 409 here is a turn or a decision that arrived since the click, not a
      // session without a process — so a toast, never the asleep note.
      const failure = mcpFailure(err)
      reportError(
        err instanceof ApiError
          ? new ApiError(`Couldn't restart the session: ${failure.message}`, err.status, err.url)
          : err,
        "Couldn't restart the session",
      )
    } finally {
      if (alive.current) setRestarting(false)
    }
  }

  // ---- the form ----------------------------------------------------------

  const blankForm = (patch: Partial<FormState>): FormState => ({
    mode: 'add',
    original: null,
    initial: null,
    form: null,
    loadError: null,
    errors: {},
    refusal: null,
    saving: false,
    revealed: null,
    confirmRemove: false,
    confirmDiscard: null,
    ...patch,
  })

  const openAdd = () => {
    setConfirmRemove(null)
    setFormState(blankForm({ initial: emptyMcpForm(), form: emptyMcpForm() }))
  }

  const openEdit = (row: McpServerRow) => {
    const labels = mcpRowLabels(row)
    setConfirmRemove(null)
    setFormState(
      blankForm({
        mode: 'edit',
        original: { name: row.name, label: labels.name, origin: labels.origin ?? 'its' },
      }),
    )
    api.mcpServerConfig(sessionId, row.name).then(
      (definition) => {
        const form = mcpFormFromDefinition(definition)
        setFormState((fs) =>
          fs?.original?.name === row.name ? { ...fs, initial: form, form } : fs,
        )
      },
      (err: unknown) => {
        setFormState((fs) =>
          fs?.original?.name === row.name ? { ...fs, loadError: mcpFailure(err).message } : fs,
        )
      },
    )
  }

  const patchForm = (patch: Partial<McpForm>) =>
    setFormState((fs) => {
      if (!fs?.form) return fs
      // A field being edited drops its own error; the rest wait for the next Save.
      const errors = { ...fs.errors }
      for (const key of Object.keys(patch)) delete errors[key as keyof McpFormErrors]
      return { ...fs, form: { ...fs.form, ...patch }, errors, confirmDiscard: null }
    })

  const leaveForm = (target: 'list' | 'close', force = false) => {
    const fs = formState
    if (!fs) return
    if (fs.confirmDiscard && !force) {
      // Esc while asking is "keep editing".
      setFormState({ ...fs, confirmDiscard: null })
      return
    }
    if (!force && !fs.saving && fs.form && fs.initial && isMcpFormDirty(fs.form, fs.initial)) {
      setFormState({ ...fs, confirmDiscard: target, confirmRemove: false })
      return
    }
    setFormState(null)
    if (target === 'close') onClose()
  }

  const save = async () => {
    const fs = formState
    if (!fs?.form || fs.saving) return
    const errors = validateMcpForm(fs.form)
    if (hasMcpFormErrors(errors)) {
      setFormState({ ...fs, errors, refusal: null })
      return
    }
    setFormState({
      ...fs,
      errors: {},
      refusal: null,
      saving: true,
      confirmDiscard: null,
      confirmRemove: false,
    })
    const body = mcpRequestBody(fs.form)
    const id = ++requested.current
    try {
      const result =
        fs.mode === 'edit' && fs.original
          ? await api.updateMcpServer(sessionId, fs.original.name, body)
          : await api.addMcpServer(sessionId, body)
      accept(id, result.servers)
      if (!alive.current) return
      if (result.restartNeeded) setRestartNeeded(true)
      setFormState(null)
    } catch (err) {
      if (!alive.current) return
      if (isCliMissing(err)) setCliMissing(true)
      const failure = mcpFailure(err)
      // The form stays filled whatever the refusal; only `cli_refused` is the CLI's own.
      setFormState((current) =>
        current
          ? {
              ...current,
              saving: false,
              refusal: isCliMissing(err)
                ? null
                : {
                    cli: failure.code === 'cli_refused',
                    command: failure.command,
                    message: failure.message,
                  },
            }
          : current,
      )
    }
  }

  const removeFromForm = () => {
    const name = formState?.original?.name
    if (!name) return
    setFormState(null)
    remove(name)
  }

  // ---- render --------------------------------------------------------------

  const eyebrowText = `MCP · ${title.toUpperCase()}`
  const handleClose = formState ? () => leaveForm('close') : onClose

  /** The list and every state it can be in (canvas 12a, 12c). */
  function listParts(): DialogParts {
    const servers = list.kind === 'ready' ? list.servers : []
    const ready = list.kind === 'ready' && !ended

    let headerMeta: ReactNode = undefined
    if (!ended && list.kind === 'loading') {
      headerMeta = <Working label="asking the session…" />
    } else if (ready) {
      headerMeta = (
        <span className="flex items-center gap-3">
          {starting > 0 && (
            <Working label={`${starting} starting · refreshing every ${MCP_REFRESH_MS / 1000} s`} />
          )}
          <span>
            {servers.length} {servers.length === 1 ? 'server' : 'servers'}
          </span>
        </span>
      )
    }

    return {
      title: 'Servers',
      eyebrow: eyebrowText,
      headerMeta,
      aboveFooter:
        ready && restartNeeded ? (
          <div className="flex items-center gap-3 rounded-[9px] border border-accent/35 bg-accent/6 py-2.5 pl-3.5 pr-3">
            <span className="flex-1 text-[12.5px] leading-[1.45] text-text-bright">
              {restarting
                ? 'Restarting the session…'
                : 'Changes apply after the session restarts. The transcript is kept.'}
            </span>
            <Button
              variant="pill-active"
              size="pill"
              disabled={restarting || restartBlocked}
              title={
                restartBlocked && !restarting
                  ? 'Waits until the turn is over and nothing asks for you.'
                  : undefined
              }
              onClick={() => void restart()}
            >
              {restarting ? 'Restarting…' : 'Restart session'}
            </Button>
          </div>
        ) : undefined,
      footerLead: ready ? (
        <>
          <Button variant="primary" size="sm" disabled={cliMissing} onClick={openAdd}>
            + Add server
          </Button>
          {cliMissing && (
            <span className="text-xs leading-[1.45] text-[rgba(160,190,225,.8)] text-pretty">
              <span className="font-mono text-[11.5px] text-text-bright">claude</span> isn't on PATH
              — adding, editing and removing need the CLI.
            </span>
          )}
        </>
      ) : undefined,
      footer:
        ready && !cliMissing ? (
          <span className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.45)]">
            via claude mcp · session {title}
          </span>
        ) : undefined,
      body: ended ? (
        <Note label="ENDED">This session has ended. Continue it to see its servers.</Note>
      ) : list.kind === 'asleep' ? (
        <Note label="ASLEEP">This session is asleep. Wake it to see its servers.</Note>
      ) : list.kind === 'loading' ? (
        <Skeleton />
      ) : list.kind === 'error' ? (
        <div className="flex flex-col items-start gap-3 pb-1">
          <div className="flex items-center gap-2.5 text-sm font-semibold">
            <span
              aria-hidden
              className="h-[7px] w-[7px] rounded-full bg-[#de3b3d] shadow-[0_0_8px_rgba(222,59,61,.7)]"
            />
            Couldn't read this session's servers.
          </div>
          <pre className="self-stretch whitespace-pre-wrap rounded-[7px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(190,212,238,.8)] [overflow-wrap:anywhere]">
            {list.detail}
          </pre>
          <Button
            variant="pill-active"
            size="pill"
            onClick={() => {
              setList({ kind: 'loading' })
              void load()
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          {/* Above the list in every state that shows switches — before the
              first click, not after (adr the-mcp-toggle-is-project-wide). */}
          {hasOwnServers(servers) && (
            <div className="mb-1.5 flex items-start gap-2.5 rounded-lg border border-[rgba(150,205,255,.12)] bg-[rgba(150,205,255,.04)] px-3 py-[9px] text-xs leading-[1.45] text-[rgba(200,214,235,.85)] text-pretty">
              <span className="flex-none pt-0.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
                ON / OFF
              </span>
              <span>
                Switching a server holds for this{' '}
                <b className="font-semibold text-text-bright">whole project</b> — every session
                here, terminal ones included — until you switch it back.
              </span>
            </div>
          )}
          <ul aria-label="MCP servers" className="-mx-[14px] flex flex-col pt-1">
            {servers.map((row) => (
              <ServerRow
                key={row.name}
                row={row}
                busy={busy[row.name]}
                waiting={row.name in loginWaits}
                loginError={loginErrors[row.name]}
                confirming={confirmRemove === row.name}
                canEdit={row.editable && !cliMissing}
                onReconnect={() => reconnect(row)}
                onLogIn={() => void logIn(row)}
                onToggle={(enabled) => toggle(row, enabled)}
                onEdit={() => openEdit(row)}
                onAskRemove={() => setConfirmRemove(row.name)}
                onKeep={() => setConfirmRemove(null)}
                onRemove={() => remove(row.name)}
              />
            ))}
          </ul>
          {!hasOwnServers(servers) && (
            <p className="pt-[26px] text-[13px] leading-normal text-[rgba(200,214,235,.85)] text-pretty">
              No servers of your own yet. Add one for this project or for all your projects.
            </p>
          )}
        </>
      ),
    }
  }

  // One Dialog for both views, so going to the form and back swaps its
  // content instead of playing the open transition again.
  const parts = formState
    ? formViewParts({
        state: formState,
        cliMissing,
        onBack: () => leaveForm('list'),
        onDiscard: () => leaveForm(formState.confirmDiscard ?? 'list', true),
        onKeepEditing: () => setFormState({ ...formState, confirmDiscard: null }),
        onPatch: patchForm,
        onState: (patch) => setFormState({ ...formState, ...patch }),
        onSave: () => void save(),
        onRemove: removeFromForm,
      })
    : listParts()

  return (
    <Dialog
      open={open}
      size="xl"
      onClose={handleClose}
      title={parts.title}
      eyebrow={parts.eyebrow}
      headerMeta={parts.headerMeta}
      aboveFooter={parts.aboveFooter}
      footerLead={parts.footerLead}
      footer={parts.footer}
    >
      {parts.body}
    </Dialog>
  )
}

/** The mono "something is on its way" line with the 9px spinner (canvas 12a/12c). */
function Working({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-[7px] text-[rgba(160,190,225,.6)]">
      <span
        aria-hidden
        className="orbital-spin box-border block h-[9px] w-[9px] flex-none rounded-full border-[1.5px] border-[rgba(220,235,255,.75)] border-t-transparent"
      />
      {label}
    </span>
  )
}

/** Asleep and ended: a note, nothing else (canvas 12c, SESSION ASLEEP). */
function Note({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 pb-2.5">
      <div className={MONO_LABEL}>{label}</div>
      <div className="text-sm leading-normal text-text-bright text-pretty">{children}</div>
    </div>
  )
}

/** The first fetch: skeleton rows, no actions (canvas 12c, LOADING). */
function Skeleton() {
  const widths = [
    [140, 220],
    [200, 160],
    [110, 240],
  ]
  return (
    <div aria-hidden className="-mx-[14px] flex flex-col">
      {widths.map(([name, meta], i) => (
        <div
          key={i}
          className="orbital-skel flex items-center gap-3 border-b border-[rgba(150,205,255,.07)] p-3.5 last:border-b-0"
          style={{ animationDelay: `${i * 0.2}s` }}
        >
          <span className="block h-[7px] w-[7px] rounded-full bg-[rgba(150,205,255,.2)]" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span
              className="block h-2.5 rounded-[3px] bg-[rgba(150,205,255,.12)]"
              style={{ width: name }}
            />
            <span
              className="block h-[7px] rounded-[3px] bg-[rgba(150,205,255,.08)]"
              style={{ width: meta }}
            />
          </span>
          <span className="block h-[18px] w-8 rounded-full bg-[rgba(150,205,255,.08)]" />
        </div>
      ))}
    </div>
  )
}

/** The status mark before a row's name (canvas 12d, STATUS · NEUTRAL, ONE RED). */
function StatusMark({ kind }: { kind: McpStatusKind }) {
  switch (kind) {
    case 'connected':
      return (
        <span className="block h-[7px] w-[7px] rounded-full bg-[rgba(225,238,255,.92)] shadow-[0_0_7px_rgba(225,238,255,.45)]" />
      )
    case 'failed':
      return (
        <span className="block h-[7px] w-[7px] rounded-full bg-[#de3b3d] shadow-[0_0_8px_rgba(222,59,61,.7)]" />
      )
    case 'starting':
      return (
        <span className="orbital-spin box-border block h-[9px] w-[9px] rounded-full border-[1.5px] border-[rgba(225,238,255,.8)] border-t-transparent" />
      )
    case 'off':
      return (
        <span className="mt-[3px] block h-[1.5px] w-2 rounded-[1px] bg-[rgba(160,190,225,.5)]" />
      )
    // Needs login, and a status a newer CLI sends: a hollow ring.
    default:
      return (
        <span className="box-border block h-[7px] w-[7px] rounded-full border-[1.5px] border-[rgba(225,238,255,.75)]" />
      )
  }
}

interface ServerRowProps {
  row: McpServerRow
  busy: string | undefined
  /** Its login page is open in the browser (spec § Log in). */
  waiting: boolean
  /** Why the login could not be started — the server's message. */
  loginError: string | undefined
  confirming: boolean
  canEdit: boolean
  onReconnect(): void
  onLogIn(): void
  onToggle(enabled: boolean): void
  onEdit(): void
  onAskRemove(): void
  onKeep(): void
  onRemove(): void
}

/** One server (canvas 12a): the full name wraps, never truncates; a failed one carries its error verbatim. */
function ServerRow({
  row,
  busy,
  waiting,
  loginError,
  confirming,
  canEdit,
  onReconnect,
  onLogIn,
  onToggle,
  onEdit,
  onAskRemove,
  onKeep,
  onRemove,
}: ServerRowProps) {
  const kind = mcpStatusKind(row.status)
  const { name, origin } = mcpRowLabels(row)
  const on = kind !== 'off'
  const loginable = isMcpLoginable(row)
  // Waiting reads like an action in flight but does not lock the toggle: a
  // login abandoned in the browser must not freeze the row until the dialog closes.
  const activity = busy ?? (waiting ? 'waiting for the browser…' : undefined)
  const separator = (
    <span aria-hidden className="text-[rgba(150,205,255,.28)]">
      ·
    </span>
  )
  const statusInk =
    kind === 'failed'
      ? 'text-[#ffb4ad]'
      : kind === 'off'
        ? 'text-[rgba(160,190,225,.55)]'
        : 'text-[rgba(220,235,255,.85)]'

  return (
    <li className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-b border-[rgba(150,205,255,.07)] px-3.5 py-3">
      <div aria-hidden className="flex justify-center pt-[5px]">
        <StatusMark kind={kind} />
      </div>
      <div className="flex min-w-0 flex-col gap-[5px]">
        <div
          className={[
            'text-[13.5px] font-semibold leading-[1.35] [overflow-wrap:anywhere]',
            kind === 'off' ? 'text-[rgba(220,235,255,.6)]' : 'text-text-bright',
          ].join(' ')}
        >
          {name}
        </div>
        <div className="flex flex-wrap items-center gap-[7px] font-mono text-[10px] tracking-[0.1em] text-[rgba(160,190,225,.7)]">
          <span className={statusInk}>{mcpStatusLabel(row.status)}</span>
          {origin && (
            <>
              {separator}
              <span className="rounded border border-[rgba(150,205,255,.18)] px-1.5 py-px tracking-[0.06em] text-[rgba(200,220,245,.75)]">
                {origin}
              </span>
            </>
          )}
          {kind === 'connected' && row.toolCount != null && (
            <>
              {separator}
              <span>
                {row.toolCount} {row.toolCount === 1 ? 'tool' : 'tools'}
              </span>
            </>
          )}
        </div>
        {kind === 'login' && !loginable && (
          <div className="text-xs leading-[1.45] text-[rgba(160,190,225,.75)] text-pretty">
            A claude.ai connector — it is logged in on claude.ai, in its connector settings, not
            here.
          </div>
        )}
        {loginable && loginError && (
          <div className="text-xs leading-[1.45] text-[rgba(160,190,225,.75)] text-pretty">
            Log in from a terminal session in this project — Orbital couldn't open the login flow.
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 pt-px">
        {activity ? (
          <span className="font-mono text-[10px] tracking-[0.08em] text-[rgba(160,190,225,.7)]">
            <Working label={activity} />
          </span>
        ) : confirming ? (
          <>
            <span className="text-xs text-[rgba(220,235,255,.85)]">
              Remove from {origin ?? 'its'} config?
            </span>
            <Button variant="pill" size="pill" onClick={onKeep}>
              Keep
            </Button>
            <Button variant="pill-danger" size="pill" onClick={onRemove}>
              Remove
            </Button>
          </>
        ) : (
          <>
            {kind === 'failed' && (
              <Button variant="pill-active" size="pill" onClick={onReconnect}>
                Reconnect
              </Button>
            )}
            {loginable && (
              <Button variant="pill-active" size="pill" onClick={onLogIn}>
                Log in
              </Button>
            )}
            {canEdit && (
              <>
                <Button variant="pill" size="pill" onClick={onEdit}>
                  Edit
                </Button>
                <Button variant="pill" size="pill" onClick={onAskRemove}>
                  Remove
                </Button>
              </>
            )}
          </>
        )}
        <span aria-hidden className="block w-1" />
        {row.toggleable ? (
          <Toggle
            checked={on}
            disabled={Boolean(busy)}
            onChange={onToggle}
            aria-label={
              on ? `Turn ${name} off for this project` : `Turn ${name} on for this project`
            }
          />
        ) : (
          <span className="block w-8 text-center font-mono text-[9px] tracking-[0.12em] text-[rgba(160,190,225,.45)]">
            —
          </span>
        )}
      </div>
      {kind === 'failed' && row.error && (
        <pre className="col-start-2 col-end-4 max-h-[120px] overflow-auto whitespace-pre-wrap rounded-[7px] border border-[#de3b3d]/28 bg-[rgba(4,8,16,.55)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(214,222,238,.85)] [overflow-wrap:anywhere]">
          {row.error}
        </pre>
      )}
      {loginable && loginError && (
        <pre className="col-start-2 col-end-4 max-h-[120px] overflow-auto whitespace-pre-wrap rounded-[7px] border border-[#de3b3d]/28 bg-[rgba(4,8,16,.55)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(214,222,238,.85)] [overflow-wrap:anywhere]">
          {loginError}
        </pre>
      )}
    </li>
  )
}

// ---- the form view -----------------------------------------------------------

interface McpFormViewProps {
  state: FormState
  cliMissing: boolean
  onBack(): void
  onDiscard(): void
  onKeepEditing(): void
  onPatch(patch: Partial<McpForm>): void
  onState(patch: Partial<FormState>): void
  onSave(): void
  onRemove(): void
}

const SCOPES: { value: McpScope; label: string; sub: string }[] = [
  { value: 'local', label: 'This project, only me', sub: 'local · default' },
  { value: 'user', label: 'All my projects', sub: 'user' },
]

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse']

/** Add and edit (canvas 12a's form, 12b): replaces the list inside the same dialog. */
function formViewParts({
  state,
  cliMissing,
  onBack,
  onDiscard,
  onKeepEditing,
  onPatch,
  onState,
  onSave,
  onRemove,
}: McpFormViewProps): DialogParts {
  const { form, errors } = state
  const title = state.mode === 'add' ? 'Add server' : `Edit ${state.original?.label ?? ''}`
  const kvKey = form?.transport === 'stdio' ? 'env' : 'headers'

  const setRows = (rows: McpKvRow[], revealed: number | null = state.revealed) => {
    onState({ form: form ? { ...form, [kvKey]: rows } : form, revealed, confirmDiscard: null })
  }

  let lead: ReactNode = undefined
  if (state.confirmDiscard) {
    lead = (
      <>
        <span className="text-xs text-[rgba(220,235,255,.85)]">Discard your changes?</span>
        <Button variant="pill" size="pill" onClick={onKeepEditing}>
          Keep editing
        </Button>
        <Button variant="pill-danger" size="pill" onClick={onDiscard}>
          Discard
        </Button>
      </>
    )
  } else if (state.mode === 'edit' && form && !cliMissing) {
    lead = state.confirmRemove ? (
      <>
        <span className="text-xs text-[rgba(220,235,255,.85)] [overflow-wrap:anywhere]">
          Remove {state.original?.label} from {state.original?.origin} config?
        </span>
        <Button variant="pill" size="pill" onClick={() => onState({ confirmRemove: false })}>
          Keep
        </Button>
        <Button variant="pill-danger" size="pill" onClick={onRemove}>
          Remove
        </Button>
      </>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        disabled={state.saving}
        onClick={() => onState({ confirmRemove: true })}
      >
        Remove server
      </Button>
    )
  }

  let aboveFooter: ReactNode = undefined
  if (cliMissing) {
    aboveFooter = (
      <p className="text-xs leading-[1.45] text-[rgba(160,190,225,.8)] text-pretty">
        <span className="font-mono text-[11.5px] text-text-bright">claude</span> isn't on PATH —
        adding, editing and removing need the CLI.
      </p>
    )
  } else if (state.refusal) {
    aboveFooter = (
      <div
        role="alert"
        className="flex flex-col gap-1.5 rounded-lg border border-[#de3b3d]/45 bg-[#de3b3d]/7 px-3 py-2.5"
      >
        <div className="flex items-center gap-2 font-mono text-[9.5px] tracking-[0.14em] text-[#ffb4ad]">
          <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-[#de3b3d]" />
          {state.refusal.cli ? 'CLI REFUSED · NOTHING WAS SAVED' : 'NOTHING WAS SAVED'}
        </div>
        <pre className="max-h-[140px] overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(222,230,244,.9)] [overflow-wrap:anywhere]">
          {[state.refusal.command, state.refusal.message].filter(Boolean).join('\n')}
        </pre>
      </div>
    )
  }

  return {
    title,
    eyebrow: (
      <button
        type="button"
        onClick={onBack}
        className="font-mono text-[10px] tracking-[0.2em] text-[#8fd8ff] transition-colors hover:text-[#c6ecff]"
      >
        ← SERVERS
      </button>
    ),
    aboveFooter,
    footerLead: lead,
    footer: (
      <>
        {state.saving && (
          <span className="font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.45)]">
            running claude mcp…
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!form || state.saving || cliMissing}
          onClick={onSave}
        >
          {state.saving ? 'Saving…' : 'Save'}
        </Button>
      </>
    ),
    body: state.loadError ? (
      <div className="flex flex-col items-start gap-3 pb-1">
        <div className="text-sm font-semibold">This server can't be edited here.</div>
        <pre className="self-stretch whitespace-pre-wrap rounded-[7px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.55)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(190,212,238,.8)] [overflow-wrap:anywhere]">
          {state.loadError}
        </pre>
      </div>
    ) : !form ? (
      <div className="font-mono text-[10.5px] tracking-[0.06em]">
        <Working label="reading the definition…" />
      </div>
    ) : (
      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-x-5 gap-y-[18px]">
        <div className={`pt-2.5 ${MONO_LABEL}`}>NAME</div>
        <Field error={errors.name}>
          <Input
            font="mono"
            size="sm"
            aria-label="Name"
            placeholder="e.g. github"
            value={form.name}
            invalid={Boolean(errors.name)}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </Field>

        <div className={`pt-2 ${MONO_LABEL}`}>SCOPE</div>
        <div role="group" aria-label="Scope" className="flex flex-wrap gap-2">
          {SCOPES.map((option) => {
            const active = form.scope === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => onPatch({ scope: option.value })}
                className={[
                  'flex flex-col items-start gap-0.5 rounded-[10px] border px-3.5 py-2 text-left transition-colors',
                  active
                    ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
                    : 'border-[rgba(150,205,255,.14)] text-[rgba(220,235,255,.8)] hover:border-[rgba(150,205,255,.3)]',
                ].join(' ')}
              >
                <span className="text-[12.5px] font-semibold">{option.label}</span>
                <span
                  className={[
                    'font-mono text-[9.5px] tracking-[0.08em]',
                    active ? 'text-[rgba(200,220,245,.7)]' : 'text-[rgba(160,190,225,.55)]',
                  ].join(' ')}
                >
                  {option.sub}
                </span>
              </button>
            )
          })}
        </div>

        <div className={`pt-1.5 ${MONO_LABEL}`}>TRANSPORT</div>
        <div role="group" aria-label="Transport" className="flex gap-1.5">
          {TRANSPORTS.map((transport) => {
            const active = form.transport === transport
            return (
              <button
                key={transport}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (active) return
                  // The other transport's fields and rows are a different
                  // set: their errors go, and nothing in them is revealed.
                  onState({
                    form: { ...form, transport },
                    revealed: null,
                    errors: {},
                    confirmDiscard: null,
                  })
                }}
                className={[
                  'rounded-full border px-3.5 py-[5px] font-mono text-[11.5px] transition-colors',
                  active
                    ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
                    : 'border-[rgba(150,205,255,.14)] text-[rgba(220,235,255,.75)] hover:border-[rgba(150,205,255,.3)]',
                ].join(' ')}
              >
                {transport}
              </button>
            )
          })}
        </div>

        {form.transport === 'stdio' ? (
          <>
            <div className={`pt-2.5 ${MONO_LABEL}`}>COMMAND</div>
            <Field error={errors.command}>
              <Input
                font="mono"
                size="sm"
                aria-label="Command"
                placeholder="npx"
                value={form.command}
                invalid={Boolean(errors.command)}
                onChange={(e) => onPatch({ command: e.target.value })}
              />
            </Field>
            <div className={`pt-2.5 ${MONO_LABEL}`}>ARGS</div>
            <Field error={errors.args}>
              <Input
                font="mono"
                size="sm"
                aria-label="Arguments"
                placeholder="-y @scope/server --flag value"
                value={form.args}
                invalid={Boolean(errors.args)}
                onChange={(e) => onPatch({ args: e.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <div className={`pt-2.5 ${MONO_LABEL}`}>URL</div>
            <Field error={errors.url}>
              <Input
                font="mono"
                size="sm"
                aria-label="URL"
                placeholder="https://mcp.example.com/mcp"
                value={form.url}
                invalid={Boolean(errors.url)}
                onChange={(e) => onPatch({ url: e.target.value })}
              />
            </Field>
          </>
        )}

        <div className={`pt-2.5 ${MONO_LABEL}`}>{kvKey === 'env' ? 'ENV' : 'HEADERS'}</div>
        <div className="flex flex-col gap-1.5">
          {form[kvKey].map((row, i) => {
            const shown = state.revealed === i
            return (
              <div
                key={i}
                className="grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)_52px_32px] items-center gap-1.5"
              >
                <Input
                  font="mono"
                  size="sm"
                  aria-label={kvKey === 'env' ? 'Variable name' : 'Header name'}
                  placeholder={kvKey === 'env' ? 'KEY' : 'Header-Name'}
                  value={row.key}
                  onChange={(e) =>
                    setRows(
                      form[kvKey].map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                    )
                  }
                />
                <Input
                  font="mono"
                  size="sm"
                  type={shown ? 'text' : 'password'}
                  autoComplete="off"
                  aria-label={kvKey === 'env' ? 'Variable value' : 'Header value'}
                  placeholder="secret value"
                  value={row.value}
                  onChange={(e) =>
                    setRows(
                      form[kvKey].map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                    )
                  }
                />
                <button
                  type="button"
                  aria-pressed={shown}
                  onClick={() => onState({ revealed: shown ? null : i })}
                  className={[
                    'h-8 w-[52px] rounded-lg border font-mono text-[10px] tracking-[0.06em] transition-colors',
                    shown
                      ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
                      : 'border-[rgba(150,205,255,.14)] text-[rgba(200,220,245,.75)] hover:border-[rgba(150,205,255,.3)]',
                  ].join(' ')}
                >
                  {shown ? 'hide' : 'show'}
                </button>
                <button
                  type="button"
                  aria-label="Remove row"
                  onClick={() => {
                    const rest = form[kvKey].filter((_, j) => j !== i)
                    setRows(rest.length > 0 ? rest : [blankKvRow()], null)
                  }}
                  className="h-8 w-8 rounded-lg border border-[rgba(150,205,255,.14)] text-sm text-[rgba(200,220,245,.6)] transition-colors hover:border-[rgba(150,205,255,.3)]"
                >
                  ×
                </button>
              </div>
            )
          })}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setRows([...form[kvKey], blankKvRow()])}
              className="py-1 font-mono text-[11px] text-[#8fd8ff] transition-colors hover:text-[#c6ecff]"
            >
              {kvKey === 'env' ? '+ Add variable' : '+ Add header'}
            </button>
            <span className="text-[11.5px] text-[rgba(160,190,225,.55)]">
              Values are masked — reveal one row at a time.
            </span>
          </div>
        </div>
      </div>
    ),
  }
}

function Field({ error, children }: { error: string | undefined; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {children}
      {error && <span className="text-[11.5px] text-[#ffaba3]">{error}</span>}
    </div>
  )
}
