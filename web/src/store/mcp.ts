import { create } from 'zustand'

/**
 * Which session the MCP dialog is open for (spec
 * 2026-10-01-mcp-servers-in-the-session-design § Where it lives), kept out of
 * the main store the way compaction's dialog is — nothing but the composer's
 * `/mcp` and the dialog read it. Both the main window and a detached session
 * window mount the dialog; each window has its own store, so each opens its
 * own.
 *
 * `seq` counts opens: the dialog keys its state on it, so every open starts
 * from a fresh fetch while a closing dialog keeps its content through the
 * exit transition.
 */
interface McpUiState {
  sessionId: string | null
  seq: number
  open(sessionId: string): void
  close(): void
}

export const useMcpUi = create<McpUiState>((set) => ({
  sessionId: null,
  seq: 0,
  open: (sessionId) => set((s) => ({ sessionId, seq: s.seq + 1 })),
  close: () => set({ sessionId: null }),
}))
