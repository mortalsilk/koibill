import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, GripVertical, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import type { AskAIFailure, BrowserState } from '../../../shared/types'
import { getAIProvider } from '../../../shared/ai-providers'

export function BrowserPane({ layoutKey, active: paneActive }: { layoutKey: number; active: boolean }): React.JSX.Element {
  const paneRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>({ tabs: [], activeTabId: null })
  const [address, setAddress] = useState('')
  const [failure, setFailure] = useState<AskAIFailure | null>(null)
  const [blockedDownload, setBlockedDownload] = useState<string | null>(null)
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)

  useEffect(() => {
    void window.koibill.getBrowserState().then(setState)
    const offState = window.koibill.onBrowserState(setState)
    const offFailure = window.koibill.onAskAIFailure((next) => {
      // Comparison failures are tracked per provider in Research, where one
      // provider cannot overwrite another provider's recovery controls.
      if (!next.request.comparisonId) setFailure(next)
    })
    const offAskStatus = window.koibill.onAskAIStatus((status) => {
      if (status.state === 'inserted' || status.state === 'linked') setFailure((current) => current?.request.requestId === status.requestId ? null : current)
    })
    const offDownload = window.koibill.onDownloadBlocked(setBlockedDownload)
    return () => { offState(); offFailure(); offAskStatus(); offDownload() }
  }, [])

  useEffect(() => setAddress(active?.url ?? ''), [active?.url])

  useEffect(() => {
    window.koibill.setBrowserVisible(paneActive)
    return () => window.koibill.setBrowserVisible(false)
  }, [paneActive])

  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element) return
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        if (paneActive) window.koibill.setBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    update()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', update) }
  }, [layoutKey, paneActive])

  useEffect(() => {
    if (!paneActive) return
    const keydown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !active) return
      if (!paneRef.current?.contains(event.target as Node)) return
      if (event.key === '+' || event.key === '=') { event.preventDefault(); command({ type: 'zoom-in', tabId: active.id }) }
      if (event.key === '-') { event.preventDefault(); command({ type: 'zoom-out', tabId: active.id }) }
      if (event.key === '0') { event.preventDefault(); command({ type: 'zoom-reset', tabId: active.id }) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [paneActive, active?.id])

  const command = (value: Parameters<typeof window.koibill.browserCommand>[0]): void => {
    void window.koibill.browserCommand(value)
  }

  const dropTab = (sourceId: string, targetId: string): void => {
    const source = state.tabs.findIndex((tab) => tab.id === sourceId)
    const target = state.tabs.findIndex((tab) => tab.id === targetId)
    if (source < 0 || target < 0 || source === target) return
    void (async () => {
      const direction = source < target ? 1 : -1
      for (let index = source; index !== target; index += direction) {
        await window.koibill.browserCommand({ type: 'move', tabId: sourceId, direction })
      }
    })()
  }

  return (
    <section ref={paneRef} className="browser-pane" aria-label="Browser">
      <div className="tab-strip" role="tablist" aria-label="Browser tabs">
        {state.tabs.map((tab) => (
          <div
            className={`browser-tab ${tab.active ? 'active' : ''}`}
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('text/koibill-tab', tab.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); dropTab(event.dataTransfer.getData('text/koibill-tab'), tab.id) }}
          >
            <button className="tab-main" title={tab.title} onClick={() => command({ type: 'activate', tabId: tab.id })}>
              {tab.loading ? <LoaderCircle className="spin" size={13} /> : tab.favicon ? <img src={tab.favicon} alt="" /> : null}
              <span>{tab.title || 'New tab'}</span>
            </button>
            <button className="icon-button small" aria-label={`Close ${tab.title}`} onClick={() => command({ type: 'close', tabId: tab.id })}><X size={13} /></button>
          </div>
        ))}
        <button className="icon-button" aria-label="New tab" onClick={() => command({ type: 'new-tab' })}><Plus size={16} /></button>
      </div>
      <div className="browser-toolbar">
        <button className="icon-button" aria-label="Back" disabled={!active?.canGoBack} onClick={() => active && command({ type: 'back', tabId: active.id })}><ArrowLeft size={17} /></button>
        <button className="icon-button browser-forward" aria-label="Forward" disabled={!active?.canGoForward} onClick={() => active && command({ type: 'forward', tabId: active.id })}><ArrowRight size={17} /></button>
        <button className="icon-button" aria-label={active?.loading ? 'Stop' : 'Reload'} onClick={() => active && command({ type: active.loading ? 'stop' : 'reload', tabId: active.id })}>
          {active?.loading ? <X size={17} /> : <RefreshCw size={16} />}
        </button>
        <form className="address-form" onSubmit={(event) => { event.preventDefault(); if (active) command({ type: 'navigate', tabId: active.id, value: address }) }}>
          <Search size={14} />
          <input aria-label="Address" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} />
        </form>
        <div className="browser-zoom" aria-label="Browser zoom">
          <button className="icon-button small" aria-label="Zoom out" title="Zoom out" onClick={() => active && command({ type: 'zoom-out', tabId: active.id })}><Minus size={14}/></button>
          <button className="browser-zoom-value" title="Reset zoom" onClick={() => active && command({ type: 'zoom-reset', tabId: active.id })}>{Math.round((active?.zoomFactor ?? 1) * 100)}%</button>
          <button className="icon-button small" aria-label="Zoom in" title="Zoom in" onClick={() => active && command({ type: 'zoom-in', tabId: active.id })}><Plus size={14}/></button>
        </div>
        <button className="icon-button browser-external" aria-label="Open in system browser" onClick={() => active && command({ type: 'external', tabId: active.id })}><ExternalLink size={16} /></button>
      </div>
      <div className="browser-notices">
        {failure && (
          <div className="browser-notice" role="alert">
            <span>{failure.message}</span>
            <button onClick={() => { window.koibill.retryAskAI(failure.request); setFailure(null) }}>Retry</button>
            <button onClick={() => { void window.koibill.copyText(failure.prompt); setFailure(null) }}>Copy prompt</button>
            <button onClick={() => command({ type: 'external-url', url: getAIProvider(failure.request.provider).homeUrl })}>Open externally</button>
            <button className="icon-button small" aria-label="Dismiss" onClick={() => setFailure(null)}><X size={13} /></button>
          </div>
        )}
        {blockedDownload && (
          <div className="browser-notice" role="alert">
            <span>Downloads are disabled inside koibill.</span>
            <button onClick={() => { command({ type: 'external-url', url: blockedDownload }); setBlockedDownload(null) }}>Open in system browser</button>
            <button className="icon-button small" aria-label="Dismiss" onClick={() => setBlockedDownload(null)}><X size={13} /></button>
          </div>
        )}
        {active?.error && (
          <div className="browser-notice" role="alert">
            <span>{active.error}</span>
            <button onClick={() => command({ type: 'recover', tabId: active.id })}><RotateCcw size={13}/> Recover page</button>
          </div>
        )}
      </div>
      <div ref={contentRef} className="browser-content" aria-label="Web page surface">
        {!active && <div className="browser-empty"><GripVertical size={22} /><p>No browser tab open</p></div>}
      </div>
    </section>
  )
}
