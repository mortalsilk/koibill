import type { Annotation, AnnotationDocument, AskAIRequest, BrowserBounds, BrowserCommand, GraphDocument, ResearchTrayItem, SemanticDocument, SemanticSourceSpan, WorkspaceUiState } from './types'
import { detectAIProvider, isAIConversationUrl, isAIProviderId } from './ai-providers'

export function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.href === 'about:blank'
  } catch {
    return false
  }
}

export function normalizeNavigation(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'about:blank') return 'about:blank'
  if (/^https:\/\//i.test(trimmed)) return isSafeWebUrl(trimmed) ? trimmed : 'about:blank'
  if (/\s/.test(trimmed) || !trimmed.includes('.')) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
  const candidate = `https://${trimmed}`
  return isSafeWebUrl(candidate) ? candidate : 'about:blank'
}

export function isChatGptAuthCompletion(previousUrl: string, nextUrl: string): boolean {
  try {
    const previous = new URL(previousUrl)
    const next = new URL(nextUrl)
    const isChatGptHost = (hostname: string): boolean => hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
    return isChatGptHost(previous.hostname)
      && previous.pathname.startsWith('/auth')
      && isChatGptHost(next.hostname)
      && !next.pathname.startsWith('/auth')
  } catch {
    return false
  }
}

export function isBrowserBounds(value: unknown): value is BrowserBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))
    && Number(bounds.width) >= 0
    && Number(bounds.height) >= 0
}

export function isAskAIRequest(value: unknown): value is AskAIRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (typeof request.requestId !== 'string' || !request.requestId || !isAIProviderId(request.provider)
    || (request.mode !== 'draft' && request.mode !== 'send')) return false
  if (!Array.isArray(request.linkTargets) || request.linkTargets.length > 500 || !request.linkTargets.every(isAnnotationReference)) return false
  if (request.kind === 'selection') {
    return typeof request.text === 'string'
      && request.text.length > 0
      && request.text.length <= 20_000
      && typeof request.documentName === 'string'
      && Number.isInteger(request.pageNumber)
      && Number(request.pageNumber) > 0
      && optionalPageRange(request.endPageNumber, Number(request.pageNumber))
      && optionalSourceSpans(request.sourceSpans)
  }
  return request.kind === 'research'
    && typeof request.question === 'string'
    && request.question.length <= 20_000
    && Array.isArray(request.items)
    && request.items.length > 0
    && request.items.length <= 500
    && request.items.every(isResearchTrayItem)
}

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  if (typeof command.type !== 'string') return false
  if (command.type === 'new-tab') return command.url === undefined || typeof command.url === 'string'
  if (command.type === 'external-url') return typeof command.url === 'string' && isSafeWebUrl(command.url)
  if (command.type === 'activate-or-open') return (command.tabId === undefined || typeof command.tabId === 'string')
    && typeof command.url === 'string' && isAIConversationUrl(command.url)
  if (typeof command.tabId !== 'string') return false
  if (command.type === 'move') return command.direction === -1 || command.direction === 1
  if (command.type === 'navigate') return typeof command.value === 'string'
  return ['activate', 'close', 'back', 'forward', 'reload', 'stop', 'external', 'zoom-in', 'zoom-out', 'zoom-reset', 'recover'].includes(command.type)
}

export function isAnnotationDocument(value: unknown): value is AnnotationDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<AnnotationDocument>
  return document.schemaVersion === 2
    && typeof document.sourceFingerprint === 'string'
    && typeof document.sourceFilename === 'string'
    && typeof document.modifiedAt === 'string'
    && Array.isArray(document.pages)
    && document.pages.every((page) => Number.isFinite(page.width) && Number.isFinite(page.height) && Number.isFinite(page.rotation))
    && Array.isArray(document.annotations)
    && document.annotations.length < 100_000
    && document.annotations.every(isAnnotation)
}

