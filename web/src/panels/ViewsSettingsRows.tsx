import { useState } from 'react'
import { addedLabel, CDN_HOST_EXAMPLE, cdnHostField, cdnHostRows, viewsStateLine, withCdnHost, withoutCdnHost } from '../lib/cdnHosts'
import { VIEWS_CDN_HOSTS_KEY, VIEWS_ENABLED_KEY, viewsEnabled } from '../lib/experimental'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { LockGlyph } from './ViewsGlyphs'
import { ViewGlyph } from './ViewParts'

/**
 * Settings → Labs → Views (canvas `Feature - Views` 69f; spec
 * 2026-11-18-generated-views-design § CDN hosts): the switch, and while it
 * is on the CDN hosts a view's scripts load from without asking — the
 * built-in ones locked, the user's with Remove, and a field to add one.
 * The list is this Mac's (`views_cdn_hosts` is per device); turning Views
 * off keeps it.
 */
export function ViewsSettingsRows({
  settings,
  patchAndSet,
}: {
  settings: Record<string, string | undefined>
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const on = viewsEnabled(settings)
  const stored = settings[VIEWS_CDN_HOSTS_KEY]
  const state = viewsStateLine(on, stored)
  return (
    <>
      {/* 69f: the Labs entry's grid, words left and the switch with its state line right. The
          control column is `Row labs`'s 280px (64f), not 69f's 240px, so it lines up with the
          Browser bridge row under it. */}
      <div className="grid grid-cols-[minmax(0,1fr)_280px] items-start gap-6 border-t border-line/8 py-[13px]">
        <div>
          <div className="flex items-center gap-2 fs-13.5 font-semibold text-ink-100">
            <span className="flex text-ink-200/80">
              <ViewGlyph />
            </span>
            Views
          </div>
          <div className="mt-1 fs-12 leading-[1.5] text-ink-900/70 [text-wrap:pretty]">
            A session can show its answer as a small page in the transcript: a chart, a table, a picker or a form. It
            runs isolated and in your colours.
          </div>
        </div>
        <div className="flex min-w-0 flex-col items-start gap-2">
          <Toggle
            aria-label="Views"
            checked={on}
            onChange={(checked) => void patchAndSet({ [VIEWS_ENABLED_KEY]: checked ? 'true' : 'false' })}
          />
          {state && <span className="font-mono fs-11 text-ink-200/80">{state}</span>}
        </div>
      </div>
      {on && <CdnHosts stored={stored} patchAndSet={patchAndSet} />}
    </>
  )
}

function CdnHosts({
  stored,
  patchAndSet,
}: {
  stored: string | undefined
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const [typed, setTyped] = useState('')
  const field = cdnHostField(typed, stored)
  const wrong = field.state === 'bad' || field.state === 'dup'
  const now = Date.now()

  async function add() {
    if (field.state !== 'ok' || field.host === null) return
    if (await patchAndSet({ [VIEWS_CDN_HOSTS_KEY]: withCdnHost(stored, field.host, Date.now()) })) setTyped('')
  }

  return (
    <>
      {/* 69f: the kicker, 14px above and 6px under. */}
      <div className="pb-1.5 pt-3.5 font-mono fs-10 tracking-[0.18em] text-ink-900/60">
        CDN HOSTS · SCRIPTS LOAD FROM THESE WITHOUT ASKING
      </div>
      {cdnHostRows(stored).map((row) => (
        <div
          key={row.host}
          className="grid min-h-[38px] grid-cols-[18px_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-line/8 py-1"
        >
          <span className="flex w-[18px] text-ink-900/60">{row.builtIn && <LockGlyph />}</span>
          <span className={`truncate font-mono fs-12.5 ${row.builtIn ? 'text-ink-200/80' : 'text-ink-100'}`}>
            {row.host}
          </span>
          <span className="font-mono fs-10.5 text-ink-900/60">
            {row.addedAt === null ? 'built in' : addedLabel(row.addedAt, now)}
          </span>
          {row.builtIn ? (
            // 69f: a built-in row keeps Remove's place empty, so the metas line up.
            <span className="block w-[72px]" />
          ) : (
            // 69f: no confirm — adding it back is one line.
            <Button
              variant="hairline"
              size="labs-row"
              onClick={() => void patchAndSet({ [VIEWS_CDN_HOSTS_KEY]: withoutCdnHost(stored, row.host) })}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      <form
        className="flex items-center gap-2.5 border-t border-line/8 pb-1.5 pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input
          font="mono"
          size="sm"
          className="min-w-0 flex-1"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Add a host, e.g. ${CDN_HOST_EXAMPLE}`}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Add a CDN host"
          invalid={wrong}
        />
        {/* 69f: Add stays dim until there is something to add. */}
        <Button type="submit" variant="hairline" size="labs" disabled={field.state !== 'ok'}>
          Add
        </Button>
      </form>
      <div className={`fs-11.5 leading-[1.5] [text-wrap:pretty] ${wrong ? 'text-danger-soft' : 'text-ink-900/60'}`}>
        {field.help}
      </div>
    </>
  )
}
