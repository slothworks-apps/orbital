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

  const now = Date.now()
  const crumbs = listing ? crumbsOf(listing.path) : []

  return (
    // canvas 50g: hung 70px below the field group's top, 8px wider on each side.
    <div className="absolute -left-2 -right-2 top-[70px] z-[8] flex flex-col overflow-hidden rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.97)] shadow-[0_18px_44px_rgba(0,0,0,.6)] backdrop-blur-[12px]">
      <div className="flex items-center gap-1.5 border-b border-[rgba(150,205,255,.1)] px-3 py-2.5 font-mono text-[11px] text-[rgba(160,190,225,.7)]">
        <span className="flex shrink-0 text-text-bright">
          <KindGlyph kind={kind} />
        </span>
        <span className="shrink-0 text-text-bright">{name}</span>
        <span aria-hidden className="shrink-0 text-[rgba(150,205,255,.3)]">:</span>
        <span className="flex min-w-0 items-center overflow-hidden" role="group" aria-label="Path">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => walk(crumb.path)}
                className={[
                  'cursor-pointer rounded-[4px] px-[3px] py-[2px] hover:bg-[rgba(150,205,255,.09)]',
                  i === crumbs.length - 1 ? 'text-text-bright' : 'text-[rgba(160,190,225,.7)]',
                ].join(' ')}
              >
                {crumb.label}
              </button>
              {/* The root crumb is itself a slash. */}
              {i > 0 && i < crumbs.length - 1 && (
                <span aria-hidden className="text-[rgba(150,205,255,.3)]">
                  /
                </span>
              )}
            </span>
          ))}
        </span>
        <span aria-hidden className="flex-1" />
        <span className="shrink-0 whitespace-nowrap text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.45)]">
          NO SYSTEM DIALOG ON THIS DEVICE
        </span>
      </div>

      <div className="grid h-[238px] grid-cols-[230px_minmax(0,1fr)]">
        <div className="flex flex-col gap-0.5 overflow-y-auto border-r border-[rgba(150,205,255,.1)] px-1.5 py-2 [scrollbar-color:rgba(150,205,255,.25)_transparent] [scrollbar-width:thin]">
          <div className="px-2 pb-1.5 pt-0.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.55)]">
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
                listing?.path === cwd ? 'bg-[rgba(150,205,255,.09)]' : 'hover:bg-[rgba(150,205,255,.07)]',
              ].join(' ')}
            >
              <span className="flex w-full items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-bold text-text-bright">
                  {cwd.replace(/\/+$/, '').split('/').pop() || cwd}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[rgba(160,190,225,.5)]">{recentAge(lastAt, now)}</span>
              </span>
              <span className="w-full truncate font-mono text-[10px] text-[rgba(160,190,225,.6)]">{cwd}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-px overflow-auto px-1.5 py-2 [scrollbar-color:rgba(150,205,255,.25)_transparent] [scrollbar-width:thin]">
          <div className="truncate px-2 pb-1.5 pt-0.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.55)]">
            FOLDERS IN {listing?.path ?? ''}
          </div>
          {error ? (
            <div className="px-2 py-2.5 text-[12px] text-[rgba(160,190,225,.6)]">{error}</div>
          ) : (
            listing && (
              <>
                {listing.dirs.map((dir) => (
                  <button
                    key={dir.name}
                    type="button"
                    onClick={() => walk(childPath(listing.path, dir.name))}
                    className="flex w-full shrink-0 cursor-pointer items-center gap-[9px] rounded-[7px] px-2 py-[7px] text-left font-mono text-[11.5px] text-text-bright hover:bg-[rgba(150,205,255,.07)]"
                  >
                    {/* 50g's folder mark: 12 × 10, a 3px top edge. */}
                    <span
                      aria-hidden
                      className="box-border block h-2.5 w-3 flex-none rounded-[2px] border border-t-[3px] border-[rgba(190,215,240,.55)]"
                    />
                    <span className="min-w-0 flex-1 truncate">{dir.name}</span>
                    <span aria-hidden className="text-[rgba(160,190,225,.5)]">
                      {dir.hasChildren ? '›' : ''}
                    </span>
                  </button>
                ))}
                {listing.dirs.length === 0 && (
                  <div className="px-2 py-2.5 text-[12px] text-[rgba(160,190,225,.6)]">
                    No folders in here. Choose it, or go back up.
                  </div>
                )}
              </>
            )
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-[rgba(150,205,255,.1)] px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-bright">{listing?.path ?? ''}</span>
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
