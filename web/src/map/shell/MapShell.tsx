import { Fragment, useMemo } from 'react'
import {
  useOrbital,
  parseSidebarWidth,
  parseDetailPanelWidth,
  resolvePanelPairWidths,
  SUBAGENT_PANEL_DEFAULT_PX,
  PANEL_GUTTER_PX,
} from '../../store/store'
import { sessionStateKey, type SessionStateKey } from '../../lib/types'
import type { SceneModel } from '../sceneModel'
import { stateColor, stateDot } from '../../lib/stateStyle'
import { StateDot } from '../../ui/StateDot'
import { useViewportWidth } from '../../lib/useViewportWidth'
import { mapTopInset, useWindowChromeEnv } from '../../lib/windowChrome'
import { Button } from '../../ui/Button'
import { shortcutLabel } from '../../lib/keymap'
import { useCommand } from '../../lib/commands'
import { EndDialog } from '../../panels/EndDialog'
import type { CameraState } from '../camera'

const SIDEBAR_GUTTER_PX = 40
const SIDEBAR_COLLAPSED_PX = 96
const SLOTH_LEFT_PERCENT = (120 / 1440) * 100
const SLOTH_TOP_PERCENT = (640 / 900) * 100

/**
 * The panel-driven chrome every map renderer lays itself out against: where
 * the sidebar ends on the left, where the open panels start on the right, and
 * the window chrome on top — the same numbers `SpaceMap` frames its fit with.
 */
export function useMapInsets() {
  const settings = useOrbital((s) => s.settings)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const sidebarCollapsed = useOrbital((s) => s.ui.sidebarCollapsed)
  const subagentPanelOpen = useOrbital((s) => s.subagentPanel !== null || s.taskOutput !== null)
  const viewportWidth = useViewportWidth()
  const sidebarWidth = parseSidebarWidth(settings, viewportWidth)
  const rawDetailPanelWidth = parseDetailPanelWidth(settings, viewportWidth)
  const pairWidths = useMemo(
    () =>
      subagentPanelOpen
        ? resolvePanelPairWidths(rawDetailPanelWidth, SUBAGENT_PANEL_DEFAULT_PX, viewportWidth)
        : { detailWidthPx: rawDetailPanelWidth, subagentWidthPx: 0 },
    [subagentPanelOpen, rawDetailPanelWidth, viewportWidth]
  )
  const rightPanelsChromePx =
    pairWidths.detailWidthPx + PANEL_GUTTER_PX + (subagentPanelOpen ? pairWidths.subagentWidthPx + PANEL_GUTTER_PX : 0)
  const topInset = mapTopInset(useWindowChromeEnv())
  const insets = useMemo(
    () => ({
      left: sidebarCollapsed ? SIDEBAR_COLLAPSED_PX : sidebarWidth + SIDEBAR_GUTTER_PX,
      right: selectedId ? rightPanelsChromePx : 0,
      top: topInset,
    }),
    [sidebarCollapsed, sidebarWidth, selectedId, rightPanelsChromePx, topInset]
  )
  return { insets, overlayRightPx: selectedId ? rightPanelsChromePx + 24 : 24 }
}

/**
 * DOM overlays for the map renderers other than Planets (spec
 * 2026-10-01-map-themes-design § 2): aggregate HUD, zoom column, new-session
 * CTA, error log, camera readout, sloth and the End dialog a history drop
 * opens. Drawn the way `SpaceMap` draws its own, following the panels.
 */
