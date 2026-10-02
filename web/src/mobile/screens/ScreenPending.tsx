/** Stands in for a screen a later task builds; Task 13 deletes it. */
export function ScreenPending({ name }: { name: string }) {
  return (
    <main className="flex h-full items-center justify-center font-mono text-[11px] tracking-[0.2em] text-text-muted">
      {name.toUpperCase()}
    </main>
  )
}
