/** PDF.js rejects a render task when virtualization, zooming, or teardown cancels it. */
export function isPdfRenderCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: unknown; message?: unknown }
  return value.name === 'RenderingCancelledException'
    || (typeof value.message === 'string' && /rendering cancelled/i.test(value.message))
}

export function observePdfRender(
  promise: Promise<unknown>,
  cancelled: () => boolean,
  onError: (error: unknown) => void,
): Promise<boolean> {
  return promise.then(
    () => true,
    (error: unknown) => {
      if (cancelled() && isPdfRenderCancellation(error)) return false
      onError(error)
      return false
    },
  )
}
