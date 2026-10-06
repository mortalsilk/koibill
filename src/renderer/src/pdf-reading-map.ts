import type { PdfFocusUnit } from '../../shared/types'

export interface ReadingRect { x: number; y: number; width: number; height: number }

export interface ReadingFragment {
  text: string
  rect: ReadingRect
  order: number
  leadingSpace?: boolean
}

export interface ReadingUnit {
  id: string
  pageNumber: number
  type: PdfFocusUnit
  text: string
  rects: ReadingRect[]
}

export interface PageReadingMap {
  pageNumber: number
  units: Record<PdfFocusUnit, ReadingUnit[]>
}

interface ReadingLine {
  fragments: ReadingFragment[]
  rect: ReadingRect
}

interface PositionedToken extends ReadingFragment {
  lineIndex: number
  start: number
  end: number
}

export function buildPageReadingMap(pageNumber: number, source: ReadingFragment[]): PageReadingMap {
  const fragments = source
    .filter((fragment) => fragment.text.trim() && validRect(fragment.rect))
    .sort((a, b) => a.order - b.order)
  const lines = groupLines(fragments)
  const paragraphs = groupParagraphs(lines)
  const sentences = paragraphs.flatMap((paragraph) => sentenceUnits(pageNumber, paragraph))
    .map((unit, index) => ({ ...unit, id: `${pageNumber}:sentence:${index}` }))
  return {
    pageNumber,
    units: {
      line: lines.map((line, index) => makeUnit(pageNumber, 'line', index, line.fragments)),
      paragraph: paragraphs.map((paragraph, index) => makeUnit(pageNumber, 'paragraph', index, paragraph.flatMap((line) => line.fragments))),
      sentence: sentences,
    },
  }
}

export function readingMapFromTextLayer(layer: HTMLElement, page: HTMLElement, pageNumber: number): PageReadingMap {
  const pageRect = page.getBoundingClientRect()
  if (pageRect.width <= 0 || pageRect.height <= 0) return buildPageReadingMap(pageNumber, [])
  const fragments: ReadingFragment[] = []
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let order = 0
  let pendingSpace = false
  while (node) {
    const value = node.textContent ?? ''
    for (const segment of wordSegments(value)) {
      if (!segment.text.trim()) { pendingSpace = true; continue }
      const range = layer.ownerDocument.createRange()
      range.setStart(node, segment.index)
      range.setEnd(node, segment.index + segment.text.length)
      const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
      for (const rect of rects) {
        const normalized = {
          x: clamp01((rect.left - pageRect.left) / pageRect.width),
          y: clamp01((rect.top - pageRect.top) / pageRect.height),
          width: Math.min(1, rect.width / pageRect.width),
          height: Math.min(1, rect.height / pageRect.height),
        }
        if (validRect(normalized)) fragments.push({ text: segment.text, rect: normalized, order: order++, leadingSpace: pendingSpace })
      }
      pendingSpace = false
    }
    node = walker.nextNode()
  }
  return buildPageReadingMap(pageNumber, fragments)
}

export function findReadingUnitAt(units: ReadingUnit[], x: number, y: number): ReadingUnit | null {
  const containing = units.find((unit) => unit.rects.some((rect) => x >= rect.x - .004 && x <= rect.x + rect.width + .004
    && y >= rect.y - .004 && y <= rect.y + rect.height + .004))
  if (containing) return containing
  let nearest: ReadingUnit | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const unit of units) {
    for (const rect of unit.rects) {
      const dx = x < rect.x ? rect.x - x : x > rect.x + rect.width ? x - rect.x - rect.width : 0
      const dy = y < rect.y ? rect.y - y : y > rect.y + rect.height ? y - rect.y - rect.height : 0
      const next = Math.hypot(dx, dy)
      if (next < distance) { distance = next; nearest = unit }
    }
  }
  return distance <= .035 ? nearest : null
}

export function nearestReadingUnit(units: ReadingUnit[], x: number, y: number): ReadingUnit | null {
  return units.reduce<ReadingUnit | null>((nearest, unit) => {
    if (!nearest) return unit
    return unitDistance(unit, x, y) < unitDistance(nearest, x, y) ? unit : nearest
  }, null)
}

function groupLines(fragments: ReadingFragment[]): ReadingLine[] {
  const lines: ReadingLine[] = []
  for (const fragment of fragments) {
    const current = lines.at(-1)
    const previous = current?.fragments.at(-1)
    const sameBaseline = current && verticalOverlap(current.rect, fragment.rect) >= .38
    const continuesRight = !previous || fragment.rect.x + fragment.rect.width >= previous.rect.x - .012
    if (!current || !sameBaseline || !continuesRight) {
      lines.push({ fragments: [fragment], rect: { ...fragment.rect } })
    } else {
      current.fragments.push(fragment)
      current.rect = bounds([...current.fragments.map((item) => item.rect)])
    }
  }
  return lines
}

function groupParagraphs(lines: ReadingLine[]): ReadingLine[][] {
  const paragraphs: ReadingLine[][] = []
  for (const line of lines) {
    const paragraph = paragraphs.at(-1)
    const previous = paragraph?.at(-1)
    if (!paragraph || !previous || !sameParagraph(previous, line)) paragraphs.push([line])
    else paragraph.push(line)
  }
  return paragraphs
}

