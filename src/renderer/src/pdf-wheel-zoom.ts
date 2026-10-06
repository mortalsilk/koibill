export interface WheelZoomAnchor {
  pageNumber: number
  normalizedX: number
  normalizedY: number
  clientX: number
  clientY: number
}

export interface ClientRectLike { left: number; top: number; width: number; height: number }

export function normalizeWheelDelta(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0
  if (deltaMode === 1) return deltaY * 16
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight)
  return deltaY
}

export function zoomForWheel(currentZoom: number, accumulatedDelta: number): number {
  const delta = Math.min(240, Math.max(-240, accumulatedDelta))
  const next = currentZoom * Math.exp(-delta * .0015)
  return Math.round(Math.min(4, Math.max(.25, next)) * 100) / 100
}

export function anchorScrollCorrection(anchor: WheelZoomAnchor, nextPage: ClientRectLike): { left: number; top: number } {
  return {
    left: nextPage.left + anchor.normalizedX * nextPage.width - anchor.clientX,
    top: nextPage.top + anchor.normalizedY * nextPage.height - anchor.clientY,
  }
}
