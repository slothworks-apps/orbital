/** Machine filter's selection with machineId added, or removed if it was in. Empty means All. */
export function toggleMachine(selected: string[], machineId: string): string[] {
  return selected.includes(machineId)
    ? selected.filter((id) => id !== machineId)
    : [...selected, machineId]
}
