import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { ReflowTypographySettings, SemanticBlock, SemanticDocument, SemanticSourceSpan } from '../../../shared/types'
import { createSemanticDocument, extractSemanticPage, removeRecurringPageFurniture, replaceSemanticPage, semanticCacheMatches, type SemanticTextItem } from '../semantic-reflow'

interface SemanticReflowProps {
  pdf: PDFDocumentProxy
  sessionId: string
  documentId: string
  fingerprint: string
  documentName: string
  currentPage: number
  query: string
  typography: ReflowTypographySettings
  onTypography: (settings: ReflowTypographySettings) => void
  onPage: (page: number) => void
  onSource: (page: number) => void
  onDocument: (document: SemanticDocument) => void
}

interface StructureNode { role: string; children: Array<StructureNode | { id: string }> }

export function SemanticReflow(props: SemanticReflowProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<SemanticDocument | null>(null)
  const selfPageRef = useRef<number | null>(null)
  const currentPageRef = useRef(props.currentPage)
  const onPageRef = useRef(props.onPage)
  const alignedPageRef = useRef<number | null>(null)
  const scrollSyncHoldRef = useRef(0)
  const userScrollIntentUntilRef = useRef(0)
  const extractionCompleteRef = useRef(false)
  const [semantic, setSemantic] = useState<SemanticDocument | null>(null)
  const [status, setStatus] = useState('Preparing semantic view…')
  currentPageRef.current = props.currentPage
  onPageRef.current = props.onPage

  const publishSemantic = (next: SemanticDocument): void => {
    const revision = holdScrollSync(scrollSyncHoldRef)
    setSemantic(next)
    releaseScrollSync(scrollSyncHoldRef, revision)
  }

  useEffect(() => {
    let cancelled = false
    documentRef.current = null
    alignedPageRef.current = null
    selfPageRef.current = null
    extractionCompleteRef.current = false
    setSemantic(null)
    setStatus('Preparing semantic view…')
    void (async () => {
      const cached = await window.koibill.getReflowCache(props.sessionId)
      if (cancelled) return
      let next = semanticCacheMatches(cached, props.fingerprint, props.pdf.numPages)
        ? cached
        : createSemanticDocument(props.fingerprint, props.documentName, props.pdf.numPages)
      documentRef.current = next
      extractionCompleteRef.current = next.completedPages.length === next.pageCount
      setSemantic(next)
      props.onDocument(next)
      const pending = priorityPages(props.pdf.numPages, props.currentPage).filter((page) => !next.completedPages.includes(page))
      if (!pending.length) { extractionCompleteRef.current = true; setStatus(''); return }
      let completedSinceSave = 0
      for (const pageNumber of pending) {
        if (cancelled) return
        setStatus(`Reflowing page ${pageNumber} of ${props.pdf.numPages}…`)
        try {
          const page = await props.pdf.getPage(pageNumber)
          const [content, tree] = await Promise.all([
            page.getTextContent({ includeMarkedContent: true }),
            page.getStructTree().catch(() => null),
          ])
          const blocks = extractSemanticPage(pageNumber, semanticItems(page, content.items, tree))
          next = replaceSemanticPage(next, pageNumber, blocks)
          documentRef.current = next
          publishSemantic(next)
          props.onDocument(next)
          completedSinceSave += 1
          if (completedSinceSave >= 5) { completedSinceSave = 0; await window.koibill.saveReflowCache(props.sessionId, next) }
        } catch (error) {
          console.warn(`Unable to reflow page ${pageNumber}`, error)
          next = replaceSemanticPage(next, pageNumber, [])
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
      if (!cancelled) {
        next = removeRecurringPageFurniture(next)
        documentRef.current = next; publishSemantic(next); props.onDocument(next)
        await window.koibill.saveReflowCache(props.sessionId, next)
        extractionCompleteRef.current = true
        setStatus('')
      }
    })().catch((error) => { if (!cancelled) setStatus(`Semantic reflow failed: ${String(error)}`) })
    return () => { cancelled = true }
  }, [props.pdf, props.sessionId, props.fingerprint, props.documentName])

  useEffect(() => {
    if (selfPageRef.current === props.currentPage) {
      selfPageRef.current = null
      alignedPageRef.current = props.currentPage
      return
    }
    if (alignedPageRef.current === props.currentPage) return
    const block = semantic?.blocks.find((item) => item.sourceSpans.some((span) => span.pageNumber === props.currentPage))
    const element = block ? document.getElementById(`reflow-${props.documentId}-${block.id}`) : null
    if (!element) return
    alignedPageRef.current = props.currentPage
    const revision = holdScrollSync(scrollSyncHoldRef)
    element.scrollIntoView({ block: 'center', behavior: 'auto' })
    releaseScrollSync(scrollSyncHoldRef, revision)
  }, [props.currentPage, props.documentId, semantic?.blocks.length])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !semantic?.blocks.length) return
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (scrollSyncHoldRef.current || (!extractionCompleteRef.current && Date.now() > userScrollIntentUntilRef.current)) return
        const rect = host.getBoundingClientRect()
        const center = rect.top + rect.height * .42
        const blocks = Array.from(host.querySelectorAll<HTMLElement>('[data-semantic-block]'))
        const active = blocks.reduce<HTMLElement | null>((nearest, block) => !nearest || Math.abs(block.getBoundingClientRect().top - center) < Math.abs(nearest.getBoundingClientRect().top - center) ? block : nearest, null)
        const page = Number(active?.dataset.pageNumber)
        if (Number.isInteger(page) && page !== currentPageRef.current) { selfPageRef.current = page; onPageRef.current(page) }
      })
    }
    const markUserScrollIntent = (): void => { userScrollIntentUntilRef.current = Date.now() + 1_000 }
    host.addEventListener('scroll', update, { passive: true })
    host.addEventListener('wheel', markUserScrollIntent, { passive: true })
    host.addEventListener('touchmove', markUserScrollIntent, { passive: true })
    host.addEventListener('pointerdown', markUserScrollIntent)
    host.addEventListener('keydown', markUserScrollIntent)
    return () => {
      cancelAnimationFrame(frame); host.removeEventListener('scroll', update)
      host.removeEventListener('wheel', markUserScrollIntent); host.removeEventListener('touchmove', markUserScrollIntent)
      host.removeEventListener('pointerdown', markUserScrollIntent); host.removeEventListener('keydown', markUserScrollIntent)
    }
  }, [semantic !== null])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let accumulated = 0
    let frame = 0
    const commit = (): void => {
      frame = 0
      const direction = Math.sign(accumulated); accumulated = 0
      if (!direction) return
      props.onTypography({ ...props.typography, fontScale: Math.min(1.6, Math.max(.8, props.typography.fontScale - direction * .05)) })
    }
    const wheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault(); accumulated += event.deltaY
      if (!frame) frame = requestAnimationFrame(commit)
    }
    host.addEventListener('wheel', wheel, { passive: false })
    return () => { host.removeEventListener('wheel', wheel); cancelAnimationFrame(frame) }
  }, [props.typography, props.onTypography])

  const contextMenu = (event: React.MouseEvent): void => {
    const selection = window.getSelection()
    const text = selection?.toString().trim() ?? ''
    if (!selection || selection.isCollapsed || !text || text.length > 20_000 || !semantic) return
    const range = selection.getRangeAt(0)
    const selected = semantic.blocks.filter((block) => {
      const node = document.getElementById(`reflow-${props.documentId}-${block.id}`)
      return node ? range.intersectsNode(node) : false
    })
    const spans = selected.flatMap((block) => block.sourceSpans)
    if (!spans.length) return
    event.preventDefault()
    const pages = spans.map((span) => span.pageNumber)
    window.koibill.showSelectionMenu({
      kind: 'selection', text, documentId: props.documentId, sourceFingerprint: props.fingerprint,
      documentName: props.documentName, pageNumber: Math.min(...pages), endPageNumber: Math.max(...pages), sourceSpans: spans,
      reflow: true,
    })
  }

  const style = { '--reflow-font-scale': props.typography.fontScale, '--reflow-line-height': props.typography.lineHeight, '--reflow-measure': `${props.typography.measure}ch` } as CSSProperties
  const blocks = useMemo(() => semantic?.blocks ?? [], [semantic])
  const noText = semantic && semantic.completedPages.length === semantic.pageCount && blocks.every((block) => !block.text)
  return <div ref={hostRef} className="semantic-reflow" style={style} onContextMenu={contextMenu}>
    <article className="semantic-article" aria-label={`Semantic reading view for ${props.documentName}`}>
      <header className="semantic-document-header"><span>Semantic reflow</span><small>{semantic ? `${semantic.completedPages.length}/${semantic.pageCount} pages` : ''}</small></header>
      {noText ? <div className="reflow-empty"><h2>No extractable text</h2><p>This appears to be a scanned or unsupported PDF. OCR is not included; use Original view.</p></div> : blocks.map((block) => <SemanticBlockView key={block.id} block={block} documentId={props.documentId} query={props.query} getPage={(page) => props.pdf.getPage(page)} onSource={props.onSource}/>) }
      {status && <div className="reflow-status" role="status">{status}</div>}
    </article>
  </div>
}