export function migrateAnnotationDocument(value: unknown): AnnotationDocument | null {
  if (!value || typeof value !== 'object') return null
  const document = value as Record<string, unknown>
  if ((document.schemaVersion !== 1 && document.schemaVersion !== 2)
    || typeof document.sourceFingerprint !== 'string'
    || typeof document.sourceFilename !== 'string'
    || typeof document.modifiedAt !== 'string'
    || !Array.isArray(document.pages)
    || !Array.isArray(document.annotations)
    || document.annotations.length >= 100_000) return null
  const annotations = document.annotations.filter(isLegacyAnnotation).map((annotation) => ({
    ...annotation,
    note: typeof annotation.note === 'string' ? annotation.note.slice(0, 20_000) : undefined,
    conversationLinks: Array.isArray(annotation.conversationLinks)
      ? annotation.conversationLinks.flatMap(normalizeConversationLink)
      : [],
    ...(annotation.type === 'highlight' && typeof annotation.selectedText === 'string'
      ? { selectedText: annotation.selectedText.slice(0, 20_000) }
      : {}),
  })) as Annotation[]
  if (annotations.length !== document.annotations.length) return null
  return {
    schemaVersion: 2,
    sourceFingerprint: document.sourceFingerprint,
    sourceFilename: document.sourceFilename,
    modifiedAt: document.modifiedAt,
    pages: document.pages as AnnotationDocument['pages'],
    annotations,
  }
}

export function isResearchTrayItem(value: unknown): value is ResearchTrayItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.documentId === 'string'
    && typeof item.sourceFingerprint === 'string' && typeof item.documentName === 'string'
    && Number.isInteger(item.pageNumber) && Number(item.pageNumber) > 0
    && optionalPageRange(item.endPageNumber, Number(item.pageNumber))
    && optionalSourceSpans(item.sourceSpans)
    && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 20_000
    && (item.annotationId === undefined || typeof item.annotationId === 'string')
    && typeof item.createdAt === 'string'
}

export function isWorkspaceUiState(value: unknown): value is WorkspaceUiState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  const documentIds = state.documentIds
  const viewStates = state.viewStates
  return Array.isArray(documentIds) && documentIds.length <= 100
    && documentIds.every((id) => typeof id === 'string')
    && (state.activeDocumentId === null || typeof state.activeDocumentId === 'string')
    && Boolean(viewStates && typeof viewStates === 'object' && !Array.isArray(viewStates))
    && Object.entries(viewStates as Record<string, unknown>).every(([id, viewState]) => documentIds.includes(id) && isPdfViewState(viewState))
    && documentIds.every((id) => isPdfViewState((viewStates as Record<string, unknown>)[id]))
    && Array.isArray(state.tray) && state.tray.length <= 500 && state.tray.every(isResearchTrayItem)
    && typeof state.question === 'string' && state.question.length <= 20_000
}

export function isGraphDocument(value: unknown): value is GraphDocument {
  if (!value || typeof value !== 'object') return false
  const graph = value as Record<string, unknown>
  if (graph.schemaVersion !== 1 || typeof graph.sourceFingerprint !== 'string' || typeof graph.sourceFilename !== 'string'
    || typeof graph.modifiedAt !== 'string' || !isGraphViewport(graph.viewport)
    || !Array.isArray(graph.nodes) || graph.nodes.length > 10_000
    || !Array.isArray(graph.edges) || graph.edges.length > 20_000) return false
  const nodeIds = new Set<string>()
  for (const value of graph.nodes) {
    if (!value || typeof value !== 'object') return false
    const node = value as Record<string, unknown>
    if (typeof node.id !== 'string' || nodeIds.has(node.id) || !isGraphPosition(node.position)
      || typeof node.title !== 'string' || node.title.length > 500
      || typeof node.userText !== 'string' || node.userText.length > 100_000
      || typeof node.createdAt !== 'string' || typeof node.modifiedAt !== 'string'
      || !Array.isArray(node.sources) || node.sources.length > 500 || !node.sources.every(isGraphSource)) return false
    nodeIds.add(node.id)
  }
  return graph.edges.every((value) => {
    if (!value || typeof value !== 'object') return false
    const edge = value as Record<string, unknown>
    return typeof edge.id === 'string' && typeof edge.source === 'string' && nodeIds.has(edge.source)
      && typeof edge.target === 'string' && nodeIds.has(edge.target)
      && (edge.label === undefined || (typeof edge.label === 'string' && edge.label.length <= 200))
      && typeof edge.createdAt === 'string'
  })
}

