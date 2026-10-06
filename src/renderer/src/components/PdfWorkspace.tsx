import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Eraser, FileDown, FolderOpen, Highlighter, Maximize2, Menu, MousePointer2, Pencil, Plus, Redo2, RotateCw, ScanText, Search, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AIProviderId, Annotation, AskAIRequest, PdfFocusUnit, PdfImportProgress, PdfSession, PdfViewState, ResearchTrayItem } from '../../../shared/types'
import { AI_PROVIDERS } from '../../../shared/ai-providers'
import { formatPrompt } from '../../../shared/prompt'
import { useWorkspaceStore } from '../store'
import { getPdfSelectionPageRange, shouldRenderPdfPage, type PdfSelectionPageRange } from '../pdf-selection'
import { PdfPage } from './PdfPage'
import { AIProviderSelect } from './AIProviderSelect'
import { registerWorkspaceFlusher } from '../persistence'
import { findReadingUnitAt, nearestReadingUnit, type PageReadingMap, type ReadingUnit } from '../pdf-reading-map'
import { anchorScrollCorrection, normalizeWheelDelta, zoomForWheel, type WheelZoomAnchor } from '../pdf-wheel-zoom'
import 'pdfjs-dist/web/pdf_viewer.css'

GlobalWorkerOptions.workerSrc = workerUrl
const highlightColors = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c']
const penColors = ['#000000', '#ef4444', '#2563eb', '#16a34a', '#fde047']
const zoomSteps = [.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4]
type SidebarView = 'pages' | 'annotations' | 'research'

