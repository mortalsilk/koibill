import type { NormalizedRect, SemanticBlock, SemanticBlockType, SemanticDocument } from '../../shared/types'

export const REFLOW_EXTRACTOR_VERSION = '1.0.0'

export interface SemanticTextItem {
  text: string
  rect: NormalizedRect
  fontSize: number
  fontName?: string
  hasEOL?: boolean
  role?: string
}

interface Line {
  items: SemanticTextItem[]
  text: string
  rect: NormalizedRect
  fontSize: number
  role?: string
}

export function createSemanticDocument(fingerprint: string, filename: string, pageCount: number): SemanticDocument {
  return { schemaVersion: 1, extractorVersion: REFLOW_EXTRACTOR_VERSION, sourceFingerprint: fingerprint, sourceFilename: filename, pageCount, completedPages: [], blocks: [], modifiedAt: new Date().toISOString() }
}

export function semanticCacheMatches(document: SemanticDocument | null, fingerprint: string, pageCount: number): document is SemanticDocument {
  return Boolean(document && document.extractorVersion === REFLOW_EXTRACTOR_VERSION
    && document.sourceFingerprint === fingerprint && document.pageCount === pageCount)
}

export function replaceSemanticPage(document: SemanticDocument, pageNumber: number, blocks: SemanticBlock[]): SemanticDocument {
  const remaining = document.blocks.filter((block) => block.sourceSpans[0]?.pageNumber !== pageNumber)
  return {
    ...document,
    completedPages: [...new Set([...document.completedPages, pageNumber])].sort((a, b) => a - b),
    blocks: [...remaining, ...blocks].sort(blockOrder),
    modifiedAt: new Date().toISOString(),
  }
}

export function removeRecurringPageFurniture(document: SemanticDocument): SemanticDocument {
  const occurrences = new Map<string, Set<number>>()
  for (const block of document.blocks) {
    const span = block.sourceSpans[0]
    if (!span || !span.rects.some((rect) => rect.y < .075 || rect.y + rect.height > .925)) continue
    const key = furnitureKey(block.text)
    if (!key || key.length > 160) continue
    const pages = occurrences.get(key) ?? new Set<number>()
    pages.add(span.pageNumber); occurrences.set(key, pages)
  }
  const threshold = Math.max(3, Math.ceil(document.pageCount * .2))
  const recurring = new Set([...occurrences].filter(([, pages]) => pages.size >= threshold).map(([key]) => key))
  if (!recurring.size) return document
  return { ...document, blocks: document.blocks.filter((block) => !recurring.has(furnitureKey(block.text))), modifiedAt: new Date().toISOString() }
}

export function extractSemanticPage(pageNumber: number, source: SemanticTextItem[], medianFontSize?: number): SemanticBlock[] {
  const items = source.filter((item) => item.text.trim() && validRect(item.rect) && !verticalText(item))
  if (!items.length) return []
  const lines = orderLines(groupLines(items))
  const bodySize = medianFontSize ?? median(lines.map((line) => line.fontSize))
  const contentLines = lines.filter((line) => !likelyPageFurniture(line, pageNumber))
  const groups: Line[][] = []
  for (const line of contentLines) {
    const previous = groups.at(-1)?.at(-1)
    if (!previous || startsNewBlock(previous, line, bodySize)) groups.push([line])
    else groups.at(-1)!.push(line)
  }
  const blocks: SemanticBlock[] = []
  groups.forEach((group, index) => {
    const first = group[0]
    const role = normalizedRole(group.map((line) => line.role).find(Boolean))
    const type = classifyBlock(group, role, bodySize)
    const text = joinLines(group)
    if (!text) return
    const rects = mergeRects(group.map((line) => line.rect))
    const confidence = confidenceFor(type, role, group, bodySize)
    if (type === 'caption' && looksLikeFigureCaption(text)) {
      const caption = bounds(rects)
      const top = Math.max(.02, caption.y - Math.min(.42, Math.max(.14, caption.y * .7)))
      const assetRect = { x: Math.max(.02, caption.x - .02), y: top, width: Math.min(.96, caption.width + .04), height: Math.max(.08, caption.y - top - .01) }
      blocks.push(makeBlock(pageNumber, index * 2, 'figure', '', Math.min(.82, confidence), [assetRect], { pageNumber, rect: assetRect, kind: 'figure' }))
    }
    const asset = (type === 'table' || type === 'equation') && confidence >= .8
      ? { pageNumber, rect: paddedBounds(rects), kind: type } as const
      : undefined
    blocks.push(makeBlock(pageNumber, index * 2 + 1, type, text, confidence, rects, asset, headingLevel(type, first.fontSize, bodySize, first.role)))
  })
  return blocks
}

function makeBlock(pageNumber: number, index: number, type: SemanticBlockType, text: string, confidence: number, rects: NormalizedRect[], asset?: SemanticBlock['asset'], level?: number): SemanticBlock {
  return {
    id: `p${pageNumber}-b${index}`,
    type, text, confidence, level, asset,
    sourceSpans: [{ pageNumber, rects, start: 0, end: text.length }],
  }
}

