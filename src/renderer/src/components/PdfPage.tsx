import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { Annotation, InkAnnotation, NormalizedPoint, PageMetadata } from '../../../shared/types'
import { findAnnotationAt, normalizePdfPoint, normalizePdfRect } from '../annotations'
import { readingMapFromTextLayer, type PageReadingMap, type ReadingUnit } from '../pdf-reading-map'
import { focusLensLayout } from '../pdf-focus-lens'
import { isPdfRenderCancellation, observePdfRender } from '../pdf-render-lifecycle'

interface PdfPageProps {
  pageNumber: number
  pageMetadata?: PageMetadata
  shouldRender: boolean
  getPage: (pageNumber: number) => Promise<PDFPageProxy>
  scale: number
  rotation: number
  annotations: Annotation[]
  tool: 'select' | 'highlight' | 'pen' | 'eraser'
  highlightColor: string
  penColor: string
  penWidth: number
  documentId: string
  sourceFingerprint: string
  documentName: string
  selectedAnnotationId: string | null
  focusEnabled: boolean
  surroundingVisibility: number
  focusMagnification: number
  selectionActive: boolean
  activeReadingUnit: ReadingUnit | null
  onReadingMap: (map: PageReadingMap) => void
  onFocusAt: (pageNumber: number, x: number, y: number) => void
  onAdd: (annotation: Annotation) => void
  onRemove: (id: string) => void
  onSelectAnnotation: (id: string | null) => void
}