export function PdfWorkspace(): React.JSX.Element {
  const store = useWorkspaceStore()
  const paneRef = useRef<HTMLElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const pdfCache = useRef(new Map<string, PDFDocumentProxy>())
  const pdfPageCount = useRef(0)
  const readingMaps = useRef(new Map<string, Map<number, PageReadingMap>>())
  const activeReadingUnitsRef = useRef<Record<string, ReadingUnit | null>>({})
  const pendingFocusStep = useRef<null | { documentId: string; pageNumber: number; direction: -1 | 1 }>(null)
  const wheelDelta = useRef(0)
  const wheelPoint = useRef({ x: 0, y: 0 })
  const wheelFrame = useRef(0)
  const wheelZoomInFlight = useRef(false)
  const saveTimers = useRef(new Map<string, number>())
  const savedVersions = useRef(new Map<string, string>())
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarView, setSidebarView] = useState<SidebarView>('pages')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Import PDFs into this workspace to start reading.')
  const [query, setQuery] = useState('')
  const [pageInput, setPageInput] = useState('1')
  const [matches, setMatches] = useState<number[]>([])
  const [matchIndex, setMatchIndex] = useState(0)
  const [passwordRequest, setPasswordRequest] = useState<null | { submit: (password: string) => void; incorrect: boolean }>(null)
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null)
  const [pendingMessage, setPendingMessage] = useState('Waiting to link conversation…')
  const [aiProvider, setAIProvider] = useState<AIProviderId>('chatgpt')
  const [selectionPageRange, setSelectionPageRange] = useState<PdfSelectionPageRange | null>(null)
  const [importProgress, setImportProgress] = useState<PdfImportProgress | null>(null)
  const [activeReadingUnits, setActiveReadingUnits] = useState<Record<string, ReadingUnit | null>>({})
  const activeId = store.activeDocumentId
  const active = activeId ? store.documents[activeId] : undefined
  const annotations = active?.document?.annotations ?? []
  const selectedAnnotation = annotations.find((annotation) => annotation.id === store.selectedAnnotationId)
  const viewStateSignature = store.order.map((id) => {
    const document = store.documents[id]
    return `${id}:${document?.zoom ?? 1}:${document?.rotation ?? 0}:${document?.currentPage ?? 1}:${document?.focus.enabled ? 1 : 0}:${document?.focus.unit ?? 'paragraph'}:${document?.focus.surroundingVisibility ?? .15}:${document?.focus.magnification ?? 1.25}`
  }).join('|')

  useEffect(() => setPageInput(String(active?.currentPage ?? 1)), [active?.currentPage, activeId])
  useEffect(() => { pdfPageCount.current = pdf?.numPages ?? 0 }, [pdf])
  useEffect(() => { activeReadingUnitsRef.current = activeReadingUnits }, [activeReadingUnits])

  const scrollReadingUnitIntoView = useCallback((unit: ReadingUnit): void => {
    requestAnimationFrame(() => {
      const viewer = viewerRef.current
      const page = document.getElementById(`pdf-page-${unit.pageNumber}`)
      if (!viewer || !page || !unit.rects.length) return
      const viewerRect = viewer.getBoundingClientRect()
      const pageRect = page.getBoundingClientRect()
      const top = Math.min(...unit.rects.map((rect) => pageRect.top + rect.y * pageRect.height))
      const bottom = Math.max(...unit.rects.map((rect) => pageRect.top + (rect.y + rect.height) * pageRect.height))
      const safeTop = viewerRect.top + viewerRect.height * .2
      const safeBottom = viewerRect.bottom - viewerRect.height * .2
      if (top < safeTop || bottom > safeBottom) {
        const unitCenter = (top + bottom) / 2
        viewer.scrollBy({ top: unitCenter - (viewerRect.top + viewerRect.height / 2), behavior: 'smooth' })
      }
    })
  }, [])

  const activateReadingUnit = useCallback((documentId: string, unit: ReadingUnit): void => {
    activeReadingUnitsRef.current = { ...activeReadingUnitsRef.current, [documentId]: unit }
    setActiveReadingUnits((current) => ({ ...current, [documentId]: unit }))
    useWorkspaceStore.getState().setCurrentPage(documentId, unit.pageNumber)
    scrollReadingUnitIntoView(unit)
  }, [scrollReadingUnitIntoView])

  const centeredUnit = useCallback((map: PageReadingMap, unitType: PdfFocusUnit): ReadingUnit | null => {
    const page = document.getElementById(`pdf-page-${map.pageNumber}`)
    const viewer = viewerRef.current
    if (!page || !viewer) return map.units[unitType][0] ?? null
    const pageRect = page.getBoundingClientRect()
    const viewerRect = viewer.getBoundingClientRect()
    const y = Math.min(1, Math.max(0, (viewerRect.top + viewerRect.height / 2 - pageRect.top) / Math.max(1, pageRect.height)))
    return nearestReadingUnit(map.units[unitType], .5, y)
  }, [])

  const registerReadingMap = useCallback((map: PageReadingMap): void => {
    const state = useWorkspaceStore.getState()
    const documentId = state.activeDocumentId
    if (!documentId) return
    const documentMaps = readingMaps.current.get(documentId) ?? new Map<number, PageReadingMap>()
    documentMaps.set(map.pageNumber, map)
    readingMaps.current.set(documentId, documentMaps)
    while (documentMaps.size > 7) {
      const removable = [...documentMaps.keys()].sort((a, b) => Math.abs(b - map.pageNumber) - Math.abs(a - map.pageNumber))[0]
      if (removable === undefined) break
      documentMaps.delete(removable)
    }
    const tab = state.documents[documentId]
    if (!tab?.focus.enabled) return
    const existing = activeReadingUnitsRef.current[documentId]
    if (existing?.pageNumber === map.pageNumber) {
      const refreshed = map.units[tab.focus.unit].find((unit) => unit.id === existing.id)
      if (refreshed) {
        activeReadingUnitsRef.current = { ...activeReadingUnitsRef.current, [documentId]: refreshed }
        setActiveReadingUnits((current) => ({ ...current, [documentId]: refreshed }))
        return
      }
    }
    const pending = pendingFocusStep.current
    if (pending?.documentId === documentId && pending.pageNumber === map.pageNumber) {
      pendingFocusStep.current = null
      const units = map.units[tab.focus.unit]
      const unit = pending.direction > 0 ? units[0] : units.at(-1)
      if (unit) activateReadingUnit(documentId, unit)
      else {
        const nextPage = map.pageNumber + pending.direction
        if (nextPage >= 1 && nextPage <= pdfPageCount.current) {
          pendingFocusStep.current = { ...pending, pageNumber: nextPage }
          state.setCurrentPage(documentId, nextPage)
        }
      }
      return
    }
    if (!existing && map.pageNumber === tab.currentPage) {
      const unit = centeredUnit(map, tab.focus.unit)
      if (unit) activateReadingUnit(documentId, unit)
    }
  }, [activateReadingUnit, centeredUnit])

  const focusAt = useCallback((pageNumber: number, x: number, y: number): void => {
    const state = useWorkspaceStore.getState()
    const documentId = state.activeDocumentId
    const tab = documentId ? state.documents[documentId] : undefined
    const map = documentId ? readingMaps.current.get(documentId)?.get(pageNumber) : undefined
    if (!documentId || !tab?.focus.enabled || !map) return
    const unit = findReadingUnitAt(map.units[tab.focus.unit], x, y)
    if (unit) activateReadingUnit(documentId, unit)
  }, [activateReadingUnit])

  const applyZoom = useCallback((zoom: number): void => {
    const currentId = useWorkspaceStore.getState().activeDocumentId
    const current = currentId ? useWorkspaceStore.getState().documents[currentId] : undefined
    const viewer = viewerRef.current
    if (!currentId || !current || !viewer) return
    const nextZoom = Math.min(4, Math.max(.25, zoom))
    const horizontalRatio = nextZoom / current.zoom
    const left = viewer.scrollLeft * horizontalRatio
    const pages = Array.from(viewer.querySelectorAll<HTMLElement>('.pdf-page'))
    const anchor = [...pages].reverse().find((page) => page.offsetTop <= viewer.scrollTop + 1) ?? pages[0]
    const anchorOffset = anchor ? (viewer.scrollTop - anchor.offsetTop) / Math.max(1, anchor.offsetHeight) : 0
    const anchorId = anchor?.id
    readingMaps.current.get(currentId)?.clear()
    store.setZoom(currentId, zoom)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      viewer.scrollLeft = left
      const nextAnchor = anchorId ? document.getElementById(anchorId) : null
      if (nextAnchor) viewer.scrollTop = nextAnchor.offsetTop + anchorOffset * nextAnchor.offsetHeight
    }))
  }, [store])

  const changeZoom = useCallback((direction: -1 | 1): void => {
    const id = useWorkspaceStore.getState().activeDocumentId
    const current = id ? useWorkspaceStore.getState().documents[id] : undefined
    if (!current) return
    const ordered = direction > 0 ? zoomSteps : [...zoomSteps].reverse()
    const next = ordered.find((step) => direction > 0 ? step > current.zoom + .001 : step < current.zoom - .001)
    applyZoom(next ?? (direction > 0 ? 4 : .25))
  }, [applyZoom])

  const initializeFocus = useCallback((documentId: string, pageNumber: number, unitType: PdfFocusUnit): void => {
    const map = readingMaps.current.get(documentId)?.get(pageNumber)
    const unit = map ? centeredUnit(map, unitType) : null
    if (unit) activateReadingUnit(documentId, unit)
  }, [activateReadingUnit, centeredUnit])

  const toggleFocus = useCallback((): void => {
    const state = useWorkspaceStore.getState()
    const documentId = state.activeDocumentId
    const tab = documentId ? state.documents[documentId] : undefined
    if (!documentId || !tab) return
    const enabled = !tab.focus.enabled
    state.setFocus(documentId, { enabled })
    if (!enabled) { pendingFocusStep.current = null; return }
    initializeFocus(documentId, tab.currentPage, tab.focus.unit)
  }, [initializeFocus])

  const changeFocusUnit = useCallback((unit: PdfFocusUnit): void => {
    const state = useWorkspaceStore.getState()
    const documentId = state.activeDocumentId
    const tab = documentId ? state.documents[documentId] : undefined
    if (!documentId || !tab) return
    state.setFocus(documentId, { unit })
    const existing = activeReadingUnitsRef.current[documentId]
    const map = readingMaps.current.get(documentId)?.get(existing?.pageNumber ?? tab.currentPage)
    const center = existing?.rects[0]
    const next = map ? nearestReadingUnit(map.units[unit], center ? center.x + center.width / 2 : .5, center ? center.y + center.height / 2 : .5) : null
    if (next) activateReadingUnit(documentId, next)
    else {
      activeReadingUnitsRef.current = { ...activeReadingUnitsRef.current, [documentId]: null }
      setActiveReadingUnits((current) => ({ ...current, [documentId]: null }))
    }
  }, [activateReadingUnit])

  const stepFocus = useCallback((direction: -1 | 1): void => {
    const state = useWorkspaceStore.getState()
    const documentId = state.activeDocumentId
    const tab = documentId ? state.documents[documentId] : undefined
    if (!documentId || !tab?.focus.enabled) return
    const maps = readingMaps.current.get(documentId)
    const activeUnit = activeReadingUnitsRef.current[documentId]
    if (!activeUnit || activeUnit.type !== tab.focus.unit) {
      initializeFocus(documentId, tab.currentPage, tab.focus.unit)
      return
    }
    const currentUnits = maps?.get(activeUnit.pageNumber)?.units[tab.focus.unit] ?? []
    const currentIndex = currentUnits.findIndex((unit) => unit.id === activeUnit.id)
    const adjacent = currentUnits[currentIndex + direction]
    if (adjacent) { activateReadingUnit(documentId, adjacent); return }
    let pageNumber = activeUnit.pageNumber + direction
    while (pageNumber >= 1 && pageNumber <= pdfPageCount.current) {
      const map = maps?.get(pageNumber)
      if (!map) {
        pendingFocusStep.current = { documentId, pageNumber, direction }
        state.setCurrentPage(documentId, pageNumber)
        return
      }
      const units = map.units[tab.focus.unit]
      const unit = direction > 0 ? units[0] : units.at(-1)
      if (unit) { activateReadingUnit(documentId, unit); return }
      pageNumber += direction
    }
  }, [activateReadingUnit, initializeFocus])

  const restorePagePosition = useCallback((documentId: string, pageNumber: number): void => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (useWorkspaceStore.getState().activeDocumentId !== documentId) return
      document.getElementById(`pdf-page-${pageNumber}`)?.scrollIntoView({ block: 'start' })
    }))
  }, [])

  const rotatePdf = (): void => {
    if (!activeId || !active || !viewerRef.current) return
    const viewer = viewerRef.current
    const pages = Array.from(viewer.querySelectorAll<HTMLElement>('.pdf-page'))
    const anchor = [...pages].reverse().find((page) => page.offsetTop <= viewer.scrollTop + 1) ?? pages[0]
    const anchorOffset = anchor ? (viewer.scrollTop - anchor.offsetTop) / Math.max(1, anchor.offsetHeight) : 0
    const anchorId = anchor?.id
    readingMaps.current.get(activeId)?.clear()
    store.setRotation(activeId, active.rotation + 90)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const nextAnchor = anchorId ? document.getElementById(anchorId) : null
      if (nextAnchor) viewer.scrollTop = nextAnchor.offsetTop + anchorOffset * nextAnchor.offsetHeight
    }))
  }

  const loadSession = useCallback(async (session: PdfSession): Promise<void> => {
    setBusy(true); setMessage('Loading PDF…'); store.upsertSession(session)
    const cached = pdfCache.current.get(session.documentId)
    if (cached) { setPdf(cached); restorePagePosition(session.documentId, store.documents[session.documentId]?.currentPage ?? 1); setBusy(false); setMessage(''); return }
    const task = getDocument({ data: session.bytes.slice() })
    task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
      setPasswordRequest({ submit: (password) => { setPasswordRequest(null); updatePassword(password) }, incorrect: reason === 2 })
    }
    try {
      const loaded = await task.promise
      pdfCache.current.set(session.documentId, loaded)
      while (pdfCache.current.size > 2) {
        const oldest = [...pdfCache.current.keys()].find((id) => id !== session.documentId && id !== store.activeDocumentId)
        if (!oldest) break
        void pdfCache.current.get(oldest)?.cleanup(); pdfCache.current.delete(oldest)
      }
      setPdf(loaded)
      const pages = await Promise.all(Array.from({ length: loaded.numPages }, async (_, index) => {
        const page = await loaded.getPage(index + 1); const [x1, y1, x2, y2] = page.view
        return { width: x2 - x1, height: y2 - y1, rotation: page.rotate }
      }))
      store.setPageMetadata(session.documentId, pages)
      const restoredPage = Math.min(loaded.numPages, Math.max(1, useWorkspaceStore.getState().documents[session.documentId]?.currentPage ?? 1))
      store.setCurrentPage(session.documentId, restoredPage)
      restorePagePosition(session.documentId, restoredPage)
      setMessage('')
    } catch (error) {
      store.setDocumentStatus(session.documentId, 'error', String(error)); setPdf(null); setMessage(`Unable to open PDF: ${String(error)}`)
    } finally { setBusy(false) }
  }, [restorePagePosition, store])

  useEffect(() => {
    let cancelled = false
    void window.koibill.restoreWorkspace().then((workspace) => {
      if (cancelled) return
      store.restore(workspace)
      if (workspace.activeDocumentId) void window.koibill.loadWorkspacePdf(workspace.activeDocumentId).then((session) => session && loadSession(session))
    })
    const removeTrayListener = window.koibill.onResearchTrayItem((item) => { store.addTrayItem(item); setSidebarOpen(true); setSidebarView('research') })
    const removeStatusListener = window.koibill.onAskAIStatus((status) => {
      if (status.state === 'pending') { setPendingRequestId(status.requestId); setPendingMessage(status.message ?? 'Waiting to link conversation…') }
      if (status.state !== 'pending') setPendingRequestId(null)
      if (status.state === 'linked' && status.link) {
        status.linkTargets.forEach((target) => store.addConversationLink(target.documentId, target.annotationId, status.link!))
        setMessage('AI conversation linked to the source annotation.')
      } else if (status.state === 'cancelled' && status.message) setMessage(status.message)
    })
    return () => { cancelled = true; removeTrayListener(); removeStatusListener() }
  }, [])

  useEffect(() => window.koibill.onPdfImportProgress((progress) => {
    setImportProgress(progress)
    if (progress.state === 'complete' || progress.state === 'cancelled') window.setTimeout(() => setImportProgress((current) => current?.operationId === progress.operationId ? null : current), 500)
  }), [])

  useEffect(() => registerWorkspaceFlusher(async () => {
    const current = useWorkspaceStore.getState()
    const entries = Object.values(current.documents).flatMap((tab) => tab.session && tab.document
      ? [{ sessionId: tab.session.id, document: tab.document }]
      : [])
    await Promise.all(entries.map((entry) => window.koibill.saveAnnotations(entry.sessionId, entry.document)))
    await window.koibill.saveWorkspace({ documentIds: current.order, activeDocumentId: current.activeDocumentId, viewStates: workspaceViewStates(current), tray: current.tray, question: current.question })
  }), [])

  useEffect(() => {
    const unload = (): void => {
      for (const cached of pdfCache.current.values()) void cached.cleanup()
      pdfCache.current.clear(); readingMaps.current.clear(); activeReadingUnitsRef.current = {}; pendingFocusStep.current = null
      setActiveReadingUnits({}); setPdf(null)
    }
    window.addEventListener('koibill:workspace-unload', unload)
    return () => window.removeEventListener('koibill:workspace-unload', unload)
  }, [])

  useEffect(() => {
    if (!activeId) { setPdf(null); return }
    const cached = pdfCache.current.get(activeId)
    if (cached) { setPdf(cached); restorePagePosition(activeId, store.documents[activeId]?.currentPage ?? 1); return }
    const tab = store.documents[activeId]
    if (!tab || tab.status === 'loading' || tab.status === 'missing') { setPdf(null); return }
    store.setDocumentStatus(activeId, 'loading')
    void window.koibill.loadWorkspacePdf(activeId).then((session) => {
      if (session) void loadSession(session)
      else store.setDocumentStatus(activeId, 'missing')
    })
  }, [activeId, restorePagePosition])

  useEffect(() => {
    for (const [documentId, tab] of Object.entries(store.documents)) {
      if (!tab.session || !tab.document || savedVersions.current.get(documentId) === tab.document.modifiedAt) continue
      const existing = saveTimers.current.get(documentId); if (existing) window.clearTimeout(existing)
      saveTimers.current.set(documentId, window.setTimeout(() => {
        void window.koibill.saveAnnotations(tab.session!.id, tab.document!).then(() => savedVersions.current.set(documentId, tab.document!.modifiedAt)).catch((error) => setMessage(`Autosave failed: ${String(error)}`))
      }, 700))
    }
  }, [store.documents])

  useEffect(() => {
    const timeout = window.setTimeout(() => void window.koibill.saveWorkspace({ documentIds: store.order, activeDocumentId: store.activeDocumentId, viewStates: workspaceViewStates(store), tray: store.tray, question: store.question }), 250)
    return () => window.clearTimeout(timeout)
  }, [store.order, store.activeDocumentId, store.tray, store.question, viewStateSignature])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      const id = useWorkspaceStore.getState().activeDocumentId
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); openPdf() }
      if (!id || !paneRef.current?.contains(event.target as Node)) return
      if (id && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); store.undo(id) }
      if (id && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) { event.preventDefault(); store.redo(id) }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1) }
      if (event.key === '-') { event.preventDefault(); changeZoom(-1) }
      if (event.key === '0') { event.preventDefault(); applyZoom(1) }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown)
  }, [applyZoom, changeZoom, store])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const pane = paneRef.current
      const focused = document.activeElement
      if (!pane || !focused || !pane.contains(focused) || isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      const state = useWorkspaceStore.getState()
      const documentId = state.activeDocumentId
      const tab = documentId ? state.documents[documentId] : undefined
      if (!documentId || !tab?.focus.enabled) return
      if (event.key === 'Escape') {
        event.preventDefault()
        state.setFocus(documentId, { enabled: false })
        pendingFocusStep.current = null
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); stepFocus(1) }
      if (key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); stepFocus(-1) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [stepFocus])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    let cancelled = false
    const commit = (): void => {
      wheelFrame.current = 0
      if (cancelled || wheelZoomInFlight.current || wheelDelta.current === 0) return
      const state = useWorkspaceStore.getState()
      const documentId = state.activeDocumentId
      const tab = documentId ? state.documents[documentId] : undefined
      if (!documentId || !tab) { wheelDelta.current = 0; return }
      const anchor = captureWheelAnchor(viewer, wheelPoint.current.x, wheelPoint.current.y)
      const delta = wheelDelta.current
      wheelDelta.current = 0
      const nextZoom = zoomForWheel(tab.zoom, delta)
      if (nextZoom === tab.zoom) return
      wheelZoomInFlight.current = true
      readingMaps.current.get(documentId)?.clear()
      state.setZoom(documentId, nextZoom)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled && anchor && useWorkspaceStore.getState().activeDocumentId === documentId) {
          const page = document.getElementById(`pdf-page-${anchor.pageNumber}`)
          if (page) {
            const correction = anchorScrollCorrection(anchor, page.getBoundingClientRect())
            viewer.scrollLeft += correction.left
            viewer.scrollTop += correction.top
          }
        }
        wheelZoomInFlight.current = false
        if (!cancelled && wheelDelta.current !== 0 && !wheelFrame.current) wheelFrame.current = requestAnimationFrame(commit)
      }))
    }
    const wheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !activeId) return
      event.preventDefault()
      wheelPoint.current = { x: event.clientX, y: event.clientY }
      wheelDelta.current += normalizeWheelDelta(event.deltaY, event.deltaMode, viewer.clientHeight)
      if (!wheelZoomInFlight.current && !wheelFrame.current) wheelFrame.current = requestAnimationFrame(commit)
    }
    viewer.addEventListener('wheel', wheel, { passive: false })
    return () => {
      cancelled = true
      viewer.removeEventListener('wheel', wheel)
      cancelAnimationFrame(wheelFrame.current)
      wheelFrame.current = 0; wheelDelta.current = 0; wheelZoomInFlight.current = false
    }
  }, [activeId])

  useEffect(() => {
    const updateSelectionRange = (): void => {
      const next = getPdfSelectionPageRange(window.getSelection(), viewerRef.current)
      setSelectionPageRange((current) => current?.start === next?.start && current?.end === next?.end ? current : next)
    }
    document.addEventListener('selectionchange', updateSelectionRange)
    return () => document.removeEventListener('selectionchange', updateSelectionRange)
  }, [])

  useEffect(() => setSelectionPageRange(null), [activeId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !activeId || !pdf) return
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const pages = Array.from(viewer.querySelectorAll<HTMLElement>('.pdf-page'))
        if (!pages.length) return
        const center = viewer.scrollTop + viewer.clientHeight / 2
        const current = pages.find((page) => page.offsetTop <= center && page.offsetTop + page.offsetHeight >= center)
          ?? pages.reduce((nearest, page) => Math.abs(page.offsetTop + page.offsetHeight / 2 - center) < Math.abs(nearest.offsetTop + nearest.offsetHeight / 2 - center) ? page : nearest)
        const pageNumber = Number(current.id.replace('pdf-page-', ''))
        if (Number.isInteger(pageNumber)) useWorkspaceStore.getState().setCurrentPage(activeId, pageNumber)
      })
    }
    viewer.addEventListener('scroll', update, { passive: true })
    return () => { cancelAnimationFrame(frame); viewer.removeEventListener('scroll', update) }
  }, [activeId, pdf])

  useEffect(() => () => { for (const timeout of saveTimers.current.values()) window.clearTimeout(timeout); for (const cached of pdfCache.current.values()) void cached.cleanup() }, [])

  const openPdf = (): void => {
    void window.koibill.importPdfs().then(async ({ sessions }) => {
      for (const session of sessions) await loadSession(session)
    }).catch((error) => setMessage(`Import failed: ${String(error)}`))
  }
  const activateTab = (id: string): void => store.activate(id)
  const closeTab = (id: string): void => {
    if (pendingRequestId) { window.koibill.cancelAskAI(pendingRequestId); setPendingRequestId(null) }
    const tab = store.documents[id]
    if (tab?.session && tab.document) void window.koibill.saveAnnotations(tab.session.id, tab.document)
    void pdfCache.current.get(id)?.cleanup(); pdfCache.current.delete(id); readingMaps.current.delete(id)
    activeReadingUnitsRef.current = { ...activeReadingUnitsRef.current, [id]: null }
    setActiveReadingUnits((current) => { const next = { ...current }; delete next[id]; return next })
    store.close(id); void window.koibill.closeWorkspacePdf(id)
  }
  const getPage = useCallback((pageNumber: number): Promise<PDFPageProxy> => pdf ? pdf.getPage(pageNumber) : Promise.reject(new Error('No PDF is open.')), [pdf])
  const goToPage = (pageNumber: number): void => {
    if (!activeId) return
    const next = Math.min(pdf?.numPages ?? 1, Math.max(1, pageNumber))
    store.setCurrentPage(activeId, next)
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`pdf-page-${next}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })))
  }
  const commitPageInput = (): void => {
    const page = Number(pageInput)
    if (Number.isInteger(page) && page > 0) goToPage(page)
    else setPageInput(String(active?.currentPage ?? 1))
  }
  const navigateToItem = (item: ResearchTrayItem): void => {
    const selectSource = (): void => { store.selectAnnotation(item.annotationId ?? null); window.setTimeout(() => { document.getElementById(`pdf-page-${item.pageNumber}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); store.setCurrentPage(item.documentId, item.pageNumber) }, 180) }
    if (store.documents[item.documentId]) { store.activate(item.documentId); selectSource(); return }
    void window.koibill.loadWorkspacePdf(item.documentId).then((session) => { if (!session) { setMessage('The source PDF is not currently available.'); return } void loadSession(session).then(selectSource) })
  }
  const runSearch = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault(); if (!pdf || !query.trim()) { setMatches([]); return }
    setBusy(true); const needle = query.toLocaleLowerCase(); const found: number[] = []
    for (let index = 1; index <= pdf.numPages; index += 1) { const text = await (await pdf.getPage(index)).getTextContent(); if (text.items.map((item) => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase().includes(needle)) found.push(index) }
    setMatches(found); setMatchIndex(0); setBusy(false)
    if (found[0]) { setMessage(''); goToPage(found[0]) }
    else setMessage(`No matches for “${query.trim()}”.`)
  }
  const nextMatch = (): void => { if (!matches.length) return; const next = (matchIndex + 1) % matches.length; setMatchIndex(next); goToPage(matches[next]) }
  const fitWidth = async (): Promise<void> => { if (!pdf || !viewerRef.current || !activeId || !active) return; const page = await pdf.getPage(active.currentPage); const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + active.rotation) % 360 }); applyZoom((viewerRef.current.clientWidth - 48) / viewport.width) }
  const fitPage = async (): Promise<void> => { if (!pdf || !viewerRef.current || !activeId || !active) return; const page = await pdf.getPage(active.currentPage); const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + active.rotation) % 360 }); applyZoom(Math.min((viewerRef.current.clientWidth - 48) / viewport.width, (viewerRef.current.clientHeight - 48) / viewport.height)) }
  const exportPdf = (): void => { if (!active?.session || !active.document) return; setBusy(true); void window.koibill.exportAnnotatedPdf(active.session.id, active.document).then((result) => result.exported && setMessage(`Exported ${result.pathLabel ?? 'annotated PDF'}.`)).catch((error) => setMessage(String(error))).finally(() => setBusy(false)) }

  const annotationText = (annotation: Annotation): string => annotation.type === 'highlight' ? annotation.selectedText?.trim() || annotation.note?.trim() || '' : annotation.note?.trim() || ''
  const addAnnotationToTray = (annotation: Annotation): void => {
    if (!active?.session) return; const text = annotationText(annotation); if (!text) return
    store.addTrayItem({ id: crypto.randomUUID(), documentId: active.session.documentId, sourceFingerprint: active.session.fingerprint, documentName: active.session.name, pageNumber: annotation.pageIndex + 1, text, annotationId: annotation.id, createdAt: new Date().toISOString() }); setSidebarView('research')
  }
  const askAnnotation = (annotation: Annotation, mode: 'draft' | 'send'): void => {
    if (!active?.session) return; const text = annotationText(annotation); if (!text) return
    const request: AskAIRequest = { kind: 'selection', provider: aiProvider, requestId: crypto.randomUUID(), mode, text, documentName: active.session.name, pageNumber: annotation.pageIndex + 1, linkTargets: [{ documentId: active.session.documentId, annotationId: annotation.id }] }
    void window.koibill.askAI(request)
  }
  const trayRequest = (mode: 'draft' | 'send'): AskAIRequest => ({ kind: 'research', provider: aiProvider, requestId: crypto.randomUUID(), mode, question: store.question, items: store.tray, linkTargets: store.tray.flatMap((item) => item.annotationId ? [{ documentId: item.documentId, annotationId: item.annotationId }] : []) })
  const trayLength = store.tray.length ? formatPrompt(trayRequest('draft')).length : 0
  const askTray = (mode: 'draft' | 'send'): void => { const request = trayRequest(mode); if (formatPrompt(request).length <= 20_000) void window.koibill.askAI(request) }

  return <section ref={paneRef} className="pdf-pane" aria-label="PDF reader" tabIndex={-1} onPointerDownCapture={(event) => {
    if (!isInteractiveTarget(event.target)) paneRef.current?.focus({ preventScroll: true })
  }}>
    <header className="pdf-topbar"><div className="brand">koibill</div><button className="toolbar-button" onClick={openPdf}><FolderOpen size={16}/> Import PDFs</button><button className="toolbar-button" disabled={!pdf} onClick={exportPdf}><FileDown size={16}/> Export</button><span className="toolbar-spacer"/>{active && <span className="document-title">{active.descriptor.name}</span>}</header>
    <div className="pdf-tab-strip" role="tablist">{store.order.map((id) => { const tab = store.documents[id]; return <div draggable onDragStart={(event) => event.dataTransfer.setData('text/koibill-pdf-tab', id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData('text/koibill-pdf-tab'); let from = store.order.indexOf(source); const to = store.order.indexOf(id); while (from >= 0 && from !== to) { const direction = from < to ? 1 : -1; store.move(source, direction); from += direction } }} className={`pdf-tab ${id === activeId ? 'active' : ''}`} key={id}><button role="tab" onClick={() => activateTab(id)}>{tab.descriptor.name}{tab.status === 'missing' ? ' — missing' : ''}</button><button aria-label={`Close ${tab.descriptor.name}`} onClick={() => closeTab(id)}><X size={12}/></button></div> })}<button className="icon-button small" aria-label="Import PDFs" onClick={openPdf}><Plus size={14}/></button></div>
    <div className="annotation-toolbar" aria-label="PDF tools">
      {([['select', MousePointer2, 'Select text'], ['highlight', Highlighter, 'Highlight'], ['pen', Pencil, 'Pen'], ['eraser', Eraser, 'Object eraser']] as const).map(([tool, Icon, label]) => <button key={tool} className={`tool-button ${store.tool === tool ? 'active' : ''}`} onClick={() => store.setTool(tool)} title={label}><Icon size={16}/></button>)}
      <span className="toolbar-divider"/><div className="color-row">{(store.tool === 'highlight' ? highlightColors : penColors).map((color) => <button key={color} className={`color-swatch ${(store.tool === 'highlight' ? store.highlightColor : store.penColor) === color ? 'selected' : ''}`} style={{ backgroundColor: color }} aria-label={color} onClick={() => store.tool === 'highlight' ? store.setHighlightColor(color) : store.setPenColor(color)}/>)}</div>
      {store.tool === 'pen' && <select aria-label="Pen width" value={store.penWidth} onChange={(event) => store.setPenWidth(Number(event.target.value))}><option value={1}>Fine</option><option value={2}>Medium</option><option value={4}>Broad</option></select>}
      <span className="toolbar-divider"/><button className="tool-button" disabled={!active?.past.length} onClick={() => activeId && store.undo(activeId)} title="Undo"><Undo2 size={16}/></button><button className="tool-button" disabled={!active?.future.length} onClick={() => activeId && store.redo(activeId)} title="Redo"><Redo2 size={16}/></button>
      <button className="tool-button" disabled={!active} aria-label="Zoom out" title="Zoom out (Ctrl+-)" onClick={() => changeZoom(-1)}><ZoomOut size={16}/></button><select className="pdf-zoom-select" aria-label="PDF zoom" disabled={!active} value={zoomSteps.includes(active?.zoom ?? 1) ? (active?.zoom ?? 1) : 'custom'} onChange={(event) => event.target.value !== 'custom' && applyZoom(Number(event.target.value))}>{!zoomSteps.includes(active?.zoom ?? 1) && <option value="custom">{Math.round((active?.zoom ?? 1) * 100)}%</option>}{zoomSteps.map((step) => <option key={step} value={step}>{Math.round(step * 100)}%</option>)}</select><button className="tool-button" disabled={!active} aria-label="Zoom in" title="Zoom in (Ctrl++)" onClick={() => changeZoom(1)}><ZoomIn size={16}/></button><button className="fit-button" disabled={!active} title="Fit page width" onClick={() => void fitWidth()}>Width</button><button className="tool-button" disabled={!active} aria-label="Fit page" title="Fit whole page" onClick={() => void fitPage()}><Maximize2 size={15}/></button><button className="tool-button" disabled={!active} aria-label="Rotate page" title="Rotate clockwise" onClick={rotatePdf}><RotateCw size={16}/></button>
      <span className="toolbar-divider"/><button className={`tool-button ${active?.focus.enabled ? 'active' : ''}`} disabled={!active} aria-pressed={active?.focus.enabled ?? false} title="Focus reading" onClick={toggleFocus}><ScanText size={16}/></button>
      {active?.focus.enabled && <div className="focus-controls"><select aria-label="Focus reading unit" value={active.focus.unit} onChange={(event) => changeFocusUnit(event.target.value as PdfFocusUnit)}><option value="line">Line</option><option value="sentence">Sentence</option><option value="paragraph">Paragraph</option></select><label title="Visibility outside the focused text"><span>{Math.round(active.focus.surroundingVisibility * 100)}% visible</span><input aria-label="Surrounding visibility" type="range" min="5" max="40" step="5" value={Math.round(active.focus.surroundingVisibility * 100)} onChange={(event) => activeId && store.setFocus(activeId, { surroundingVisibility: Number(event.target.value) / 100 })}/></label><label title="Focused text magnification"><span>{Math.round((active.focus.magnification ?? 1.25) * 100)}% lens</span><input aria-label="Focus magnification" type="range" min="110" max="160" step="5" value={Math.round((active.focus.magnification ?? 1.25) * 100)} onChange={(event) => activeId && store.setFocus(activeId, { magnification: Number(event.target.value) / 100 })}/></label><small>J/K or ↑/↓ · Esc</small></div>}
    </div>
    <div className="reader-controls"><button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}><Menu size={16}/></button><label className="page-control">Page <input type="number" min={1} max={pdf?.numPages ?? 1} value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={commitPageInput} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPageInput(); event.currentTarget.blur() } }}/> / {pdf?.numPages ?? 0}</label><form className="pdf-search" onSubmit={(event) => void runSearch(event)}><Search size={14}/><input placeholder="Search document" value={query} onChange={(event) => setQuery(event.target.value)}/>{matches.length > 0 && <button type="button" onClick={nextMatch}>{matchIndex + 1}/{matches.length}</button>}</form></div>
    <div className="reader-body">
      {sidebarOpen && <aside className="thumbnail-sidebar workspace-sidebar"><div className="sidebar-tabs">{(['pages','annotations','research'] as SidebarView[]).map((view) => <button key={view} className={sidebarView === view ? 'active' : ''} onClick={() => setSidebarView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}</div>
        {sidebarView === 'pages' && (pdf ? Array.from({ length: pdf.numPages }, (_, index) => <Thumbnail key={index + 1} pageNumber={index + 1} getPage={getPage} active={active?.currentPage === index + 1} onClick={() => goToPage(index + 1)}/>) : <p className="sidebar-empty">No PDF selected</p>)}
        {sidebarView === 'annotations' && <AnnotationSidebar annotations={annotations} selectedId={store.selectedAnnotationId} onSelect={(annotation) => { store.selectAnnotation(annotation.id); goToPage(annotation.pageIndex + 1); const link = annotation.conversationLinks?.at(-1); if (link) void window.koibill.browserCommand({ type: 'activate-or-open', tabId: link.browserTabId, url: link.url }) }}/>} 
        {sidebarView === 'research' && <ResearchTray items={store.tray} question={store.question} promptLength={trayLength} provider={aiProvider} onProvider={setAIProvider} onQuestion={store.setQuestion} onNavigate={navigateToItem} onMove={store.moveTrayItem} onRemove={store.removeTrayItem} onClear={store.clearTray} onAsk={askTray}/>} 
      </aside>}
      <div ref={viewerRef} className="pdf-viewer">{active?.status === 'missing' ? <div className="empty-state"><h1>Workspace PDF missing</h1><p>{active.descriptor.name} is missing from this workspace folder.</p></div> : pdf && active?.session && active.document ? Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={`${activeId}-${index + 1}`} pageNumber={index + 1} pageMetadata={active.document!.pages[index]} shouldRender={shouldRenderPdfPage(index + 1, active.currentPage, active.zoom, selectionPageRange)} getPage={getPage} scale={active.zoom} rotation={active.rotation} annotations={annotations} tool={store.tool} highlightColor={store.highlightColor} penColor={store.penColor} penWidth={store.penWidth} documentId={active.session!.documentId} sourceFingerprint={active.session!.fingerprint} documentName={active.session!.name} selectedAnnotationId={store.selectedAnnotationId} focusEnabled={active.focus.enabled} surroundingVisibility={active.focus.surroundingVisibility} focusMagnification={active.focus.magnification ?? 1.25} selectionActive={selectionPageRange !== null} activeReadingUnit={activeReadingUnits[active.session!.documentId] ?? null} onReadingMap={registerReadingMap} onFocusAt={focusAt} onAdd={(annotation) => store.addAnnotation(active.session!.documentId, annotation)} onRemove={(id) => store.removeAnnotation(active.session!.documentId, id)} onSelectAnnotation={(id) => { store.selectAnnotation(id); if (id) setSidebarView('annotations') }}/>) : <div className="empty-state"><div className="empty-mark">K</div><h1>Read, mark, ask.</h1><p>{message}</p><button className="primary-button" onClick={openPdf}>Import PDFs</button></div>}</div>
    </div>
    {selectedAnnotation && activeId && <AnnotationDetail annotation={selectedAnnotation} provider={aiProvider} onProvider={setAIProvider} onClose={() => store.selectAnnotation(null)} onNote={(note) => store.updateAnnotationNote(activeId, selectedAnnotation.id, note)} onTray={() => addAnnotationToTray(selectedAnnotation)} onAsk={(mode) => askAnnotation(selectedAnnotation, mode)} onOpen={(link) => void window.koibill.browserCommand({ type: 'activate-or-open', tabId: link.browserTabId, url: link.url })} onRemoveLink={(linkId) => store.removeConversationLink(activeId, selectedAnnotation.id, linkId)}/>} 
    {pendingRequestId && <div className="pending-link">{pendingMessage} <button onClick={() => { window.koibill.cancelAskAI(pendingRequestId); setPendingRequestId(null) }}>Cancel</button></div>}
    {busy && <div className="status-pill">Working…</div>}{message && pdf && <button className="status-message" onClick={() => setMessage('')}>{message}</button>}
    {active?.fingerprintMismatch && <div className="modal-backdrop"><div className="modal"><h2>The PDF has changed</h2><p>The saved annotations belong to an earlier version.</p><div className="modal-actions"><button onClick={() => activeId && store.acceptSourceFingerprint(activeId)}>Keep annotations</button><button className="primary-button" onClick={() => activeId && store.clearAnnotations(activeId)}>Start fresh</button></div></div></div>}
    {passwordRequest && <PasswordDialog incorrect={passwordRequest.incorrect} onSubmit={passwordRequest.submit} onCancel={() => setPasswordRequest(null)}/>} 
    {importProgress && <div className="import-overlay" role="dialog" aria-modal="true" aria-label="Importing PDFs" onKeyDown={(event) => { if (event.key === 'Tab') { event.preventDefault(); event.currentTarget.querySelector('button')?.focus() } }}><div className="import-dialog"><strong>{importProgress.state === 'finalizing' ? 'Finalizing import…' : importProgress.state === 'error' ? 'Import failed' : 'Copying PDFs…'}</strong><p>{importProgress.fileName || importProgress.message}</p><progress max={Math.max(1, importProgress.totalBytesExpected)} value={importProgress.totalBytes}/><span>{importProgress.fileCount ? `${Math.max(1, importProgress.fileIndex)} of ${importProgress.fileCount} · ${Math.round(importProgress.totalBytes / Math.max(1, importProgress.totalBytesExpected) * 100)}%` : ''}</span>{(importProgress.state === 'copying' || importProgress.state === 'finalizing') && <button autoFocus onClick={() => window.koibill.cancelPdfImport(importProgress.operationId)}>Cancel</button>}{importProgress.state === 'error' && <button autoFocus onClick={() => setImportProgress(null)}>Close</button>}</div></div>}
  </section>
}