function groupLines(items: SemanticTextItem[]): Line[] {
  const ordered = [...items].sort((a, b) => Math.abs(a.rect.y - b.rect.y) < Math.max(a.rect.height, b.rect.height) * .45 ? a.rect.x - b.rect.x : a.rect.y - b.rect.y)
  const lines: Line[] = []
  for (const item of ordered) {
    let target = lines.find((line) => verticalOverlap(line.rect, item.rect) >= .42
      && Math.abs(line.rect.y - item.rect.y) <= Math.max(line.rect.height, item.rect.height)
      && item.rect.x - line.rect.x - line.rect.width <= .09)
    if (!target) {
      target = { items: [], text: '', rect: { ...item.rect }, fontSize: item.fontSize, role: item.role }
      lines.push(target)
    }
    target.items.push(item)
    target.items.sort((a, b) => a.rect.x - b.rect.x)
    target.rect = bounds(target.items.map((entry) => entry.rect))
    target.fontSize = median(target.items.map((entry) => entry.fontSize))
    target.role ||= item.role
    target.text = joinItems(target.items)
  }
  return lines
}

function orderLines(lines: Line[]): Line[] {
  const narrow = lines.filter((line) => line.rect.width < .57)
  const left = narrow.filter((line) => line.rect.x < .46)
  const right = narrow.filter((line) => line.rect.x > .42)
  const twoColumns = left.length >= 3 && right.length >= 3
  if (!twoColumns) return [...lines].sort(yThenX)
  const spanning = lines.filter((line) => line.rect.width >= .57)
  const firstColumnTop = Math.min(...left.map((line) => line.rect.y))
  return [
    ...spanning.filter((line) => line.rect.y < firstColumnTop).sort(yThenX),
    ...left.sort(yThenX),
    ...right.sort(yThenX),
    ...spanning.filter((line) => line.rect.y >= firstColumnTop).sort(yThenX),
  ].filter((line, index, all) => all.indexOf(line) === index)
}

