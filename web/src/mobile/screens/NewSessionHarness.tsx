import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errorSentence } from '../../lib/api'
import type { HarnessLaunch, HarnessTemplate, LaunchHarnessTemplates } from '../../lib/types'
import { basename } from '../format'
import { RailMarker } from '../harness/StepsSheet'
import {
  harnessLaunch, harnessStartBlock, inputRequired, stepsSummary, templateMeta, templateSheetLines,
} from '../newSession'
import { registerSheet } from '../state'
import { BottomSheet, FieldLabel, MobileScreen, PrimaryButton, SheetPresence, Toggle } from '../ui'

/** The templates offered for one directory on one device, as the route answered. */
interface Offered {
  key: string
  data: LaunchHarnessTemplates | null
  error: string | null
}

export interface HarnessChoice {
  /** Null while the list is being read, or after it could not be. */
  data: LaunchHarnessTemplates | null
  error: string | null
  template: HarnessTemplate | null
  inputs: Record<string, string>
  setInput: (key: string, value: string) => void
  pick: (id: number) => void
  lucky: boolean
  /** Feeling lucky moved away from the template's default. */
  luckyChanged: boolean
  setLucky: (on: boolean) => void
  sheetOpen: boolean
  setSheetOpen: (open: boolean) => void
  /** Why Start cannot go yet, in the button's words; null when it can. */
  block: string | null
  /** What the launch carries; null while nothing can be launched. */
  launch: HarnessLaunch | null
}

/**
 * The harness screen's choice (spec 2026-11-09-harness-from-new-session-design
 * § Phone): the templates the Mac offers for `cwd`, read when the screen is
 * opened for a directory it has not read yet, then kept, with the pick, the
 * inputs and Feeling lucky, across ‹ and back. The latest template run in
 * the project is preselected; with none, the sheet opens by itself.
 */
