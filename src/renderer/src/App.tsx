import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { BrowserPane } from './components/BrowserPane'
import { PdfWorkspace } from './components/PdfWorkspace'
import { WorkspaceChooser, WorkspaceMenu } from './components/WorkspaceMenu'
import type { ReflowTypographySettings, ResearchWorkspace, RightPaneMode, UiState, WorkspaceLibrarySettings } from '../../shared/types'
import { useWorkspaceStore } from './store'
import { flushWorkspaceEditors, registerWorkspaceFlusher } from './persistence'

const NotesPane = lazy(() => import('./components/NotesPane').then((module) => ({ default: module.NotesPane })))
const GraphPane = lazy(() => import('./components/GraphPane').then((module) => ({ default: module.GraphPane })))

export function App(): React.JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const [splitRatio, setSplitRatio] = useState(0.55)
  const [dragging, setDragging] = useState(false)
  const [ready, setReady] = useState(false)
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>('browser')
  const [loadedSurfaces, setLoadedSurfaces] = useState({ notes: false, graph: false })
  const [rightPaneCollapsed, setRightPaneCollapsed] = useState(false)
  const [browserRevealReady, setBrowserRevealReady] = useState(false)
  const [appOverlayOpen, setAppOverlayOpen] = useState(false)
  const [reflowTypography, setReflowTypography] = useState<ReflowTypographySettings>({ fontScale: 1, lineHeight: 1.65, measure: 68 })
  const [library, setLibrary] = useState<WorkspaceLibrarySettings>({ rootLabel: '', workspaces: [], activeWorkspaceId: null })
  const activeDocument = useWorkspaceStore((state) => state.activeDocumentId ? state.documents[state.activeDocumentId] : undefined)
  const setCurrentPage = useWorkspaceStore((state) => state.setCurrentPage)

  useEffect(() => {
    void Promise.all([window.koibill.getUiState(), window.koibill.getWorkspaceLibrary()]).then(([{ splitRatio: stored, rightPaneMode: mode, rightPaneCollapsed: collapsed, reflowTypography: typography }, nextLibrary]) => {
      setSplitRatio(stored)
      setRightPaneMode(mode)
      setRightPaneCollapsed(collapsed)
      setReflowTypography(typography)
      setLibrary(nextLibrary)
      setReady(true)
    })
  }, [])

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent): void => {
      const shell = shellRef.current
      if (!shell) return
      const rect = shell.getBoundingClientRect()
      setSplitRatio(Math.min(0.8, Math.max(0.25, (event.clientX - rect.left) / rect.width)))
    }
    const stop = (): void => {
      setDragging(false)
      void window.koibill.saveUiState({ splitRatio })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  }, [dragging, splitRatio])

  useEffect(() => {
    if (!ready) return
    const timeout = window.setTimeout(() => void window.koibill.saveUiState({ rightPaneMode }), 300)
    return () => window.clearTimeout(timeout)
  }, [ready, rightPaneMode])

  useEffect(() => {
    if (rightPaneMode === 'notes' || rightPaneMode === 'graph') {
      setLoadedSurfaces((current) => current[rightPaneMode] ? current : { ...current, [rightPaneMode]: true })
    }
  }, [rightPaneMode])

  useEffect(() => {
    if (!ready) return
    const timeout = window.setTimeout(() => void window.koibill.saveUiState({ rightPaneCollapsed }), 150)
    return () => window.clearTimeout(timeout)
  }, [ready, rightPaneCollapsed])

  useEffect(() => {
    if (!ready) return
    const timeout = window.setTimeout(() => void window.koibill.saveUiState({ reflowTypography }), 250)
    return () => window.clearTimeout(timeout)
  }, [ready, reflowTypography])

  useEffect(() => {
    if (rightPaneCollapsed) { setBrowserRevealReady(false); return }
    const timeout = window.setTimeout(() => setBrowserRevealReady(true), 190)
    return () => window.clearTimeout(timeout)
  }, [rightPaneCollapsed])

  useEffect(() => {
    const update = (): void => setAppOverlayOpen(Boolean(document.querySelector('.modal-backdrop, .import-overlay, .ui-popover, .workspace-menu')))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    update()
    return () => observer.disconnect()
  }, [])

  const showRightPane = useCallback((mode: RightPaneMode): void => {
    setRightPaneMode(mode)
    setRightPaneCollapsed(false)
  }, [])

  const toggleRightPane = useCallback((): void => setRightPaneCollapsed((collapsed) => !collapsed), [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== '\\' || isEditableTarget(event.target)) return
      event.preventDefault()
      toggleRightPane()
    }
    window.addEventListener('keydown', keydown)
    const offRemoteToggle = window.koibill.onRightPaneToggleRequested(toggleRightPane)
    return () => { window.removeEventListener('keydown', keydown); offRemoteToggle() }
  }, [toggleRightPane])

  useEffect(() => window.koibill.onBrowserShowRequested(() => showRightPane('browser')), [showRightPane])

  useEffect(() => window.koibill.onWorkspaceFlushRequest(() => {
    void window.koibill.saveUiState({ splitRatio, rightPaneMode, rightPaneCollapsed })
    void (async () => {
      try {
        await flushWorkspaceEditors()
        const current = useWorkspaceStore.getState()
        const viewStates = Object.fromEntries(current.order.flatMap((id) => {
          const document = current.documents[id]
          return document ? [[id, { zoom: document.zoom, rotation: document.rotation, currentPage: document.currentPage, focus: document.focus, reflow: document.reflow }]] : []
        }))
        await window.koibill.completeWorkspaceFlush([], { documentIds: current.order, activeDocumentId: current.activeDocumentId, viewStates, tray: current.tray, question: current.question, comparisons: current.comparisons })
      } catch (error) { window.alert(`Unable to close safely: ${String(error)}`) }
    })()
  }), [splitRatio, rightPaneMode, rightPaneCollapsed])

  useEffect(() => registerWorkspaceFlusher(() => window.koibill.saveUiState({ splitRatio, rightPaneMode, rightPaneCollapsed })), [splitRatio, rightPaneMode, rightPaneCollapsed])

  const applyWorkspace = (workspace: ResearchWorkspace, ui?: UiState): void => {
    useWorkspaceStore.getState().restore(workspace)
    if (ui) { setSplitRatio(ui.splitRatio); setRightPaneMode(ui.rightPaneMode) }
  }

  if (!ready) return <div className="app-loading">koibill</div>

  return (
    <div className="app-root">
    <WorkspaceMenu library={library} onLibrary={setLibrary} onWorkspace={applyWorkspace}/>
    {!library.activeWorkspaceId ? <WorkspaceChooser library={library} onLibrary={setLibrary} onWorkspace={applyWorkspace}/> : <main ref={shellRef} className={`app-shell ${dragging ? 'resizing' : ''} ${rightPaneCollapsed ? 'right-collapsed' : ''}`} style={{ gridTemplateColumns: rightPaneCollapsed ? 'calc(100% - 28px) 28px 0px' : `calc(${splitRatio * 100}% - 3px) 6px calc(${(1 - splitRatio) * 100}% - 3px)` }}>
      <PdfWorkspace typography={reflowTypography} onTypography={setReflowTypography}/>
      <div className="split-handle" role="separator" aria-label="Resize panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={80} aria-valuenow={Math.round(splitRatio * 100)} onPointerDown={() => { if (!rightPaneCollapsed) setDragging(true) }}><button className="pane-collapse-button" aria-label={rightPaneCollapsed ? 'Expand right pane' : 'Collapse right pane'} aria-expanded={!rightPaneCollapsed} title={`${rightPaneCollapsed ? 'Expand' : 'Collapse'} right pane (Ctrl+\\)`} onPointerDown={(event) => event.stopPropagation()} onClick={toggleRightPane}>{rightPaneCollapsed ? <PanelRightOpen size={15}/> : <PanelRightClose size={15}/>}</button></div>
      <section className="right-workspace" aria-label="Browser and notes workspace" aria-hidden={rightPaneCollapsed}>
        <nav className="right-mode-switcher" aria-label="Right pane mode">
          <button className={rightPaneMode === 'browser' ? 'active' : ''} onClick={() => setRightPaneMode('browser')}>Browser</button>
          <button className={rightPaneMode === 'notes' ? 'active' : ''} onClick={() => setRightPaneMode('notes')}>Notes</button>
          <button className={rightPaneMode === 'graph' ? 'active' : ''} onClick={() => setRightPaneMode('graph')}>Graph</button>
        </nav>
        <div className={`right-surface ${rightPaneMode === 'browser' ? 'visible' : 'hidden'}`} aria-hidden={rightPaneMode !== 'browser'}>
          <BrowserPane active={!rightPaneCollapsed && browserRevealReady && !appOverlayOpen && rightPaneMode === 'browser'} layoutKey={Math.round(splitRatio * 10_000) + (rightPaneCollapsed ? 1 : 0) + (appOverlayOpen ? 2 : 0)} />
        </div>
        <div className={`right-surface ${rightPaneMode === 'notes' ? 'visible' : 'hidden'}`} aria-hidden={rightPaneMode !== 'notes'}>
          {loadedSurfaces.notes ? <Suspense fallback={<SurfaceLoading label="Loading notes…"/>}><NotesPane
            active={rightPaneMode === 'notes'}
            sessionId={activeDocument?.session?.id}
            documentName={activeDocument?.descriptor.name}
            pageNumber={activeDocument?.currentPage ?? 1}
            onOpenBrowser={() => showRightPane('browser')}
          /></Suspense> : null}
        </div>
        <div className={`right-surface ${rightPaneMode === 'graph' ? 'visible' : 'hidden'}`} aria-hidden={rightPaneMode !== 'graph'}>
          {loadedSurfaces.graph ? <Suspense fallback={<SurfaceLoading label="Loading graph…"/>}><GraphPane
            active={rightPaneMode === 'graph'}
            sessionId={activeDocument?.session?.id}
            documentId={activeDocument?.session?.documentId}
            fingerprint={activeDocument?.session?.fingerprint}
            documentName={activeDocument?.descriptor.name}
            pageNumber={activeDocument?.currentPage ?? 1}
            onShowGraph={() => showRightPane('graph')}
            onShowBrowser={() => showRightPane('browser')}
            onGoToPage={(page) => {
              const documentId = activeDocument?.session?.documentId
              if (!documentId) return
              setCurrentPage(documentId, page)
              requestAnimationFrame(() => document.getElementById(`pdf-page-${page}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
            }}
          /></Suspense> : null}
        </div>
      </section>
    </main>}
    </div>
  )
}

function SurfaceLoading({ label }: { label: string }): React.JSX.Element {
  return <div className="surface-loading" role="status">{label}</div>
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
}