function startsNewBlock(previous: Line, next: Line, bodySize: number): boolean {
  const role = normalizedRole(next.role)
  if (role && ['title', 'heading', 'caption', 'list-item', 'table'].includes(role)) return true
  const previousRole = normalizedRole(previous.role)
  if (previousRole && ['title', 'heading', 'caption'].includes(previousRole)) return true
  const gap = next.rect.y - previous.rect.y - previous.rect.height
  const sameColumn = horizontalOverlap(previous.rect, next.rect) > .12 || Math.abs(previous.rect.x - next.rect.x) < .08
  const fontShift = Math.abs(next.fontSize - previous.fontSize) > Math.max(1, bodySize * .16)
  const indent = next.rect.x - previous.rect.x > Math.max(.025, previous.rect.height * 1.8)
  return !sameColumn || gap > Math.max(previous.rect.height, next.rect.height) * .9 || fontShift || (indent && /[.!?][”’"']?$/u.test(previous.text))
}

function classifyBlock(lines: Line[], role: string | undefined, bodySize: number): SemanticBlockType {
  if (role === 'title') return 'title'
  if (role === 'heading') return 'heading'
  if (role === 'caption') return 'caption'
  if (role === 'list-item') return 'list-item'
  if (role === 'table') return 'table'
  if (role === 'figure') return 'figure'
  const text = joinLines(lines)
  const size = median(lines.map((line) => line.fontSize))
  if (looksLikeFigureCaption(text)) return 'caption'
  if (/^(?:[-•▪◦*]|\(?\d+[.)]|[a-zA-Z][.)])\s+/u.test(text)) return 'list-item'
  if (size >= bodySize * 1.5 && text.length < 180) return lines[0].rect.y < .24 ? 'title' : 'heading'
  if (size >= bodySize * 1.18 && text.length < 180 && !/[.!?]$/u.test(text)) return 'heading'
  if (tableLike(lines)) return 'table'
  if (equationLike(text)) return 'equation'
  return 'paragraph'
}

function normalizedRole(role?: string): string | undefined {
  if (!role) return undefined
  const value = role.toLowerCase()
  if (value === 'title' || value === 'documenttitle') return 'title'
  if (/^h[1-6]$/u.test(value) || value === 'heading' || value === 'sect') return 'heading'
  if (value === 'caption' || value === 'figcaption') return 'caption'
  if (value === 'li' || value === 'lbody' || value === 'lbl') return 'list-item'
  if (value === 'table' || value === 'tr' || value === 'td' || value === 'th') return 'table'
  if (value === 'figure' || value === 'fig') return 'figure'
  if (value === 'formula' || value === 'equation') return 'equation'
  return undefined
}

function confidenceFor(type: SemanticBlockType, role: string | undefined, lines: Line[], bodySize: number): number {
  if (role) return .96
  let value = .7
  if (type === 'paragraph' && lines.length > 1) value += .12
  if ((type === 'heading' || type === 'title') && median(lines.map((line) => line.fontSize)) > bodySize * 1.18) value += .1
  if (type === 'caption' && looksLikeFigureCaption(joinLines(lines))) value += .12
  if (lines.some((line) => line.rect.width > .92 || line.rect.height > .12)) value -= .2
  return Math.min(.92, Math.max(.35, value))
}

function headingLevel(type: SemanticBlockType, size: number, bodySize: number, role?: string): number | undefined {
  if (type !== 'heading' && type !== 'title') return undefined
  const tagged = role?.match(/^h([1-6])$/iu)
  if (tagged) return Number(tagged[1])
  if (type === 'title' || size >= bodySize * 1.65) return 1
  if (size >= bodySize * 1.35) return 2
  return 3
}

function joinItems(items: SemanticTextItem[]): string {
  let text = ''
  items.forEach((item, index) => {
    const previous = items[index - 1]
    const gap = previous ? item.rect.x - previous.rect.x - previous.rect.width : 0
    const separator = !previous || /^[,.;:!?%)\]}]/u.test(item.text) || /[([{]$/u.test(previous.text) ? '' : gap > -.004 ? ' ' : ''
    text += separator + item.text
  })
  return text.replace(/\s+/gu, ' ').trim()
}

function joinLines(lines: Line[]): string {
  let text = ''
  lines.forEach((line, index) => {
    const previous = lines[index - 1]
    if (!previous) { text = line.text; return }
    if (/[-‐‑]$/u.test(text) && /^[\p{Ll}\p{M}]/u.test(line.text)) text = text.slice(0, -1) + line.text
    else text += ` ${line.text}`
  })
  return text.replace(/\s+([,.;:!?%])/gu, '$1').trim()
}

function likelyPageFurniture(line: Line, pageNumber: number): boolean {
  const text = line.text.trim()
  return (line.rect.y < .035 || line.rect.y > .955) && (text === String(pageNumber) || text.length < 5)
}

function furnitureKey(text: string): string { return text.toLocaleLowerCase().replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim() }
function paddedBounds(rects: NormalizedRect[]): NormalizedRect { const rect = bounds(rects); const x = Math.max(0, rect.x - .012); const y = Math.max(0, rect.y - .012); return { x, y, width: Math.min(1 - x, rect.width + .024), height: Math.min(1 - y, rect.height + .024) } }

function looksLikeFigureCaption(text: string): boolean { return /^(?:fig(?:ure)?|table|chart|diagram)\s*[.:]?\s*\d+/iu.test(text.trim()) }
function equationLike(text: string): boolean { return text.length < 220 && /[=∑∫√≈≤≥]/u.test(text) && /[\p{L}\p{N}]/u.test(text) }
function tableLike(lines: Line[]): boolean { return lines.length >= 2 && lines.filter((line) => /\s{2,}|\t/u.test(line.text)).length >= Math.ceil(lines.length / 2) }
function verticalText(item: SemanticTextItem): boolean { return item.rect.height > item.rect.width * 4 && item.text.length > 2 }
function validRect(rect: NormalizedRect): boolean { return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1.02 && rect.y + rect.height <= 1.02 }
function blockOrder(a: SemanticBlock, b: SemanticBlock): number { return (a.sourceSpans[0]?.pageNumber ?? 0) - (b.sourceSpans[0]?.pageNumber ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }) }
function yThenX(a: Line, b: Line): number { return a.rect.y - b.rect.y || a.rect.x - b.rect.x }
function median(values: number[]): number { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return 1; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
function bounds(rects: NormalizedRect[]): NormalizedRect { const x = Math.min(...rects.map((r) => r.x)); const y = Math.min(...rects.map((r) => r.y)); const right = Math.max(...rects.map((r) => r.x + r.width)); const bottom = Math.max(...rects.map((r) => r.y + r.height)); return { x, y, width: right - x, height: bottom - y } }
function mergeRects(rects: NormalizedRect[]): NormalizedRect[] { return rects.reduce<NormalizedRect[]>((all, rect) => { const previous = all.at(-1); if (previous && verticalOverlap(previous, rect) > .55 && rect.x - previous.x - previous.width < .025) { const right = Math.max(previous.x + previous.width, rect.x + rect.width); previous.width = right - previous.x; previous.y = Math.min(previous.y, rect.y); previous.height = Math.max(previous.y + previous.height, rect.y + rect.height) - previous.y } else all.push({ ...rect }); return all }, []) }
function verticalOverlap(a: NormalizedRect, b: NormalizedRect): number { return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) / Math.max(.0001, Math.min(a.height, b.height)) }
function horizontalOverlap(a: NormalizedRect, b: NormalizedRect): number { return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) / Math.max(.0001, Math.min(a.width, b.width)) }