export function PdfPage(props: PdfPageProps): React.JSX.Element {
  const maskId = `spotlight-${useId().replace(/:/gu, '')}`
  const hostRef = useRef<HTMLDivElement>(null)
  const pageCanvasRef = useRef<HTMLCanvasElement>(null)
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null)
  const focusLensRef = useRef<HTMLCanvasElement>(null)
  const textLayerHostRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)
  const viewportRef = useRef<PageViewport | null>(null)
  const readingMapRef = useRef<PageReadingMap | null>(null)
  const draftRef = useRef<NormalizedPoint[] | null>(null)
  const [renderRevision, setRenderRevision] = useState(0)
  const [lensInteracting, setLensInteracting] = useState(false)
  const size = placeholderSize(props.pageMetadata, props.scale, props.rotation)

  useEffect(() => {
    if (!lensInteracting) return
    const release = (): void => setLensInteracting(false)
    window.addEventListener('pointerup', release, { once: true })
    window.addEventListener('pointercancel', release, { once: true })
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release) }
  }, [lensInteracting])

  useEffect(() => {
    if (!props.shouldRender) {
      pageRef.current = null
      viewportRef.current = null
      clearCanvas(pageCanvasRef.current)
      clearCanvas(annotationCanvasRef.current)
      clearCanvas(focusLensRef.current)
      textLayerHostRef.current?.replaceChildren()
      return
    }
    let cancelled = false
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined
    let renderPromise: Promise<boolean> | undefined
    let textLayerTask: TextLayerBuilder | undefined
    clearCanvas(focusLensRef.current)
    void props.getPage(props.pageNumber).then(async (page) => {
      if (cancelled) return
      pageRef.current = page
      const viewport = page.getViewport({ scale: props.scale, rotation: (page.rotate + props.rotation) % 360 })
      viewportRef.current = viewport
      hostRef.current?.style.setProperty('--user-unit', String(viewport.userUnit))
      drawAnnotations(annotationCanvasRef.current, viewport, props.annotations, props.pageNumber - 1)
      const canvas = pageCanvasRef.current
      const textLayerHost = textLayerHostRef.current
      if (!canvas || !textLayerHost) return
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const context = canvas.getContext('2d')
      if (!context) return
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      renderPromise = observePdfRender(renderTask.promise, () => cancelled, (error) => {
        if (!cancelled) console.error('Unable to render PDF page canvas', error)
      })
      textLayerTask = new TextLayerBuilder({
        pdfPage: page,
        onAppend: (layer: HTMLDivElement) => {
          if (!cancelled) textLayerHost.replaceChildren(layer)
        },
      })
      textLayerTask.div.style.setProperty('--scale-factor', String(viewport.scale))
      textLayerTask.div.style.setProperty('--user-unit', String(viewport.userUnit))
      await textLayerTask.render({ viewport } as Parameters<TextLayerBuilder['render']>[0])
      if (cancelled) return
      const rendered = await renderPromise
      if (cancelled || !rendered) return
      const readingMap = readingMapFromTextLayer(textLayerTask.div, hostRef.current ?? textLayerTask.div, props.pageNumber)
      readingMapRef.current = readingMap
      props.onReadingMap(readingMap)
      setRenderRevision((revision) => revision + 1)
    }).catch((error) => { if (!cancelled && !isPdfRenderCancellation(error)) console.error('Unable to render page', error) })
    return () => { cancelled = true; textLayerTask?.cancel(); renderTask?.cancel() }
  }, [props.shouldRender, props.getPage, props.pageNumber, props.scale, props.rotation, props.onReadingMap])

  useEffect(() => drawAnnotations(annotationCanvasRef.current, viewportRef.current, props.annotations, props.pageNumber - 1), [props.annotations, props.pageNumber])

  useEffect(() => {
    drawFocusLens(
      focusLensRef.current,
      pageCanvasRef.current,
      annotationCanvasRef.current,
      props.focusEnabled && props.activeReadingUnit?.pageNumber === props.pageNumber ? props.activeReadingUnit : null,
      props.focusMagnification,
      props.selectionActive || lensInteracting,
    )
  }, [props.focusEnabled, props.activeReadingUnit, props.focusMagnification, props.selectionActive, props.annotations, renderRevision, props.pageNumber, lensInteracting])

  const pagePoint = (event: React.PointerEvent<HTMLCanvasElement>): NormalizedPoint | null => {
    const viewport = viewportRef.current
    if (!viewport) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return normalizePdfPoint(viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top) as [number, number], viewport.viewBox as [number, number, number, number])
  }

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const point = pagePoint(event)
    if (!point) return
    if (props.tool === 'eraser') {
      const found = findAnnotationAt(props.annotations, props.pageNumber - 1, point)
      if (found) props.onRemove(found.id)
      return
    }
    if (props.tool !== 'pen') return
    event.currentTarget.setPointerCapture(event.pointerId)
    draftRef.current = [point]
  }

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (props.tool !== 'pen' || !draftRef.current) return
    const point = pagePoint(event)
    if (!point) return
    draftRef.current.push(point)
    const preview: InkAnnotation = {
      id: 'draft',
      type: 'ink',
      pageIndex: props.pageNumber - 1,
      points: draftRef.current,
      color: props.penColor,
      width: props.penWidth,
      opacity: 1,
      createdAt: new Date().toISOString(),
    }
    drawAnnotations(annotationCanvasRef.current, viewportRef.current, [...props.annotations, preview], props.pageNumber - 1)
  }

  const pointerUp = (): void => {
    const points = draftRef.current
    draftRef.current = null
    if (!points || points.length < 2) return
    props.onAdd({
      id: crypto.randomUUID(),
      type: 'ink',
      pageIndex: props.pageNumber - 1,
      points,
      color: props.penColor,
      width: props.penWidth,
      opacity: 1,
      createdAt: new Date().toISOString(),
    })
  }

  const createHighlight = (): void => {
    if (props.tool !== 'highlight') return
    const selection = window.getSelection()
    const viewport = viewportRef.current
    const host = hostRef.current
    if (!selection || selection.isCollapsed || !viewport || !host) return
    const hostRect = host.getBoundingClientRect()
    const rects = Array.from(selection.getRangeAt(0).getClientRects())
      .filter((rect) => rect.width > 1 && rect.height > 1 && rect.bottom >= hostRect.top && rect.top <= hostRect.bottom)
      .map((rect) => normalizePdfRect(
        viewport.convertToPdfPoint(rect.left - hostRect.left, rect.top - hostRect.top) as [number, number],
        viewport.convertToPdfPoint(rect.right - hostRect.left, rect.bottom - hostRect.top) as [number, number],
        viewport.viewBox as [number, number, number, number],
      ))
    if (rects.length) {
      const selectedText = selection.toString().trim()
      props.onAdd({
        id: crypto.randomUUID(),
        type: 'highlight',
        pageIndex: props.pageNumber - 1,
        rects,
        color: props.highlightColor,
        opacity: 0.38,
        createdAt: new Date().toISOString(),
        selectedText,
      })
      selection.removeAllRanges()
    }
  }

  const showContextMenu = (event: React.MouseEvent): void => {
    const liveSelection = window.getSelection()
    const selection = liveSelection?.toString().trim() ?? ''
    if (!selection) return
    event.preventDefault()
    if (selection.length > 20_000) {
      window.alert('Select a passage shorter than 20,000 characters.')
      return
    }
    const hostRect = hostRef.current?.getBoundingClientRect()
    const selectionRect = liveSelection?.rangeCount ? liveSelection.getRangeAt(0).getBoundingClientRect() : null
    let nearbyText: string | undefined
    if (hostRect && selectionRect && hostRect.width && hostRect.height) {
      const x = (selectionRect.left + selectionRect.width / 2 - hostRect.left) / hostRect.width
      const y = (selectionRect.top + selectionRect.height / 2 - hostRect.top) / hostRect.height
      const paragraphs = readingMapRef.current?.units.paragraph ?? []
      const index = paragraphs.findIndex((unit) => unit.rects.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height))
      if (index >= 0) nearbyText = paragraphs.slice(Math.max(0, index - 1), index + 2).map((unit) => unit.text).join('\n\n').slice(0, 4_000)
    }
    window.koibill.showSelectionMenu({
      kind: 'selection', text: selection, documentId: props.documentId,
      sourceFingerprint: props.sourceFingerprint, documentName: props.documentName, pageNumber: props.pageNumber,
      nearbyText,
    })
  }

  const selectAnnotation = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (props.tool !== 'select' || !window.getSelection()?.isCollapsed || !viewportRef.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = normalizePdfPoint(
      viewportRef.current.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top) as [number, number],
      viewportRef.current.viewBox as [number, number, number, number],
    )
    props.onSelectAnnotation(findAnnotationAt(props.annotations, props.pageNumber - 1, point)?.id ?? null)
  }

  const focusText = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!props.focusEnabled || !window.getSelection()?.isCollapsed) return
    const target = event.target as Element
    if (!target.closest('.text-layer-host')) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    props.onFocusAt(props.pageNumber, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
  }

  return (
    <div
      ref={hostRef}
      id={`pdf-page-${props.pageNumber}`}
      data-page-number={props.pageNumber}
      className={`pdf-page tool-${props.tool}`}
      style={{ width: size.width, height: size.height, '--scale-factor': props.scale } as CSSProperties}
      onMouseUp={createHighlight}
      onPointerDownCapture={() => setLensInteracting(true)}
      onContextMenu={showContextMenu}
      onClick={(event) => { focusText(event); selectAnnotation(event) }}
    >
      <canvas ref={pageCanvasRef} className="pdf-canvas" />
      <div ref={textLayerHostRef} className="text-layer-host" />
      <canvas
        ref={annotationCanvasRef}
        className="annotation-canvas"
        style={{ pointerEvents: props.tool === 'pen' || props.tool === 'eraser' ? 'auto' : 'none' }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      />
      {props.focusEnabled && <svg className="spotlight-overlay" style={{ pointerEvents: 'none' }} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <defs><mask id={maskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="1000" height="1000" fill="white"/>
          {props.activeReadingUnit?.pageNumber === props.pageNumber && props.activeReadingUnit.rects.map((rect, index) => {
            const x = Math.max(0, rect.x * 1000 - 5)
            const y = Math.max(0, rect.y * 1000 - 3)
            return <rect key={index} x={x} y={y} width={Math.min(1000 - x, rect.width * 1000 + 10)} height={Math.min(1000 - y, rect.height * 1000 + 6)} rx="4" fill="black"/>
          })}
        </mask></defs>
        <rect width="1000" height="1000" fill="white" opacity={1 - props.surroundingVisibility} mask={`url(#${maskId})`}/>
      </svg>}
      <canvas ref={focusLensRef} className={`focus-lens ${props.selectionActive || lensInteracting ? 'selection-active' : ''}`} style={{ pointerEvents: 'none' }} aria-hidden="true"/>
      <span className="page-number-badge">{props.pageNumber}</span>
      {props.selectedAnnotationId && props.annotations.some((annotation) => annotation.id === props.selectedAnnotationId && annotation.pageIndex === props.pageNumber - 1)
        && <span className="annotation-selected-badge">Selected annotation</span>}
    </div>
  )
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return
  canvas.width = 1
  canvas.height = 1
}

export function drawFocusLens(lens: HTMLCanvasElement | null, page: HTMLCanvasElement | null, annotations: HTMLCanvasElement | null, unit: ReadingUnit | null, magnification: number, selectionActive: boolean): void {
  if (!lens || !page) return
  lens.width = Math.max(1, page.width)
  lens.height = Math.max(1, page.height)
  lens.style.width = page.style.width
  lens.style.height = page.style.height
  if (!unit || selectionActive || page.width <= 1 || page.height <= 1) return
  const context = lens.getContext('2d')
  if (!context) return
  const cssWidth = Number.parseFloat(page.style.width) || page.width
  const cssHeight = Number.parseFloat(page.style.height) || page.height
  const ratioX = page.width / cssWidth
  const ratioY = page.height / cssHeight
  const layout = focusLensLayout(unit.rects, cssWidth, cssHeight, magnification)
  if (!layout) return
  const source = layout.source
  const destination = layout.destination
  const draw = (canvas: HTMLCanvasElement): void => context.drawImage(
    canvas,
    source.x * ratioX, source.y * ratioY, source.width * ratioX, source.height * ratioY,
    destination.x * ratioX, destination.y * ratioY, destination.width * ratioX, destination.height * ratioY,
  )
  context.save()
  context.fillStyle = '#ffffff'
  context.fillRect(destination.x * ratioX, destination.y * ratioY, destination.width * ratioX, destination.height * ratioY)
  draw(page)
  if (annotations && annotations.width > 1 && annotations.height > 1) draw(annotations)
  context.strokeStyle = '#111111'
  context.lineWidth = Math.max(1, ratioX)
  context.strokeRect(destination.x * ratioX, destination.y * ratioY, destination.width * ratioX, destination.height * ratioY)
  context.restore()
}

function placeholderSize(metadata: PageMetadata | undefined, scale: number, userRotation: number): { width: number; height: number } {
  const width = metadata?.width ?? 612
  const height = metadata?.height ?? 792
  const rotation = (((metadata?.rotation ?? 0) + userRotation) % 360 + 360) % 360
  return rotation === 90 || rotation === 270
    ? { width: height * scale, height: width * scale }
    : { width: width * scale, height: height * scale }
}

function drawAnnotations(canvas: HTMLCanvasElement | null, viewport: PageViewport | null, annotations: Annotation[], pageIndex: number): void {
  if (!canvas || !viewport) return
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  const [x1, y1, x2, y2] = viewport.viewBox
  const toScreen = (point: NormalizedPoint): [number, number] => viewport.convertToViewportPoint(x1 + point.x * (x2 - x1), y1 + point.y * (y2 - y1)) as [number, number]
  for (const annotation of annotations) {
    if (annotation.pageIndex !== pageIndex) continue
    context.globalAlpha = annotation.opacity
    context.strokeStyle = annotation.color
    context.fillStyle = annotation.color
    if (annotation.type === 'highlight') {
      for (const rect of annotation.rects) {
        const corners = [
          toScreen({ x: rect.x, y: rect.y }),
          toScreen({ x: rect.x + rect.width, y: rect.y }),
          toScreen({ x: rect.x + rect.width, y: rect.y + rect.height }),
          toScreen({ x: rect.x, y: rect.y + rect.height }),
        ]
        context.beginPath()
        context.moveTo(...corners[0])
        corners.slice(1).forEach((corner) => context.lineTo(...corner))
        context.closePath()
        context.fill()
      }
    } else if (annotation.points.length) {
      context.lineWidth = annotation.width * viewport.scale
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      context.moveTo(...toScreen(annotation.points[0]))
      annotation.points.slice(1).forEach((point) => context.lineTo(...toScreen(point)))
      context.stroke()
    }
  }
  context.globalAlpha = 1
}