function isGraphViewport(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const viewport = value as Record<string, unknown>
  return Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom)
    && Number(viewport.zoom) >= .05 && Number(viewport.zoom) <= 8
}

function isGraphPosition(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return Number.isFinite(position.x) && Number.isFinite(position.y)
    && Math.abs(Number(position.x)) <= 10_000_000 && Math.abs(Number(position.y)) <= 10_000_000
}

function isGraphSource(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  return typeof source.id === 'string' && ['pdf', 'chatgpt', 'ai', 'web'].includes(String(source.kind))
    && typeof source.excerpt === 'string' && source.excerpt.length > 0 && source.excerpt.length <= 20_000
    && Number.isInteger(source.pageNumber) && Number(source.pageNumber) > 0
    && optionalPageRange(source.endPageNumber, Number(source.pageNumber))
    && optionalSourceSpans(source.sourceSpans)
    && (source.url === undefined || (typeof source.url === 'string' && isSafeWebUrl(source.url) && source.url !== 'about:blank'))
    && (source.title === undefined || (typeof source.title === 'string' && source.title.length <= 500))
    && (source.browserTabId === undefined || typeof source.browserTabId === 'string')
    && (source.provider === undefined || isAIProviderId(source.provider))
    && typeof source.createdAt === 'string'
}

function isPdfViewState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return Number.isFinite(state.zoom) && Number(state.zoom) >= .25 && Number(state.zoom) <= 4
    && Number.isInteger(state.rotation) && [0, 90, 180, 270].includes(Number(state.rotation))
    && Number.isInteger(state.currentPage) && Number(state.currentPage) > 0
    && isPdfFocusSettings(state.focus) && isPdfReflowSettings(state.reflow)
}

function isPdfReflowSettings(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const reflow = value as Record<string, unknown>
  return ['original', 'reflow', 'split'].includes(String(reflow.mode))
    && Number(reflow.splitRatio) >= .25 && Number(reflow.splitRatio) <= .75
}

export function isSemanticDocument(value: unknown): value is SemanticDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Record<string, unknown>
  return document.schemaVersion === 1 && typeof document.extractorVersion === 'string'
    && typeof document.sourceFingerprint === 'string' && typeof document.sourceFilename === 'string'
    && Number.isInteger(document.pageCount) && Number(document.pageCount) > 0
    && Array.isArray(document.completedPages) && document.completedPages.every((page) => Number.isInteger(page) && Number(page) > 0)
    && Array.isArray(document.blocks) && document.blocks.length <= 500_000 && document.blocks.every(isSemanticBlock)
    && typeof document.modifiedAt === 'string'
}

function isSemanticBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const block = value as Record<string, unknown>
  return typeof block.id === 'string' && ['title', 'heading', 'paragraph', 'list-item', 'figure', 'caption', 'table', 'equation'].includes(String(block.type))
    && typeof block.text === 'string' && block.text.length <= 100_000
    && Number(block.confidence) >= 0 && Number(block.confidence) <= 1
    && Array.isArray(block.sourceSpans) && block.sourceSpans.length > 0 && block.sourceSpans.every(isSourceSpan)
    && (block.level === undefined || (Number.isInteger(block.level) && Number(block.level) >= 1 && Number(block.level) <= 6))
    && (block.asset === undefined || isSemanticAsset(block.asset))
}

function isSemanticAsset(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const asset = value as Record<string, unknown>
  return Number.isInteger(asset.pageNumber) && Number(asset.pageNumber) > 0
    && ['figure', 'table', 'equation'].includes(String(asset.kind))
    && Boolean(asset.rect && typeof asset.rect === 'object' && isNormalizedRect(asset.rect as Record<string, unknown>))
}

function optionalPageRange(value: unknown, start: number): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= start)
}