function SemanticBlockView({ block, documentId, query, getPage, onSource }: { block: SemanticBlock; documentId: string; query: string; getPage: (page: number) => Promise<PDFPageProxy>; onSource: (page: number) => void }): React.JSX.Element {
  const page = block.sourceSpans[0]?.pageNumber ?? 1
  const content = highlightText(block.text, query)
  const common = { id: `reflow-${documentId}-${block.id}`, 'data-semantic-block': true, 'data-page-number': page, className: `semantic-block semantic-${block.type} ${block.confidence < .58 ? 'low-confidence' : ''}` }
  const source = <button className="semantic-source" title={`Show page ${page} in the original PDF`} onClick={() => onSource(page)}>p. {page} <ExternalLink size={11}/></button>
  const warning = block.confidence < .58 ? <span className="semantic-warning" title="The inferred reading order or block type may be uncertain"><AlertTriangle size={12}/> Check order</span> : null
  if (block.type === 'figure' && block.asset) return <figure {...common}><AssetCrop asset={block.asset} getPage={getPage}/>{source}{warning}</figure>
  if (block.type === 'caption') return <figcaption {...common}>{content}{source}{warning}</figcaption>
  if (block.type === 'title') return <h1 {...common}>{content}{source}{warning}</h1>
  if (block.type === 'heading') {
    const Tag = (`h${Math.min(6, Math.max(2, block.level ?? 2))}`) as keyof React.JSX.IntrinsicElements
    return <Tag {...common}>{content}{source}{warning}</Tag>
  }
  if (block.type === 'list-item') return <div {...common} role="listitem"><span className="semantic-bullet">•</span><p>{content}</p>{source}{warning}</div>
  if (block.type === 'table' || block.type === 'equation') return <div {...common}>{block.asset && <AssetCrop asset={block.asset} getPage={getPage}/>}<pre>{content}</pre>{source}{warning}</div>
  return <p {...common}>{content}{source}{warning}</p>
}

