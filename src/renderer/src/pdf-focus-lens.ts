import type { ReadingRect } from './pdf-reading-map'

export interface LensBox { x: number; y: number; width: number; height: number }
export interface FocusLensLayout { source: LensBox; destination: LensBox; effectiveMagnification: number }

export function focusLensLayout(rects: ReadingRect[], pageWidth: number, pageHeight: number, requestedMagnification: number): FocusLensLayout | null {
  if (!rects.length || pageWidth <= 0 || pageHeight <= 0) return null
  const left = Math.min(...rects.map((rect) => rect.x)) * pageWidth
  const top = Math.min(...rects.map((rect) => rect.y)) * pageHeight
  const right = Math.max(...rects.map((rect) => rect.x + rect.width)) * pageWidth
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) * pageHeight
  const paddingX = Math.max(4, (bottom - top) * .18)
  const paddingY = Math.max(3, (bottom - top) * .1)
  const source: LensBox = {
    x: Math.max(0, left - paddingX),
    y: Math.max(0, top - paddingY),
    width: Math.min(pageWidth, right + paddingX) - Math.max(0, left - paddingX),
    height: Math.min(pageHeight, bottom + paddingY) - Math.max(0, top - paddingY),
  }
  if (source.width <= 0 || source.height <= 0) return null
  const requested = Math.min(1.6, Math.max(1.1, requestedMagnification))
  const effectiveMagnification = Math.max(1, Math.min(requested, pageWidth / source.width, pageHeight / source.height))
  const width = source.width * effectiveMagnification
  const height = source.height * effectiveMagnification
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  const destination: LensBox = {
    x: Math.min(pageWidth - width, Math.max(0, centerX - width / 2)),
    y: Math.min(pageHeight - height, Math.max(0, centerY - height / 2)),
    width,
    height,
  }
  return { source, destination, effectiveMagnification }
}