function workspaceViewStates(state: Pick<ReturnType<typeof useWorkspaceStore.getState>, 'order' | 'documents'>): Record<string, PdfViewState> {
  return Object.fromEntries(state.order.flatMap((id) => {
    const document = state.documents[id]
    return document ? [[id, { zoom: document.zoom, rotation: document.rotation, currentPage: document.currentPage, focus: document.focus }]] : []
  }))
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest('input, textarea, select, button, [contenteditable="true"], [role="dialog"]'))
}

function captureWheelAnchor(viewer: HTMLElement, clientX: number, clientY: number): WheelZoomAnchor | null {
  const pages = Array.from(viewer.querySelectorAll<HTMLElement>('.pdf-page'))
  if (!pages.length) return null
  const page = pages.reduce((nearest, candidate) => rectDistance(candidate.getBoundingClientRect(), clientX, clientY) < rectDistance(nearest.getBoundingClientRect(), clientX, clientY) ? candidate : nearest)
  const rect = page.getBoundingClientRect()
  const pageNumber = Number(page.dataset.pageNumber)
  if (!Number.isInteger(pageNumber) || rect.width <= 0 || rect.height <= 0) return null
  return {
    pageNumber,
    normalizedX: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    normalizedY: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    clientX,
    clientY,
  }
}