function AssetCrop({ asset, getPage }: { asset: NonNullable<SemanticBlock['asset']>; getPage: (page: number) => Promise<PDFPageProxy> }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<PDFPageProxy['render']> | undefined
    void getPage(asset.pageNumber).then(async (page) => {
      if (cancelled) return
      const viewport = page.getViewport({ scale: 1.25 })
      const source = document.createElement('canvas')
      source.width = Math.ceil(viewport.width); source.height = Math.ceil(viewport.height)
      const context = source.getContext('2d'); if (!context) return
      task = page.render({ canvas: source, canvasContext: context, viewport })
      await task.promise
      const target = canvasRef.current; if (!target || cancelled) return
      const sx = asset.rect.x * source.width; const sy = asset.rect.y * source.height
      const sw = Math.max(1, asset.rect.width * source.width); const sh = Math.max(1, asset.rect.height * source.height)
      target.width = Math.min(1200, Math.ceil(sw)); target.height = Math.min(800, Math.ceil(sh))
      target.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, target.width, target.height)
    }).catch(() => undefined)
    return () => { cancelled = true; task?.cancel() }
  }, [asset, getPage])
  return <canvas ref={canvasRef} className="semantic-asset" aria-label={`${asset.kind} from page ${asset.pageNumber}`}/>
}

function semanticItems(page: PDFPageProxy, values: unknown[], tree: StructureNode | null): SemanticTextItem[] {
  const viewport = page.getViewport({ scale: 1 })
  const roles = structureRoles(tree)
  const marked: string[] = []
  const result: SemanticTextItem[] = []
  for (const raw of values) {
    const item = raw as Record<string, unknown>
    if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') { marked.push(typeof item.id === 'string' ? item.id : ''); continue }
    if (item.type === 'endMarkedContent') { marked.pop(); continue }
    if (typeof item.str !== 'string' || !Array.isArray(item.transform)) continue
    const transform = item.transform as number[]
    const x = Number(transform[4]); const y = Number(transform[5]); const width = Math.max(Number(item.width) || 0, Math.abs(Number(transform[0]) || 0)); const height = Math.max(Number(item.height) || 0, Math.abs(Number(transform[3]) || 0), 1)
    const points = [viewport.convertToViewportPoint(x, y), viewport.convertToViewportPoint(x + width, y + height)]
    const left = Math.min(points[0][0], points[1][0]); const top = Math.min(points[0][1], points[1][1]); const right = Math.max(points[0][0], points[1][0]); const bottom = Math.max(points[0][1], points[1][1])
    result.push({
      text: item.str,
      rect: { x: clamp(left / viewport.width), y: clamp(top / viewport.height), width: clamp((right - left) / viewport.width), height: clamp((bottom - top) / viewport.height) },
      fontSize: Math.max(1, Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0)),
      fontName: typeof item.fontName === 'string' ? item.fontName : undefined,
      hasEOL: item.hasEOL === true,
      role: [...marked].reverse().map((id) => roles.get(id)).find(Boolean),
    })
  }
  return result
}

function structureRoles(tree: StructureNode | null): Map<string, string> {
  const roles = new Map<string, string>()
  const visit = (node: StructureNode, inherited?: string): void => {
    const role = node.role || inherited
    node.children.forEach((child) => {
      if ('id' in child) { if (role) roles.set(child.id, role) }
      else visit(child, role)
    })
  }
  if (tree) visit(tree)
  return roles
}

function priorityPages(count: number, active: number): number[] {
  const pages = Array.from({ length: count }, (_, index) => index + 1)
  return pages.sort((a, b) => Math.abs(a - active) - Math.abs(b - active) || a - b)
}

function holdScrollSync(reference: { current: number }): number {
  reference.current += 1
  return reference.current
}

function releaseScrollSync(reference: { current: number }, revision: number): void {
  requestAnimationFrame(() => { if (reference.current === revision) reference.current = 0 })
}

function highlightText(text: string, query: string): React.ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'giu'))
  return parts.map((part, index) => part.toLocaleLowerCase() === needle.toLocaleLowerCase() ? <mark key={index}>{part}</mark> : part)
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
function clamp(value: number): number { return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) }
