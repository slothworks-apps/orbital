import { useEffect } from 'react'
import { useOrbital } from '../store/store'
import { getSocket } from './socket'
import { TRANSCRIPT_CHECK_MS } from './transcriptCheck'

/**
 * Runs the transcript check for the session on screen (spec
 * 2026-09-28-transcript-check-design). Skipped while the document is hidden
 * — nobody is reading — and while the socket is down, when the reconnect's
 * own catch-up is the one that reloads.
 */
export function useTranscriptCheck(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return
    const timer = window.setInterval(() => {
      if (document.hidden || getSocket().status !== 'open') return
      void useOrbital.getState().checkTranscript(sessionId)
    }, TRANSCRIPT_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [sessionId])
}
