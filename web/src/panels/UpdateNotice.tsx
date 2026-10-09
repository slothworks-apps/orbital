import { useEffect } from 'react'
import { updateNoticeContent, type UpdateNoticeButton } from '../lib/appUpdate'
import { useAppUpdate } from '../store/appUpdate'
import { useMapNotices } from '../store/mapNotices'
import { Button } from '../ui/Button'
import { MapNotice, MapNoticeProgress, MapNoticeText } from '../ui/MapNotice'

/**
 * The desktop app's update prompt: the notice toast's UPDATE kind (canvas
 * `Feature - App update`; spec 2026-10-08-builds-for-testers-design § The
 * desktop app updates itself). One message for the whole life of an update,
 * whose states swap their words in place — Available, Downloading, Ready,
 * Waiting, the receipt — and only the last of them ends it. While it is
 * downloading or waiting, the messages behind it wait too.
 *
 * Main owns the state; this only draws it and sends the buttons back. It
 * exists only where the desktop bridge has the update calls.
 */

const UPDATE_NOTICE_ID = 'app-update'

/**
 * Keeps the UPDATE message in the map's queue for as long as main has a
 * prompt, and takes it out when the prompt ends (skip, OK) — the message's
 * own buttons never close it themselves. Mounted by `App`.
 */
export function useAppUpdateNotice(): void {
  const showing = useAppUpdate((s) => s.state !== null && s.state.phase !== 'none')
  useEffect(() => {
    const notices = useMapNotices.getState()
    if (showing) notices.push({ id: UPDATE_NOTICE_ID, kind: 'update', Body: UpdateNotice })
    else notices.dismiss(UPDATE_NOTICE_ID)
  }, [showing])
}

function UpdateNotice() {
  const state = useAppUpdate((s) => s.shown)
  const shown = state ? updateNoticeContent(state) : null
  const source = useAppUpdate((s) => s.source)
  if (!shown || !source) return null

  const act = (button: UpdateNoticeButton | undefined) =>
    button ? () => source.updateAction(button.action) : undefined

  return (
    <MapNotice
      label={shown.label}
      onClose={act(shown.close)}
      closeLabel={shown.close?.label}
      closeTitle={shown.close?.label}
      actions={
        (shown.primary || shown.secondary) && (
          <>
            {shown.secondary && (
              <Button variant="quiet" size="notice-link" onClick={act(shown.secondary)}>
                {shown.secondary.label}
              </Button>
            )}
            {shown.primary && (
              <Button variant="lit" size="notice" onClick={act(shown.primary)}>
                {shown.primary.label}
              </Button>
            )}
          </>
        )
      }
    >
      <MapNoticeText>{shown.text}</MapNoticeText>
      {shown.progress && <MapNoticeProgress percent={shown.progress.percent} readout={shown.progress.readout} />}
    </MapNotice>
  )
}
