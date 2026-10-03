/**
 * What the page shows when the server refuses it for lacking the API token
 * (spec 2026-10-03-api-token-and-named-files-design § "The client without a
 * token"). The desktop never lands here — it sets the cookie before any window
 * loads — so this is a browser tab opened without the server's link.
 *
 * Placeholder look on existing tokens only; the final one comes from Claude
 * Design.
 */
export function Unauthorized() {
  return (
    <div
      role="status"
      className="flex h-screen w-screen items-center justify-center bg-space p-6 text-center text-sm text-text-muted"
    >
      Open Orbital from the link the server printed.
    </div>
  )
}