export function useHarnessChoice(cwd: string, machine: string | null, active: boolean): HarnessChoice {
  const key = `${machine ?? ''}\n${cwd.trim()}`
  const [offered, setOffered] = useState<Offered | null>(null)
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [pickedLucky, setPickedLucky] = useState<boolean | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => {
    if (!active || offered?.key === key) return
    let current = true
    setOffered({ key, data: null, error: null })
    setTemplateId(null)
    setPickedLucky(null)
    api
      .listHarnessTemplatesForLaunch(cwd.trim(), machine ?? undefined)
      .then((data) => {
        if (!current) return
        setOffered({ key, data, error: null })
        const last = data.templates.some((t) => t.id === data.lastUsedId) ? data.lastUsedId : null
        setTemplateId(last)
        // Canvas 65d: nothing run in this directory before, the sheet opens on arrival.
        if (last === null && data.templates.length > 0) setSheetOpen(true)
      })
      .catch((err: unknown) => {
        if (current) setOffered({ key, data: null, error: errorSentence(err, 'the Mac did not answer') })
      })
    return () => {
      current = false
    }
    // `offered` is read to skip a directory already read, not to re-run on its answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key])

  const data = offered?.key === key ? offered.data : null
  const error = offered?.key === key ? offered.error : null
  const template = data?.templates.find((t) => t.id === templateId) ?? null
  const lucky = pickedLucky ?? template?.options.lucky ?? false
  const block = harnessStartBlock({ templates: data?.templates ?? null, template, inputs })
  return {
    data,
    error,
    template,
    inputs,
    setInput: (k, value) => setInputs((prev) => ({ ...prev, [k]: value })),
    pick: (id) => {
      // Feeling lucky starts again at the new template's default.
      if (id !== templateId) setPickedLucky(null)
      setTemplateId(id)
    },
    lucky,
    luckyChanged: template !== null && pickedLucky !== null && pickedLucky !== template.options.lucky,
    setLucky: setPickedLucky,
    sheetOpen,
    setSheetOpen,
    block,
    launch: template && block === null ? harnessLaunch(template, inputs, lucky) : null,
  }
}

/** Canvas 65d: a template's scope mark, ▢ for this project's, ◯ for a global one. */
function ScopeMark({ scope }: { scope: 'project' | 'global' }) {
  return (
    <span
      aria-hidden
      className={[
        'box-border block h-[7px] w-[7px] shrink-0 border-[1.3px] border-ink-200/70',
        scope === 'project' ? 'rounded-[2px]' : 'rounded-full',
      ].join(' ')}
    />
  )
}

const CARD = 'overflow-hidden rounded-[14px] border border-line/14 bg-space/50'

/**
 * WITH A HARNESS (canvas 65d, phones 2, 3 and 5): pushed over New session,
 * whose form stays as it was underneath. TEMPLATE is one row that opens the
 * sheet; the picked template's inputs, Feeling lucky and Steps follow, then
 * the first prompt as the note for step 1. Start says in its label why it
 * cannot go yet.
 */
export function NewSessionHarness({
  choice,
  cwd,
  mac,
  prompt,
  setPrompt,
  startLabel,
  canStart,
  onStart,
  onBack,
  failure,
}: {
  choice: HarnessChoice
  cwd: string
  mac: string
  prompt: string
  setPrompt: (text: string) => void
  /** The button's words: the block's reason, else the start. */
  startLabel: string
  canStart: boolean
  onStart: () => void
  onBack: () => void
  failure: ReactNode
}) {
  const [stepsOpen, setStepsOpen] = useState(false)
  // The hardware back button steps back to the form, as ‹ does; a sheet opened over the screen
  // goes first. Registered once, so a render does not move the screen above its sheets.
  const back = useRef({ dismiss: onBack })
  back.current.dismiss = onBack
  useEffect(() => registerSheet(back.current), [])
  const { data, error, template } = choice
  const project = data?.project?.name ?? basename(cwd.trim())
  const none = data !== null && data.templates.length === 0

  const header = (
    <div className="flex h-13 items-center gap-1.5 px-1.5">
      <button type="button" aria-label="Back" onClick={onBack} className="grid h-11 w-11 place-items-center fs-24 text-ink-200/85">
        ‹
      </button>
      <h1 className="flex-1 fs-17 font-bold">With a harness</h1>
      <span className="min-w-0 truncate pr-3.5 font-mono fs-11 text-ink-900/70">{project}</span>
    </div>
  )

  const footer = (
    <div className="border-t border-line/8 px-4 pb-1.5 pt-2.5">
      <PrimaryButton onClick={onStart} disabled={!canStart} explains>
        {startLabel}
      </PrimaryButton>
      {failure}
    </div>
  )

  const row = !data ? (
    <TemplateRowBody title={error ? 'Templates could not be read' : 'Reading templates…'} dim meta={error ?? ''} />
  ) : none ? (
    <TemplateRowBody title="No templates here" dim meta={`${project} · none global`} />
  ) : (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => choice.setSheetOpen(true)}
      className="block w-full text-left"
    >
      <TemplateRowBody
        mark={template ? (template.scope.kind === 'project' ? 'project' : 'global') : undefined}
        title={template?.name ?? 'Choose a template'}
        dim={!template}
        meta={template ? `${template.scope.kind === 'project' ? 'this project' : 'global'} · ${templateMeta(template)}` : `${data.templates.length} offered here`}
        chevron
      />
    </button>
  )

  const steps = template ? stepsSummary(template) : null

  return (
    <MobileScreen header={header} footer={footer}>
      <div className="flex flex-col gap-[18px] px-4 py-3.5">
        <div className="flex flex-col gap-2">
          <FieldLabel>TEMPLATE</FieldLabel>
          <div className={CARD}>{row}</div>
          {none && (
            // Canvas 65d phone 5: the phone has no editor, so it says where templates are made.
            <p className="px-1 fs-12.5 leading-[1.5] text-pretty text-ink-900/75">
              No harness templates for <span className="font-mono fs-11.5 text-ink-200/85">{project}</span> yet, and no
              global ones. Make one in Orbital on {mac}: <span className="font-semibold text-ink-100">Settings → Harness templates</span>.
            </p>
          )}
        </div>

        {template && (
          <>
            {template.inputs.length > 0 && (
              <div className="flex flex-col gap-2">
                <FieldLabel>INPUTS</FieldLabel>
                <div className={CARD}>
                  {template.inputs.map((input, i) => {
                    const value = choice.inputs[input.key] ?? ''
                    const required = inputRequired(input)
                    return (
                      <label
                        key={input.key}
                        className={['flex flex-col gap-1 px-3.5 py-2.5', i > 0 ? 'border-t border-line/10' : ''].join(' ')}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="font-mono fs-10 uppercase tracking-[0.14em] text-ink-900/60">{input.label}</span>
                          <span className="flex-1" />
                          {/* 65d: "required" in the bright ink while it is still empty. */}
                          <span className={['font-mono fs-10.5', required && !value.trim() ? 'text-ink-100' : 'text-ink-900/50'].join(' ')}>
                            {required ? 'required' : 'optional'}
                          </span>
                        </span>
                        <input
                          value={value}
                          onChange={(e) => choice.setInput(input.key, e.target.value)}
                          placeholder={input.hint ?? ''}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          className="min-h-6 w-full truncate bg-transparent font-mono fs-13 leading-[1.5] text-ink-100 outline-none placeholder:text-ink-900/45"
                        />
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            <div className={CARD}>
              <div className="flex min-h-13 items-center gap-3 pl-3.5 pr-0.5">
                <span className="flex-1 fs-14.5 font-semibold">Feeling lucky</span>
                <span className="font-mono fs-10.5 text-ink-900/50">
                  {choice.luckyChanged ? 'changed · ' : ''}template: {template.options.lucky ? 'on' : 'off'}
                </span>
                <Toggle checked={choice.lucky} onChange={choice.setLucky} label="Feeling lucky" size="lg" />
              </div>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => setStepsOpen(true)}
                className="flex min-h-13 w-full items-center gap-3 border-t border-line/10 px-3.5 text-left"
              >
                <span className="flex-1 fs-14.5 font-semibold">Steps</span>
                <span className="flex items-center gap-1.5 font-mono fs-11.5 text-ink-900/70">
                  {steps?.steps}
                  {steps?.gates && (
                    <>
                      {' · '}
                      <span aria-hidden className="box-border block h-1.5 w-1.5 shrink-0 rotate-45 rounded-[1px] border-[1.3px] border-current" />
                      {steps.gates}
                    </>
                  )}
                </span>
                <span aria-hidden className="fs-18 text-ink-900/60">›</span>
              </button>
            </div>
          </>
        )}

        {/* The first prompt of New session, the same text: here it is a note added to step 1. */}
        {!none && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2 font-mono fs-10 tracking-[0.16em] text-ink-900/60">
              NOTE FOR STEP 1<span className="tracking-[0.04em] text-ink-900/45">· optional</span>
            </div>
            <textarea
              aria-label="Note for step 1"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Optional. Added to step 1 as a note."
              rows={3}
              className="box-border min-h-[88px] w-full resize-none rounded-[14px] border border-line/18 bg-space/60 px-3.5 py-3 fs-14.5 leading-[1.5] text-ink-100 outline-none placeholder:text-ink-900/50 focus:border-accent/55"
            />
          </div>
        )}
      </div>

      <SheetPresence>
        {choice.sheetOpen && data && (
          <TemplateSheet
            offered={data}
            value={template?.id ?? null}
            mac={mac}
            onPick={(id) => {
              choice.pick(id)
              choice.setSheetOpen(false)
            }}
            onClose={() => choice.setSheetOpen(false)}
          />
        )}
      </SheetPresence>
      <SheetPresence>
        {stepsOpen && template && <TemplateStepsSheet template={template} onClose={() => setStepsOpen(false)} />}
      </SheetPresence>
    </MobileScreen>
  )
}

/** Canvas 65d TEMPLATE: a 56 px row — the scope mark, the name over its meta, › when it opens the sheet. */
function TemplateRowBody({
  mark, title, meta, dim = false, chevron = false,
}: { mark?: 'project' | 'global'; title: string; meta: string; dim?: boolean; chevron?: boolean }) {
  return (
    <span className="flex min-h-14 items-center gap-3 py-1.5 pl-3.5 pr-2.5">
      {mark && <ScopeMark scope={mark} />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={['truncate fs-14.5 font-semibold', dim ? 'text-ink-900/60' : 'text-ink-100'].join(' ')}>{title}</span>
        {meta && <span className="truncate font-mono fs-11 text-ink-900/65">{meta}</span>}
      </span>
      {chevron && (
        <span aria-hidden className="w-7 text-center fs-18 text-ink-900/60">
          ›
        </span>
      )}
    </span>
  )
}

/**
 * TEMPLATE FOR <PROJECT> (canvas 65d phone 4): the 63g sheet's shell — handle,
 * mono title, search — standing near the top, 56 px rows under their group's
 * caption, this project first, ✓ on the pick; the list scrolls under a fade.
 */
function TemplateSheet({
  offered,
  value,
  mac,
  onPick,
  onClose,
}: {
  offered: LaunchHarnessTemplates
  value: number | null
  mac: string
  onPick: (id: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const lines = templateSheetLines(offered.templates, offered.project, offered.lastUsedId, query)
  const count = offered.templates.length
  const title = `TEMPLATE FOR ${(offered.project?.name ?? 'this directory').toUpperCase()}`

  return (
    <BottomSheet label="Template" onDismiss={onClose} swipeToDismiss>
      {/* 65d: the sheet stands 58 px from the top; the handle and the home row are the shell's. */}
      <div className="flex h-[calc(100dvh-102px)] flex-col">
        <div className="shrink-0 px-2.5 pb-2.5 pt-0.5 font-mono fs-10 tracking-[0.18em] text-ink-900/60">{title}</div>
        <input
          aria-label="Search templates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates"
          inputMode="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mx-1.5 mb-2 box-border block h-11 w-[calc(100%-12px)] shrink-0 rounded-[12px] border border-line/16 bg-space/60 px-3.5 font-mono fs-13 text-ink-100 outline-none placeholder:text-ink-900/50 focus:border-accent/55"
        />
        <div
          role="listbox"
          aria-label="Templates"
          data-sheet-scroll
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-10 [mask-image:linear-gradient(#000_calc(100%-40px),transparent)]"
        >
          {lines.length === 0 && <div className="px-2.5 py-3 fs-13 text-ink-900/60">No template matches.</div>}
          {lines.map((line) =>
            line.kind === 'caption' ? (
              <div
                key={`cap-${line.scope}`}
                className="flex items-center gap-2 px-2.5 pb-1 pt-3 font-mono fs-9.5 tracking-[0.14em] text-ink-900/55"
              >
                <ScopeMark scope={line.scope} />
                {line.label}
              </div>
            ) : (
              <button
                key={line.template.id}
                type="button"
                role="option"
                aria-selected={line.template.id === value}
                onClick={() => onPick(line.template.id)}
                className={[
                  'flex min-h-14 w-full items-center gap-3 rounded-[10px] px-2.5 py-1.5 text-left text-ink-100',
                  line.template.id === value ? 'bg-line/7' : 'bg-transparent active:bg-line/7',
                ].join(' ')}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate fs-14.5 font-semibold">{line.template.name}</span>
                  <span className="truncate font-mono fs-11 text-ink-900/60">{line.meta}</span>
                </span>
                <span
                  aria-hidden
                  className={['w-3.5 shrink-0 font-mono fs-13 text-accent', line.template.id === value ? '' : 'opacity-0'].join(' ')}
                >
                  ✓
                </span>
              </button>
            ),
          )}
        </div>
        <div className="shrink-0 px-2.5 pt-2.5 text-center font-mono fs-10.5 leading-[1.5] text-ink-900/50">
          {count} {count === 1 ? 'template' : 'templates'} · edited in Orbital on {mac}
        </div>
      </div>
    </BottomSheet>
  )
}

/** Steps ›: the picked template's steps, read-only, with 10b's rail markers (◆ waits for you, ● runs on). */
function TemplateStepsSheet({ template, onClose }: { template: HarnessTemplate; onClose: () => void }) {
  return (
    <BottomSheet label={`Steps of ${template.name}`} onDismiss={onClose} swipeToDismiss>
      <div className="flex max-h-[70vh] flex-col">
        <div className="shrink-0 px-2.5 pb-3 pt-0.5">
          <div className="font-mono fs-10 tracking-[0.18em] text-ink-900/60">STEPS</div>
          <div className="mt-1.5 fs-18 font-bold">{template.name}</div>
        </div>
        <div data-sheet-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2">
          {template.steps.map((step, i) => {
            const gate = step.mode === 'gate'
            return (
              <div key={step.id} className="flex min-h-14 gap-3">
                <div className="flex w-3.5 shrink-0 flex-col items-center">
                  <RailMarker kind={gate ? 'pendingGate' : 'pending'} gate={gate} />
                  {i < template.steps.length - 1 && <span aria-hidden className="mt-1.5 block w-px flex-1 bg-line/12" />}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-[3px] pb-3">
                  <span className="text-pretty fs-13.5 font-semibold leading-[1.38] text-ink-100">{step.title}</span>
                  <span className="font-mono fs-10 text-ink-900/60">{gate ? 'waits for you' : 'runs on'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </BottomSheet>
  )
}