function sameParagraph(previous: ReadingLine, next: ReadingLine): boolean {
  const height = Math.max(previous.rect.height, next.rect.height)
  const gap = next.rect.y - (previous.rect.y + previous.rect.height)
  if (next.rect.y < previous.rect.y - height * .5 || gap > height * 1.45) return false
  const overlap = horizontalOverlap(previous.rect, next.rect)
  const startsClose = Math.abs(previous.rect.x - next.rect.x) <= height * 3.2
  return overlap >= .12 || startsClose
}

function sentenceUnits(pageNumber: number, lines: ReadingLine[]): ReadingUnit[] {
  const tokens: PositionedToken[] = []
  let text = ''
  lines.forEach((line, lineIndex) => {
    line.fragments.forEach((fragment) => {
      const previous = tokens.at(-1)
      const separator = tokenSeparator(previous, fragment, lineIndex)
      text += separator
      const start = text.length
      text += fragment.text
      tokens.push({ ...fragment, lineIndex, start, end: text.length })
    })
  })
  return sentenceSegments(text).flatMap(({ start, end }, index) => {
    const selected = tokens.filter((token) => token.start < end && token.end > start)
    return selected.length ? [makeUnit(pageNumber, 'sentence', index, selected)] : []
  })
}

function makeUnit(pageNumber: number, type: PdfFocusUnit, index: number, fragments: ReadingFragment[]): ReadingUnit {
  return {
    id: `${pageNumber}:${type}:${index}`,
    pageNumber,
    type,
    text: fragments.map((fragment) => fragment.text).join(' ').replace(/\s+([,.;:!?%)\]}])/gu, '$1').replace(/([([{])\s+/gu, '$1').trim(),
    rects: mergeRects(fragments.map((fragment) => fragment.rect)),
  }
}

function mergeRects(rects: ReadingRect[]): ReadingRect[] {
  const sorted = [...rects].sort((a, b) => Math.abs(a.y - b.y) <= Math.max(a.height, b.height) * .4 ? a.x - b.x : a.y - b.y)
  const merged: ReadingRect[] = []
  for (const rect of sorted) {
    const previous = merged.at(-1)
    const sameLine = previous && verticalOverlap(previous, rect) >= .55
    const gap = previous ? rect.x - previous.x - previous.width : Number.POSITIVE_INFINITY
    if (previous && sameLine && gap <= .025) {
      const right = Math.max(previous.x + previous.width, rect.x + rect.width)
      const bottom = Math.max(previous.y + previous.height, rect.y + rect.height)
      previous.x = Math.min(previous.x, rect.x)
      previous.y = Math.min(previous.y, rect.y)
      previous.width = right - previous.x
      previous.height = bottom - previous.y
    } else merged.push({ ...rect })
  }
  return merged
}

function sentenceSegments(text: string): Array<{ start: number; end: number }> {
  try {
    const Segmenter = Intl.Segmenter
    if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'sentence' }).segment(text), (part) => ({ start: part.index, end: part.index + part.segment.length }))
  } catch { /* fall through */ }
  const segments: Array<{ start: number; end: number }> = []
  const expression = /[^.!?]+(?:[.!?]+(?:[”’"')\]]+)?|$)/gu
  let match: RegExpExecArray | null
  while ((match = expression.exec(text)) !== null) if (match[0].trim()) segments.push({ start: match.index, end: match.index + match[0].length })
  return segments.length ? segments : text.trim() ? [{ start: 0, end: text.length }] : []
}

function wordSegments(text: string): Array<{ text: string; index: number }> {
  try {
    const Segmenter = Intl.Segmenter
    if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'word' }).segment(text), (part) => ({ text: part.segment, index: part.index }))
  } catch { /* fall through */ }
  const result: Array<{ text: string; index: number }> = []
  const expression = /\s+|[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\s]/gu
  let match: RegExpExecArray | null
  while ((match = expression.exec(text)) !== null) result.push({ text: match[0], index: match.index })
  return result
}

function tokenSeparator(previous: PositionedToken | undefined, current: ReadingFragment, lineIndex: number): string {
  if (!previous) return ''
  if (/^[,.;:!?%)\]}]/u.test(current.text) || /[([{]$/u.test(previous.text)) return ''
  if (previous.lineIndex !== lineIndex && /[-‐‑]$/u.test(previous.text)) return ''
  return current.leadingSpace || previous.lineIndex !== lineIndex ? ' ' : ' '
}

function unitDistance(unit: ReadingUnit, x: number, y: number): number {
  return Math.min(...unit.rects.map((rect) => Math.hypot(rect.x + rect.width / 2 - x, rect.y + rect.height / 2 - y)))
}

function bounds(rects: ReadingRect[]): ReadingRect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function verticalOverlap(a: ReadingRect, b: ReadingRect): number {
  const overlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return overlap / Math.max(.00001, Math.min(a.height, b.height))
}

function horizontalOverlap(a: ReadingRect, b: ReadingRect): number {
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  return overlap / Math.max(.00001, Math.min(a.width, b.width))
}

function validRect(rect: ReadingRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0 && rect.width <= 1 && rect.height <= .25
    && rect.x >= 0 && rect.y >= 0 && rect.x < 1 && rect.y < 1
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)) }