export function MapShell(props: {
  model: SceneModel
  camera: CameraState
  children?: React.ReactNode
  showZoomColumn?: boolean
  showCameraReadout?: boolean
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFit?: () => void
  onNewSession?: () => void
  onErrorsClick?: () => void
  confirmEndId?: string | null
  onConfirmEndClose?: () => void
  onConfirmEnd?: (id: string) => Promise<void>
}) {
  const errorLogOpen = useOrbital((s) => s.ui.dialog === 'errors')
  const errorsUnseen = useOrbital((s) => s.errorsUnseen)
  const resizingPanel = useOrbital((s) => s.ui.resizingPanel ?? false)
  const { insets: mapInsets, overlayRightPx } = useMapInsets()

  const overlayTransition = resizingPanel
    ? ''
    : 'transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'
  const overlayLeftTransition = resizingPanel
    ? ''
    : 'transition-[left] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'

  const { model } = props
  // Split like `SpaceMap`'s readout: only a parked question is NEEDS INPUT,
  // an interrupted one says so, the rest finished. Muted planets are left out.
  const aggregateSegments = useMemo(() => {
    const { working, needs_input: needsInput, idle, ended } = model.counts
    let asking = 0
    let interrupted = 0
    for (const p of model.planets) {
      if (p.muted || p.session.status !== 'needs_input') continue
      const key = sessionStateKey(p.session)
      if (key === 'needs_input') asking++
      else if (key === 'interrupted') interrupted++
    }
    const done = needsInput - asking - interrupted
    const segments: Array<{ key: SessionStateKey; text: string }> = [
      { key: 'working', text: `${working} WORKING` },
      ...(asking > 0 ? [{ key: 'needs_input' as const, text: `${asking} NEEDS INPUT` }] : []),
      ...(interrupted > 0 ? [{ key: 'interrupted' as const, text: `${interrupted} INTERRUPTED` }] : []),
      ...(done > 0 ? [{ key: 'done' as const, text: `${done} DONE` }] : []),
      { key: 'idle', text: `${idle} IDLE` },
      { key: 'ended', text: `${ended} ENDED` },
    ]
    return segments
  }, [model.counts, model.planets])

  const zoomPercent = Math.round(props.camera.zoom)
  const camX = Math.round(props.camera.x)
  const camY = Math.round(props.camera.y)

  const handleFit = () => {
    props.onFit?.()
  }

  useCommand('map.fit', handleFit)

  const showZoomColumn = props.showZoomColumn !== false

  return (
    <div className="pointer-events-none absolute inset-0 z-[6]">
      {/* Aggregate readout (1a, right:24px/top:24px) */}
      <div
        data-overlay="aggregate"
        className={[
          'pointer-events-none absolute top-6 flex flex-col items-end gap-2',
          overlayTransition,
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ right: overlayRightPx }}
      >
        <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.1em] text-text-muted">
          {aggregateSegments.map(({ key, text }, i) => {
            const color = stateColor(key)
            return (
              <Fragment key={key}>
                {i > 0 && <span className="text-[rgba(160,190,225,.28)]">·</span>}
                <span data-state={key} className="flex items-center gap-[5px]" style={{ color }}>
                  <StateDot dot={stateDot(key, 'label')} color={color} solidPx={5} hollowPx={6} />
                  {text}
                </span>
              </Fragment>
            )
          })}
        </div>
      </div>

      {/* Camera readout */}
      {props.showCameraReadout !== false && (
      <div
        data-overlay="camera-readout"
        style={{ left: mapInsets.left }}
        className={[
          'pointer-events-none absolute bottom-6 font-mono text-[10.5px] tracking-[0.08em] text-text-muted/70',
          overlayLeftTransition,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {zoomPercent}% · x {camX} y {camY}
      </div>
      )}

      {/* Zoom column and error log — the zoom buttons only where there is a camera */}
      {(
        <div
          data-overlay="zoom-column"
          className={[
            'pointer-events-auto absolute bottom-6 flex flex-col items-stretch gap-2',
            overlayTransition,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ right: overlayRightPx }}
        >
          <button
            type="button"
            aria-label={errorsUnseen > 0 ? `Error log — ${errorsUnseen} unseen` : 'Error log'}
            title={`Error log · ${shortcutLabel('global.errors')}`}
            onClick={props.onErrorsClick}
            className={[
              'relative grid h-[34px] w-[34px] place-items-center rounded-[9px] border bg-[rgba(10,14,24,.92)] text-base font-bold leading-none transition-colors',
              errorLogOpen
                ? 'border-accent/50 text-text-bright shadow-[0_0_0_3px_rgba(89,228,243,.1)]'
                : [
                    'border-[rgba(150,205,255,.16)] hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.1)] hover:text-white',
                    errorsUnseen > 0 ? 'text-text-bright' : 'text-[rgba(200,220,245,.6)]',
                  ].join(' '),
            ].join(' ')}
          >
            <span aria-hidden>!</span>
            {errorsUnseen > 0 && (
              <span
                aria-hidden
                className={[
                  'absolute -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full border border-[rgba(2,4,9,.8)] bg-[#de3b3d] font-mono text-[9.5px] font-medium tracking-[0.02em] text-white',
                  errorsUnseen > 99 ? '-right-2.5 px-[5px]' : '-right-1.5 px-1',
                ].join(' ')}
              >
                {errorsUnseen > 99 ? '99+' : errorsUnseen}
              </span>
            )}
          </button>

          {showZoomColumn && (
          <div className="flex flex-col overflow-hidden rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,14,24,.92)]">
            <button
              type="button"
              aria-label="Zoom in"
              onClick={props.onZoomIn}
              className="grid h-[34px] w-[34px] place-items-center border-b border-[rgba(150,205,255,.1)] text-base text-text-bright hover:bg-white/5"
            >
              +
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={props.onZoomOut}
              className="grid h-[34px] w-[34px] place-items-center border-b border-[rgba(150,205,255,.1)] text-base text-text-bright hover:bg-white/5"
            >
              −
            </button>
            <button
              type="button"
              aria-label="Fit view"
              title={`Fit view · ${shortcutLabel('map.fit')}`}
              onClick={handleFit}
              className="grid h-[34px] w-[34px] place-items-center text-sm text-text-bright hover:bg-white/5"
            >
              ⌖
            </button>
          </div>
          )}
        </div>
      )}

      {/* New session CTA */}
      <div
        data-overlay="new-session"
        style={{ left: mapInsets.left, right: mapInsets.right }}
        className={[
          'pointer-events-none absolute bottom-6 flex justify-center',
          resizingPanel ? '' : 'transition-[left,right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Button
          variant="cta"
          size="lg"
          className="pointer-events-auto"
          onClick={props.onNewSession}
        >
          <span aria-hidden className="text-base leading-none text-accent">
            +
          </span>
          New session
          <span className="rounded border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[10px] text-[rgba(200,220,245,.7)]">
            {shortcutLabel('global.new-session')}
          </span>
        </Button>
      </div>

      {/* Sloth */}
      <div
        className="orbital-sloth pointer-events-none absolute"
        data-paused={undefined}
        style={{
          left: `${SLOTH_LEFT_PERCENT}%`,
          top: `${SLOTH_TOP_PERCENT}%`,
          width: 16,
          opacity: 0.7,
        }}
      >
        <div className="orbital-sloth-bob">
          <img
            src="/sloth.png"
            alt=""
            style={{
              display: 'block',
              width: 16,
              height: 'auto',
              filter: 'drop-shadow(0 0 4px oklch(80% .13 210 / .35))',
            }}
          />
        </div>
      </div>

      {/* End dialog */}
      <EndDialog
        open={props.confirmEndId !== null}
        sessionId={props.confirmEndId ?? null}
        onClose={props.onConfirmEndClose ?? (() => {})}
        onEnd={props.onConfirmEnd}
      />

      {props.children}
    </div>
  )
}
