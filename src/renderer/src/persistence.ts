type Flusher = () => Promise<void>

const flushers = new Set<Flusher>()

export function registerWorkspaceFlusher(flusher: Flusher): () => void {
  flushers.add(flusher)
  return () => flushers.delete(flusher)
}

export async function flushWorkspaceEditors(): Promise<void> {
  await Promise.all([...flushers].map((flusher) => flusher()))
}
