import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { childPath, crumbsOf, isMemberOffline, recentAge } from '../lib/devices'
import type { DirListing } from '../lib/types'
import { Button } from '../ui/Button'
import { KindGlyph } from '../ui/KindGlyph'
import { useEscapeLayer } from '../ui/escapeLayer'

export interface FolderChooserProps {
  /** The member whose folders these are. */
  machine: string
  name: string
  kind: string
  /** Where to open: the field's directory, when it is one there; else the device's home. */
  start: string
  /** That device's recent project directories, most recent first. */
  recents: ReadonlyArray<{ cwd: string; lastAt: number | null }>
  onChoose: (path: string) => void
  onCancel: () => void
}

/**
 * New session's folder chooser for another device, which has no system
 * dialog to offer (canvas 50g FOLDER CHOOSER): that device's recent projects
 * on the left, one level of its folders on the right (`GET /api/dirs`),
 * breadcrumbs to go up, and *Choose this folder* to fill the field. It opens
 * in place, over the RECENT chips and the fields below them. A refusal — the
 * device went offline (409 `member_offline`), a folder it cannot read — is
 * one quiet line where the folders go, never a toast.
 */
export function FolderChooser({ machine, name, kind, start, recents, onChoose, onCancel }: FolderChooserProps) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Only the last walk's answer lands: a slow listing must not overwrite a newer one. */
  const latest = useRef(0)

  const walk = useCallback(
    (path: string | undefined, homeOnMiss = false) => {
      const ticket = ++latest.current
      api
        .listDirs(path, machine)
        .then((next) => {
          if (ticket !== latest.current) return
          setListing(next)
          setError(null)
        })
        .catch((err: unknown) => {
          if (ticket !== latest.current) return
          // The field's directory is not one there (yet): open at home instead.
          if (homeOnMiss && err instanceof ApiError && (err.status === 404 || err.status === 400)) {
            walk(undefined)
            return
          }
          setError(
            isMemberOffline(err)
              ? `${name} is offline — its folders can't be read right now.`
              : `Couldn't read this folder on ${name}.`,
          )
        })
    },
    [machine, name],
  )

  // Once, as it opens: the chooser is remounted for another device.
  useEffect(() => {
    walk(start.trim() || undefined, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The innermost layer while open: esc closes the chooser, not the dialog.
  useEscapeLayer(true, onCancel)

  // It hangs over the fields below, past the dialog body's bottom in a short
  // window, where the body's scroll would hide *Choose this folder*. Brought
  // into view as it opens, the least distance that shows all of it.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  const now = Date.now()
  const crumbs = listing ? crumbsOf(listing.path) : []

  return (
    // canvas 50g: hung 70px below the field group's top, 8px wider on each side.
    <div ref={box} className="absolute -left-2 -right-2 top-[70px] z-[8] flex flex-col overflow-hidden rounded-[10px] border border-line/16 bg-panel/97 shadow-[0_18px_44px_rgba(0,0,0,.6)] backdrop-blur-[12px]">
      <div className="flex items-center gap-1.5 border-b border-line/10 px-3 py-2.5 font-mono fs-11 text-ink-900/70">
        <span className="flex shrink-0 text-ink-100">
          <KindGlyph kind={kind} />
        </span>
        <span className="shrink-0 text-ink-100">{name}</span>
        <span aria-hidden className="shrink-0 text-line/30">:</span>
        <span className="flex min-w-0 items-center overflow-hidden" role="group" aria-label="Path">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => walk(crumb.path)}
                className={[
                  'cursor-pointer rounded-[4px] px-[3px] py-[2px] hover:bg-line/9',
                  i === crumbs.length - 1 ? 'text-ink-100' : 'text-ink-900/70',
                ].join(' ')}
              >
                {crumb.label}
              </button>
              {/* The root crumb is itself a slash. */}
              {i > 0 && i < crumbs.length - 1 && (
                <span aria-hidden className="text-line/30">
                  /
                </span>
              )}
            </span>
          ))}
        </span>
        <span aria-hidden className="flex-1" />
        <span className="shrink-0 whitespace-nowrap fs-9.5 tracking-[0.12em] text-ink-900/45">
          NO SYSTEM DIALOG ON THIS DEVICE
        </span>
      </div>

      <div className="grid h-[238px] grid-cols-[230px_minmax(0,1fr)]">
        <div className="flex flex-col gap-0.5 overflow-y-auto border-r border-line/10 px-1.5 py-2 [scrollbar-color:color-mix(in oklab, var(--color-line) 25%, transparent)_transparent] [scrollbar-width:thin]">
          <div className="shrink-0 px-2 pb-1.5 pt-0.5 font-mono fs-9.5 tracking-[0.14em] text-ink-900/55">
            RECENT PROJECTS ON {name.toUpperCase()}
          </div>
          {recents.map(({ cwd, lastAt }) => (
            <button
              key={cwd}
              type="button"
              title={cwd}
              onClick={() => walk(cwd)}
              className={[
                'flex w-full shrink-0 cursor-pointer flex-col gap-0.5 rounded-[7px] px-2 py-[7px] text-left',
                listing?.path === cwd ? 'bg-line/9' : 'hover:bg-line/7',
              ].join(' ')}
            >
              <span className="flex w-full items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-sans fs-12.5 font-bold text-ink-100">
                  {cwd.replace(/\/+$/, '').split('/').pop() || cwd}
                </span>
                <span className="shrink-0 font-mono fs-10 text-ink-900/50">{recentAge(lastAt, now)}</span>
              </span>
              <span className="w-full truncate font-mono fs-10 text-ink-900/60">{cwd}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-px overflow-auto px-1.5 py-2 [scrollbar-color:color-mix(in oklab, var(--color-line) 25%, transparent)_transparent] [scrollbar-width:thin]">
          <div className="shrink-0 truncate px-2 pb-1.5 pt-0.5 font-mono fs-9.5 tracking-[0.14em] text-ink-900/55">
            FOLDERS IN {listing?.path ?? ''}
          </div>
          {error ? (
            <div className="shrink-0 px-2 py-2.5 fs-12 text-ink-900/60">{error}</div>
          ) : (
            listing && (
              <>
                {listing.dirs.map((dir) => (
                  <button
                    key={dir.name}
                    type="button"
                    onClick={() => walk(childPath(listing.path, dir.name))}
                    className="flex w-full shrink-0 cursor-pointer items-center gap-[9px] rounded-[7px] px-2 py-[7px] text-left font-mono fs-11.5 text-ink-100 hover:bg-line/7"
                  >
                    {/* 50g's folder mark: 12 × 10, a 3px top edge. */}
                    <span
                      aria-hidden
                      className="box-border block h-2.5 w-3 flex-none rounded-[2px] border border-t-[3px] border-ink-700/55"
                    />
                    <span className="min-w-0 flex-1 truncate">{dir.name}</span>
                    <span aria-hidden className="text-ink-900/50">
                      {dir.hasChildren ? '›' : ''}
                    </span>
                  </button>
                ))}
                {listing.dirs.length === 0 && (
                  <div className="shrink-0 px-2 py-2.5 fs-12 text-ink-900/60">
                    No folders in here. Choose it, or go back up.
                  </div>
                )}
              </>
            )
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-line/10 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono fs-11 text-ink-100">{listing?.path ?? ''}</span>
        <Button variant="ghost" size="chooser" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary-plain"
          size="chooser"
          disabled={!listing || error !== null}
          onClick={() => listing && onChoose(listing.path)}
        >
          Choose this folder
        </Button>
      </div>
    </div>
  )
}