function optionalSourceSpans(value: unknown): value is SemanticSourceSpan[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= 10_000 && value.every(isSourceSpan))
}

function isSourceSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const span = value as Record<string, unknown>
  return Number.isInteger(span.pageNumber) && Number(span.pageNumber) > 0
    && Number.isInteger(span.start) && Number.isInteger(span.end) && Number(span.start) >= 0 && Number(span.end) >= Number(span.start)
    && Array.isArray(span.rects) && span.rects.length <= 1_000 && span.rects.every((rect) => Boolean(rect && typeof rect === 'object' && isNormalizedRect(rect as Record<string, unknown>)))
}

function isNormalizedRect(item: Record<string, unknown>): boolean {
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(item[key]))
    && Number(item.x) >= 0 && Number(item.y) >= 0 && Number(item.width) >= 0 && Number(item.height) >= 0
    && Number(item.x) + Number(item.width) <= 1.001 && Number(item.y) + Number(item.height) <= 1.001
}

function isPdfFocusSettings(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const focus = value as Record<string, unknown>
  return typeof focus.enabled === 'boolean'
    && ['line', 'sentence', 'paragraph'].includes(String(focus.unit))
    && Number.isFinite(focus.surroundingVisibility)
    && Number(focus.surroundingVisibility) >= .05
    && Number(focus.surroundingVisibility) <= .4
    && (focus.magnification === undefined || (Number.isFinite(focus.magnification) && Number(focus.magnification) >= 1.1 && Number(focus.magnification) <= 1.6))
}

export function isChatGptConversationUrl(value: string): boolean {
  return isAIConversationUrl(value, 'chatgpt')
}

function isAnnotationReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const reference = value as Record<string, unknown>
  return typeof reference.documentId === 'string' && typeof reference.annotationId === 'string'
}

function isConversationLink(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const link = value as Record<string, unknown>
  const provider = isAIProviderId(link.provider) ? link.provider : typeof link.url === 'string' ? detectAIProvider(link.url)?.id : undefined
  return typeof link.id === 'string' && typeof link.url === 'string' && Boolean(provider) && isAIConversationUrl(link.url, provider)
    && typeof link.title === 'string' && typeof link.createdAt === 'string'
    && (link.browserTabId === undefined || typeof link.browserTabId === 'string')
}

function normalizeConversationLink(value: unknown): NonNullable<Annotation['conversationLinks']> {
  if (!isConversationLink(value)) return []
  const link = value as Omit<NonNullable<Annotation['conversationLinks']>[number], 'provider'> & { provider?: unknown }
  const provider = isAIProviderId(link.provider) ? link.provider : detectAIProvider(link.url)!.id
  return [{ ...link, provider }]
}

function isLegacyAnnotation(value: unknown): value is Annotation & { note?: unknown; conversationLinks?: unknown; selectedText?: unknown } {
  if (!value || typeof value !== 'object') return false
  const annotation = value as Record<string, unknown>
  const base = typeof annotation.id === 'string' && Number.isInteger(annotation.pageIndex)
    && typeof annotation.color === 'string' && typeof annotation.opacity === 'number'
    && typeof annotation.createdAt === 'string'
  const point = (candidate: unknown): boolean => Boolean(candidate && typeof candidate === 'object'
    && Number.isFinite((candidate as Record<string, unknown>).x) && Number.isFinite((candidate as Record<string, unknown>).y))
  return base && ((annotation.type === 'highlight' && Array.isArray(annotation.rects)
    && annotation.rects.every((rect) => point(rect) && Number.isFinite((rect as Record<string, unknown>).width) && Number.isFinite((rect as Record<string, unknown>).height)))
    || (annotation.type === 'ink' && Array.isArray(annotation.points) && annotation.points.every(point) && typeof annotation.width === 'number'))
}

function isAnnotation(value: unknown): boolean {
  if (!isLegacyAnnotation(value)) return false
  return (value.note === undefined || (typeof value.note === 'string' && value.note.length <= 20_000))
    && (value.conversationLinks === undefined || (Array.isArray(value.conversationLinks) && value.conversationLinks.every(isConversationLink)))
}