function rectDistance(rect: DOMRect, x: number, y: number): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
  return Math.hypot(dx, dy)
}
function AnnotationSidebar({ annotations, selectedId, onSelect }: { annotations: Annotation[]; selectedId: string | null; onSelect: (annotation: Annotation) => void }): React.JSX.Element { return <div className="annotation-list">{annotations.length ? annotations.map((annotation) => <button key={annotation.id} className={selectedId === annotation.id ? 'active' : ''} onClick={() => onSelect(annotation)}><span>{annotation.type === 'highlight' ? 'Highlight' : 'Ink'} · p. {annotation.pageIndex + 1}</span><small>{annotation.type === 'highlight' ? annotation.selectedText || annotation.note || 'No text' : annotation.note || 'No note'}</small></button>) : <p className="sidebar-empty">No annotations</p>}</div> }

function ResearchTray({ items, question, promptLength, provider, onProvider, onQuestion, onNavigate, onMove, onRemove, onClear, onAsk }: { items: ResearchTrayItem[]; question: string; promptLength: number; provider: AIProviderId; onProvider: (provider: AIProviderId) => void; onQuestion: (value: string) => void; onNavigate: (item: ResearchTrayItem) => void; onMove: (id: string, direction: -1 | 1) => void; onRemove: (id: string) => void; onClear: () => void; onAsk: (mode: 'draft' | 'send') => void }): React.JSX.Element {
  const invalid = !items.length || promptLength > 20_000
  return <div className="research-tray"><textarea placeholder="Question or instructions (optional)" value={question} onChange={(event) => onQuestion(event.target.value)}/>{items.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/koibill-tray-item', item.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData('text/koibill-tray-item'); let from = items.findIndex((entry) => entry.id === source); while (from >= 0 && from !== index) { const direction = from < index ? 1 : -1; onMove(source, direction); from += direction } }}><button className="tray-source" onClick={() => onNavigate(item)}><strong>[{index + 1}] {item.documentName}</strong><span>Page {item.pageNumber}</span><p>{item.text}</p></button><div><button disabled={index === 0} onClick={() => onMove(item.id, -1)}><ChevronUp size={13}/></button><button disabled={index === items.length - 1} onClick={() => onMove(item.id, 1)}><ChevronDown size={13}/></button><button onClick={() => onRemove(item.id)}><Trash2 size={13}/></button></div></article>)}<div className={`prompt-count ${promptLength > 20_000 ? 'error' : ''}`}>{promptLength.toLocaleString()} / 20,000</div><AIProviderSelect value={provider} onChange={onProvider}/><div className="tray-actions"><button disabled={invalid} onClick={() => onAsk('draft')}>Insert draft</button><button className="primary-button" disabled={invalid} onClick={() => onAsk('send')}>Send now</button></div>{items.length > 0 && <button className="clear-tray" onClick={() => { if (window.confirm('Clear the research tray?')) onClear() }}>Clear tray</button>}</div>
}

function AnnotationDetail({ annotation, provider, onProvider, onClose, onNote, onTray, onAsk, onOpen, onRemoveLink }: { annotation: Annotation; provider: AIProviderId; onProvider: (provider: AIProviderId) => void; onClose: () => void; onNote: (note: string) => void; onTray: () => void; onAsk: (mode: 'draft' | 'send') => void; onOpen: (link: NonNullable<Annotation['conversationLinks']>[number]) => void; onRemoveLink: (id: string) => void }): React.JSX.Element {
  const text = annotation.type === 'highlight' ? annotation.selectedText || annotation.note : annotation.note
  return <aside className="annotation-detail"><header><strong>{annotation.type === 'highlight' ? 'Highlight' : 'Ink'} · page {annotation.pageIndex + 1}</strong><button onClick={onClose}><X size={14}/></button></header>{annotation.type === 'highlight' && annotation.selectedText && <blockquote>{annotation.selectedText}</blockquote>}<label>Note<textarea value={annotation.note ?? ''} onChange={(event) => onNote(event.target.value.slice(0, 20_000))}/></label><AIProviderSelect value={provider} onChange={onProvider}/><div className="detail-actions"><button disabled={!text?.trim()} onClick={onTray}>Add to tray</button><button disabled={!text?.trim()} onClick={() => onAsk('draft')}>Insert draft</button><button disabled={!text?.trim()} onClick={() => onAsk('send')}>Send now</button></div>{annotation.conversationLinks?.map((link) => <div className="conversation-link" key={link.id}><button onClick={() => onOpen(link)}>{AI_PROVIDERS.find((item) => item.id === link.provider)?.name}: {link.title}</button><button onClick={() => onRemoveLink(link.id)}><X size={12}/></button></div>)}</aside>
}

function Thumbnail({ pageNumber, getPage, active, onClick }: { pageNumber: number; getPage: (page: number) => Promise<PDFPageProxy>; active: boolean; onClick: () => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null); const hostRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { const host = hostRef.current; if (!host) return; let rendered = false; let task: ReturnType<PDFPageProxy['render']> | undefined; const observer = new IntersectionObserver((entries) => { if (!entries[0]?.isIntersecting || rendered) return; rendered = true; void getPage(pageNumber).then((page) => { const viewport = page.getViewport({ scale: .18 }); const canvas = canvasRef.current; if (!canvas) return; canvas.width = viewport.width; canvas.height = viewport.height; const context = canvas.getContext('2d'); if (context) task = page.render({ canvas, canvasContext: context, viewport }) }) }, { rootMargin: '300px' }); observer.observe(host); return () => { observer.disconnect(); task?.cancel() } }, [getPage, pageNumber])
  return <button ref={hostRef} className={`thumbnail ${active ? 'active' : ''}`} onClick={onClick}><canvas ref={canvasRef}/><span>{pageNumber}</span></button>
}
function PasswordDialog({ incorrect, onSubmit, onCancel }: { incorrect: boolean; onSubmit: (password: string) => void; onCancel: () => void }): React.JSX.Element { const [password, setPassword] = useState(''); return <div className="modal-backdrop"><form className="modal" onSubmit={(event) => { event.preventDefault(); onSubmit(password) }}><h2>Protected PDF</h2><p>{incorrect ? 'That password was not accepted. Try again.' : 'Enter the document password to continue.'}</p><input type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)}/><div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit">Unlock</button></div></form></div> }
