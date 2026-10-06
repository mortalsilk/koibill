import { contextBridge, ipcRenderer } from 'electron'
import type { AnnotationFlushEntry, AskAIFailure, AskAIRequest, AskAIStatus, BrowserBounds, BrowserCommand, BrowserState, GraphAppendPayload, KoibillApi, PdfImportProgress, ResearchTrayItem } from '../shared/types'

const api: KoibillApi = {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  importPdfs: () => ipcRenderer.invoke('pdf:import'),
  cancelPdfImport: (operationId) => ipcRenderer.send('pdf:import-cancel', operationId),
  onPdfImportProgress: (callback: (progress: PdfImportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: PdfImportProgress): void => callback(progress)
    ipcRenderer.on('pdf:import-progress', listener)
    return () => ipcRenderer.removeListener('pdf:import-progress', listener)
  },
  getWorkspaceLibrary: () => ipcRenderer.invoke('workspace:library'),
  createWorkspace: (name) => ipcRenderer.invoke('workspace:create', name),
  openWorkspace: () => ipcRenderer.invoke('workspace:open-existing'),
  switchWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:switch', workspaceId),
  renameWorkspace: (workspaceId, name) => ipcRenderer.invoke('workspace:rename', workspaceId, name),
  unregisterWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:unregister', workspaceId),
  revealWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:reveal', workspaceId),
  chooseWorkspaceRoot: () => ipcRenderer.invoke('workspace:choose-root'),
  openRecentPdf: (id) => ipcRenderer.invoke('pdf:open-recent', id),
  restoreWorkspace: () => ipcRenderer.invoke('workspace:restore'),
  loadWorkspacePdf: (documentId) => ipcRenderer.invoke('workspace:load-pdf', documentId),
  locateWorkspacePdf: (documentId) => ipcRenderer.invoke('workspace:locate-pdf', documentId),
  saveWorkspace: (state) => ipcRenderer.invoke('workspace:save', state),
  closeWorkspacePdf: (documentId) => ipcRenderer.invoke('workspace:close-pdf', documentId),
  completeWorkspaceFlush: (entries: AnnotationFlushEntry[], state) => ipcRenderer.invoke('workspace:flush-complete', entries, state),
  onWorkspaceFlushRequest: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('workspace:flush-request', listener)
    return () => ipcRenderer.removeListener('workspace:flush-request', listener)
  },
  getRecentPdfs: () => ipcRenderer.invoke('pdf:recents'),
  saveAnnotations: (sessionId, document) => ipcRenderer.invoke('pdf:save-annotations', sessionId, document),
  getPageNote: (sessionId, pageNumber) => ipcRenderer.invoke('notes:get', sessionId, pageNumber),
  createPageNote: (sessionId, pageNumber) => ipcRenderer.invoke('notes:create', sessionId, pageNumber),
  savePageNote: (sessionId, pageNumber, content) => ipcRenderer.invoke('notes:save', sessionId, pageNumber, content),
  getDocumentNote: (sessionId) => ipcRenderer.invoke('notes:document:get', sessionId),
  createDocumentNote: (sessionId) => ipcRenderer.invoke('notes:document:create', sessionId),
  saveDocumentNote: (sessionId, content) => ipcRenderer.invoke('notes:document:save', sessionId, content),
  getGraph: (sessionId) => ipcRenderer.invoke('graph:get', sessionId),
  saveGraph: (sessionId, graph) => ipcRenderer.invoke('graph:save', sessionId, graph),
  exportAnnotatedPdf: (sessionId, document) => ipcRenderer.invoke('pdf:export', sessionId, document),
  showSelectionMenu: (request) => ipcRenderer.send('pdf:selection-menu', request),
  askAI: (request) => ipcRenderer.invoke('ask-ai:run', request),
  cancelAskAI: (requestId) => ipcRenderer.send('ask-ai:cancel', requestId),
  retryAskAI: (request: AskAIRequest) => ipcRenderer.send('ask-ai:retry', request),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  setBrowserBounds: (bounds: BrowserBounds) => ipcRenderer.send('browser:bounds', bounds),
  setBrowserVisible: (visible: boolean) => ipcRenderer.send('browser:visible', visible),
  browserCommand: (command: BrowserCommand) => ipcRenderer.invoke('browser:command', command),
  getBrowserState: () => ipcRenderer.invoke('browser:state:get'),
  onBrowserState: (callback: (state: BrowserState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
    ipcRenderer.on('browser:state', listener)
    return () => ipcRenderer.removeListener('browser:state', listener)
  },
  onAskAIFailure: (callback: (failure: AskAIFailure) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, failure: AskAIFailure): void => callback(failure)
    ipcRenderer.on('ask-ai:failure', listener)
    return () => ipcRenderer.removeListener('ask-ai:failure', listener)
  },
  onAskAIStatus: (callback: (status: AskAIStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AskAIStatus): void => callback(status)
    ipcRenderer.on('ask-ai:status', listener)
    return () => ipcRenderer.removeListener('ask-ai:status', listener)
  },
  onResearchTrayItem: (callback: (item: ResearchTrayItem) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, item: ResearchTrayItem): void => callback(item)
    ipcRenderer.on('research:tray:add', listener)
    return () => ipcRenderer.removeListener('research:tray:add', listener)
  },
  onGraphAppend: (callback: (payload: GraphAppendPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GraphAppendPayload): void => callback(payload)
    ipcRenderer.on('graph:append', listener)
    return () => ipcRenderer.removeListener('graph:append', listener)
  },
  onDownloadBlocked: (callback: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string): void => callback(url)
    ipcRenderer.on('browser:download-blocked', listener)
    return () => ipcRenderer.removeListener('browser:download-blocked', listener)
  },
  onBrowserShowRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('browser:show-requested', listener)
    return () => ipcRenderer.removeListener('browser:show-requested', listener)
  },
  onRightPaneToggleRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('ui:toggle-right-pane', listener)
    return () => ipcRenderer.removeListener('ui:toggle-right-pane', listener)
  },
  saveUiState: (state) => ipcRenderer.invoke('ui:save', state),
  getUiState: () => ipcRenderer.invoke('ui:get'),
}

contextBridge.exposeInMainWorld('koibill', api)
