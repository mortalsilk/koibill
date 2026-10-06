import type { Annotation, NormalizedPoint, NormalizedRect } from '../../shared/types'

export function normalizePdfPoint(
  point: [number, number],
  viewBox: [number, number, number, number],
): NormalizedPoint {
  const [x1, y1, x2, y2] = viewBox
  return { x: (point[0] - x1) / (x2 - x1), y: (point[1] - y1) / (y2 - y1) }
}

export function normalizePdfRect(
  first: [number, number],
  second: [number, number],
  viewBox: [number, number, number, number],
): NormalizedRect {
  const a = normalizePdfPoint(first, viewBox)
  const b = normalizePdfPoint(second, viewBox)
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

export function findAnnotationAt(annotations: Annotation[], pageIndex: number, point: NormalizedPoint, tolerance = 0.012): Annotation | undefined {
  return [...annotations].reverse().find((annotation) => {
    if (annotation.pageIndex !== pageIndex) return false
    if (annotation.type === 'highlight') {
      return annotation.rects.some((rect) => point.x >= rect.x - tolerance
        && point.x <= rect.x + rect.width + tolerance
        && point.y >= rect.y - tolerance
        && point.y <= rect.y + rect.height + tolerance)
    }
    for (let index = 1; index < annotation.points.length; index += 1) {
      if (distanceToSegment(point, annotation.points[index - 1], annotation.points[index]) <= tolerance) return true
    }
    return false
  })
}

function distanceToSegment(point: NormalizedPoint, start: NormalizedPoint, end: NormalizedPoint): number {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y)
  const progress = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared))
  return Math.hypot(point.x - (start.x + progress * (end.x - start.x)), point.y - (start.y + progress * (end.y - start.y)))
}
