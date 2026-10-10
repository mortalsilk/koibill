import path from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AnnotationFlushEntry, AskAIComposerSeed, BrowserBounds, BrowserCommand, GraphAppendPayload, ResearchTrayItem, SelectionMenuRequest } from '../shared/types'
import { isAnnotationDocument, isAskAIComparisonRequest, isAskAIRequest, isBrowserBounds, isBrowserCommand, isGraphDocument, isSemanticDocument, isWorkspaceUiState } from '../shared/validation'
import { BrowserTabs } from './browser-tabs'
import { isAIProviderId } from '../shared/ai-providers'
import { exportAnnotatedPdf } from './pdf-export'
import { PdfSessionManager, SettingsStore } from './storage'
import { WorkspaceLibrary } from './workspace-library'

let mainWindow: BrowserWindow | null = null
let browserTabs: BrowserTabs | null = null
let allowWindowClose = false
let rendererRecoveryAttempts = 0
let rendererRecoveryReset: NodeJS.Timeout | undefined
const settings = new SettingsStore()
const workspaceLibrary = new WorkspaceLibrary(settings, (progress) => mainWindow?.webContents.send('pdf:import-progress', progress))
const pdfSessions = new PdfSessionManager(settings, workspaceLibrary)

app.enableSandbox()

function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return event.sender === mainWindow?.webContents
}

async function createWindow(): Promise<void> {
  allowWindowClose = false
  const storedBounds = settings.snapshot.windowBounds
  mainWindow = new BrowserWindow({
    width: storedBounds?.width ?? 1440,
    height: storedBounds?.height ?? 900,
    x: storedBounds?.x,
    y: storedBounds?.y,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: Boolean(process.env.ELECTRON_RENDERER_URL),
    },
  })

  browserTabs = new BrowserTabs(mainWindow, settings, (failure) => {
    mainWindow?.webContents.send('ask-ai:failure', failure)
  }, (status) => {
    mainWindow?.webContents.send('ask-ai:status', status)
  }, () => mainWindow?.webContents.send('browser:show-requested'), (payload) => {
    mainWindow?.webContents.send('graph:append', payload)
  }, () => mainWindow?.webContents.send('ui:toggle-right-pane'), workspaceLibrary.activeBrowser, (state) => { void workspaceLibrary.setBrowser(state).catch((error) => console.warn('Unable to save browser workspace state', error)) })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.on('close', (event) => {
    if (!mainWindow) return
    settings.update({ windowBounds: mainWindow.getBounds() })
    if (!allowWindowClose) {
      event.preventDefault()
      mainWindow.webContents.send('workspace:flush-request')
    }
  })
  mainWindow.on('show', () => browserTabs?.refreshActiveView())
  mainWindow.on('restore', () => browserTabs?.refreshActiveView())
  mainWindow.on('focus', () => browserTabs?.refreshActiveView())
  mainWindow.on('maximize', () => browserTabs?.refreshActiveView())
  mainWindow.on('unmaximize', () => browserTabs?.refreshActiveView())
  mainWindow.on('closed', () => {
    browserTabs?.destroy()
    browserTabs = null
    mainWindow = null
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (rendererRecoveryReset) clearTimeout(rendererRecoveryReset)
    rendererRecoveryReset = setTimeout(() => { rendererRecoveryAttempts = 0; rendererRecoveryReset = undefined }, 30_000)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!mainWindow || mainWindow.isDestroyed() || details.reason === 'clean-exit') return
    console.error(`koibill renderer stopped (${details.reason})`)
    if (rendererRecoveryAttempts >= 1) return
    rendererRecoveryAttempts += 1
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload() }, 350)
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) await mainWindow.loadURL(developmentUrl)
  else await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  await browserTabs.initialize()
}

function registerIpc(): void {
  ipcMain.handle('pdf:open', (event) => isTrustedSender(event) ? pdfSessions.openFromDialog() : null)
  ipcMain.handle('pdf:import', (event) => isTrustedSender(event) ? pdfSessions.importFromDialog() : { sessions: [] })
  ipcMain.on('pdf:import-cancel', (event, operationId: unknown) => {
    if (isTrustedSender(event) && typeof operationId === 'string') workspaceLibrary.cancelImport(operationId)
  })
  ipcMain.handle('workspace:library', (event) => isTrustedSender(event) ? workspaceLibrary.getLibrary() : null)
  const transition = async (operation: () => Promise<import('../shared/types').WorkspaceSwitchResult>) => {
    if (workspaceLibrary.hasActiveImport) throw new Error('Finish or cancel the PDF import before changing workspaces.')
    await workspaceLibrary.setBrowser(browserTabs?.getWorkspaceState() ?? workspaceLibrary.activeBrowser)
    await pdfSessions.flush()
    const result = await operation()
    if (result.switched) {
      browserTabs?.cancelAllPending('Workspace changed.')
      pdfSessions.releaseAll()
      await browserTabs?.replaceWorkspaceState(workspaceLibrary.activeBrowser)
    }
    return result
  }
  ipcMain.handle('workspace:create', (event, name: unknown) => {
    if (!isTrustedSender(event) || typeof name !== 'string') throw new Error('Invalid workspace name.')
    return transition(() => workspaceLibrary.create(name))
  })
  ipcMain.handle('workspace:open-existing', (event) => isTrustedSender(event) ? transition(() => workspaceLibrary.openExisting()) : { switched: false })
  ipcMain.handle('workspace:switch', (event, id: unknown) => {
    if (!isTrustedSender(event) || typeof id !== 'string') throw new Error('Invalid workspace.')
    return transition(() => workspaceLibrary.switchTo(id))
  })
  ipcMain.handle('workspace:rename', async (event, id: unknown, name: unknown) => {
    if (!isTrustedSender(event) || typeof id !== 'string' || typeof name !== 'string') throw new Error('Invalid workspace rename.')
    if (workspaceLibrary.hasActiveImport) throw new Error('Finish or cancel the PDF import before renaming the workspace.')
    await pdfSessions.flush()
    return workspaceLibrary.rename(id, name)
  })
  ipcMain.handle('workspace:unregister', async (event, id: unknown) => {
    if (!isTrustedSender(event) || typeof id !== 'string') throw new Error('Invalid workspace.')
    if (workspaceLibrary.hasActiveImport) throw new Error('Finish or cancel the PDF import before closing the workspace.')
    if (workspaceLibrary.activeId === id) {
      await workspaceLibrary.setBrowser(browserTabs?.getWorkspaceState() ?? workspaceLibrary.activeBrowser)
      browserTabs?.cancelAllPending('Workspace closed.'); pdfSessions.releaseAll()
    }
    workspaceLibrary.unregister(id)
    if (!workspaceLibrary.activeId) await browserTabs?.replaceWorkspaceState(workspaceLibrary.activeBrowser)
    return workspaceLibrary.getLibrary()
  })
  ipcMain.handle('workspace:reveal', (event, id: unknown) => {
    if (!isTrustedSender(event) || typeof id !== 'string') throw new Error('Invalid workspace.')
    return workspaceLibrary.reveal(id)
  })
  ipcMain.handle('workspace:choose-root', async (event) => {
    if (!isTrustedSender(event)) return workspaceLibrary.getLibrary()
    await workspaceLibrary.chooseRoot()
    return workspaceLibrary.getLibrary()
  })
  ipcMain.handle('pdf:open-recent', (event, id: unknown) => {
    if (!isTrustedSender(event) || typeof id !== 'string') return null
    return pdfSessions.openRecent(id)
  })
  ipcMain.handle('workspace:restore', (event) => isTrustedSender(event) ? pdfSessions.restoreWorkspace() : null)
  ipcMain.handle('workspace:load-pdf', (event, documentId: unknown) => {
    if (!isTrustedSender(event) || typeof documentId !== 'string') return null
    return pdfSessions.loadWorkspaceDocument(documentId)
  })
  ipcMain.handle('workspace:locate-pdf', (event, documentId: unknown) => {
    if (!isTrustedSender(event) || typeof documentId !== 'string') return null
    return pdfSessions.locateWorkspaceDocument(documentId)
  })
  ipcMain.handle('workspace:save', (event, state: unknown) => {
    if (!isTrustedSender(event) || !isWorkspaceUiState(state)) throw new Error('Invalid workspace state.')
    return pdfSessions.saveWorkspace(state)
  })
  ipcMain.handle('workspace:close-pdf', (event, documentId: unknown) => {
    if (!isTrustedSender(event) || typeof documentId !== 'string') return
    return pdfSessions.closeWorkspaceDocument(documentId)
  })
  ipcMain.handle('workspace:flush-complete', async (event, entries: unknown, state: unknown) => {
    if (!isTrustedSender(event) || !Array.isArray(entries) || entries.length > 100 || !isWorkspaceUiState(state)) throw new Error('Invalid workspace flush.')
    const validated: AnnotationFlushEntry[] = []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid workspace flush entry.')
      const candidate = entry as Partial<AnnotationFlushEntry>
      if (typeof candidate.sessionId !== 'string' || !isAnnotationDocument(candidate.document)) throw new Error('Invalid workspace flush entry.')
      validated.push(candidate as AnnotationFlushEntry)
    }
    await workspaceLibrary.cancelAllImports()
    await Promise.all(validated.map((entry) => pdfSessions.saveAnnotations(entry.sessionId, entry.document)))
    await pdfSessions.saveWorkspace(state)
    await workspaceLibrary.setBrowser(browserTabs?.getWorkspaceState() ?? workspaceLibrary.activeBrowser)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await pdfSessions.flush()
    await settings.flush()
    allowWindowClose = true
    browserTabs?.destroy()
    browserTabs = null
    setImmediate(() => mainWindow?.close())
  })
  ipcMain.handle('pdf:recents', (event) => isTrustedSender(event) ? pdfSessions.getRecents() : [])
  ipcMain.handle('pdf:save-annotations', (event, sessionId: unknown, document: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isAnnotationDocument(document)) throw new Error('Invalid annotation save request.')
    return pdfSessions.saveAnnotations(sessionId, document)
  })
  ipcMain.handle('notes:get', (event, sessionId: unknown, pageNumber: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isPageNumber(pageNumber)) throw new Error('Invalid note request.')
    return pdfSessions.getPageNote(sessionId, pageNumber)
  })
  ipcMain.handle('notes:create', (event, sessionId: unknown, pageNumber: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isPageNumber(pageNumber)) throw new Error('Invalid note request.')
    return pdfSessions.createPageNote(sessionId, pageNumber)
  })
  ipcMain.handle('notes:save', (event, sessionId: unknown, pageNumber: unknown, content: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isPageNumber(pageNumber)
      || typeof content !== 'string' || content.length > 1_000_000) throw new Error('Invalid note save request.')
    return pdfSessions.savePageNote(sessionId, pageNumber, content)
  })
  ipcMain.handle('notes:document:get', (event, sessionId: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string') throw new Error('Invalid document note request.')
    return pdfSessions.getDocumentNote(sessionId)
  })
  ipcMain.handle('notes:document:create', (event, sessionId: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string') throw new Error('Invalid document note request.')
    return pdfSessions.createDocumentNote(sessionId)
  })
  ipcMain.handle('notes:document:save', (event, sessionId: unknown, content: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || typeof content !== 'string' || content.length > 1_000_000) throw new Error('Invalid document note save request.')
    return pdfSessions.saveDocumentNote(sessionId, content)
  })
  ipcMain.handle('graph:get', (event, sessionId: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string') throw new Error('Invalid graph request.')
    return pdfSessions.getGraph(sessionId)
  })
  ipcMain.handle('graph:save', (event, sessionId: unknown, graph: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isGraphDocument(graph)) throw new Error('Invalid graph save request.')
    return pdfSessions.saveGraph(sessionId, graph)
  })
  ipcMain.handle('reflow:get', (event, sessionId: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string') throw new Error('Invalid reflow cache request.')
    return pdfSessions.getReflowCache(sessionId)
  })
  ipcMain.handle('reflow:save', (event, sessionId: unknown, document: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isSemanticDocument(document)) throw new Error('Invalid reflow cache save.')
    return pdfSessions.saveReflowCache(sessionId, document)
  })
  ipcMain.handle('pdf:export', (event, sessionId: unknown, document: unknown) => {
    if (!isTrustedSender(event) || typeof sessionId !== 'string' || !isAnnotationDocument(document)) throw new Error('Invalid PDF export request.')
    return exportAnnotatedPdf(pdfSessions, sessionId, document)
  })
  ipcMain.on('pdf:selection-menu', (event, request: unknown) => {
    if (!isTrustedSender(event) || !request || typeof request !== 'object') return
    const base = request as SelectionMenuRequest
    if (base.kind !== 'selection' || typeof base.text !== 'string' || typeof base.documentId !== 'string'
      || typeof base.sourceFingerprint !== 'string' || typeof base.documentName !== 'string' || !Number.isInteger(base.pageNumber)) return
    const linkTargets = base.annotationId ? [{ documentId: base.documentId, annotationId: base.annotationId }] : []
    const trayItem: ResearchTrayItem = {
      id: randomUUID(), documentId: base.documentId, sourceFingerprint: base.sourceFingerprint,
      documentName: base.documentName, pageNumber: base.pageNumber, text: base.text,
      endPageNumber: base.endPageNumber, sourceSpans: base.sourceSpans,
      annotationId: base.annotationId, createdAt: new Date().toISOString(),
    }
    Menu.buildFromTemplate([
      { label: 'Ask AI…', click: () => {
        const contexts: AskAIComposerSeed['contexts'] = [{
          id: randomUUID(), kind: 'selection', label: 'Selected passage', text: base.text, enabled: true,
          documentId: base.documentId, sourceFingerprint: base.sourceFingerprint, documentName: base.documentName,
          pageNumber: base.pageNumber, endPageNumber: base.endPageNumber, sourceSpans: base.sourceSpans, annotationId: base.annotationId,
        }]
        if (base.nearbyText?.trim()) contexts.push({
          id: randomUUID(), kind: 'nearby', label: 'Surrounding text', text: base.nearbyText.slice(0, 4_000), enabled: false,
          documentId: base.documentId, sourceFingerprint: base.sourceFingerprint, documentName: base.documentName, pageNumber: base.pageNumber,
        })
        mainWindow?.webContents.send('ask-ai:compose', { instruction: 'Please help me understand this passage.', contexts, linkTargets } satisfies AskAIComposerSeed)
      } },
      { label: 'Add to research tray', click: () => mainWindow?.webContents.send('research:tray:add', trayItem) },
      { label: 'Append to graph', click: () => {
        const payload: GraphAppendPayload = {
          documentId: base.documentId,
          source: { kind: 'pdf', excerpt: base.text, pageNumber: base.pageNumber, endPageNumber: base.endPageNumber, sourceSpans: base.sourceSpans, title: base.documentName },
        }
        mainWindow?.webContents.send('graph:append', payload)
      } },
      ...(base.reflow ? [{ label: 'Show in original PDF', click: () => mainWindow?.webContents.send('reflow:show-source', base.documentId, base.pageNumber) }] : []),
      { type: 'separator' },
      { role: 'copy', label: 'Copy' },
    ]).popup({ window: mainWindow ?? undefined })
  })
  ipcMain.handle('ask-ai:run', async (event, request: unknown) => {
    if (!isTrustedSender(event) || !isAskAIRequest(request)) throw new Error('Invalid Ask AI request.')
    await browserTabs?.askAI(request)
  })
  ipcMain.handle('ask-ai:compare', async (event, request: unknown) => {
    if (!isTrustedSender(event) || !isAskAIComparisonRequest(request)) throw new Error('Invalid AI comparison request.')
    await browserTabs?.compareAI(request)
  })
  ipcMain.on('ask-ai:active-comparison', (event, comparisonId: unknown, providers: unknown) => {
    if (!isTrustedSender(event) || (comparisonId !== null && typeof comparisonId !== 'string') || !Array.isArray(providers) || providers.length > 5 || !providers.every(isAIProviderId)) return
    browserTabs?.setActiveComparison(comparisonId, providers)
  })
  ipcMain.on('ask-ai:retry', (event, request: unknown) => {
    if (isTrustedSender(event) && isAskAIRequest(request)) void browserTabs?.askAI(request)
  })
  ipcMain.on('ask-ai:cancel', (event, requestId: unknown) => {
    if (isTrustedSender(event) && typeof requestId === 'string') browserTabs?.cancelAskAI(requestId)
  })
  ipcMain.handle('clipboard:write', (event, text: unknown) => {
    if (!isTrustedSender(event) || typeof text !== 'string' || text.length > 100_000) return
    clipboard.writeText(text)
  })
  ipcMain.on('browser:bounds', (event, bounds: unknown) => {
    if (isTrustedSender(event) && isBrowserBounds(bounds)) browserTabs?.setBounds(bounds as BrowserBounds)
  })
  ipcMain.on('browser:visible', (event, visible: unknown) => {
    if (isTrustedSender(event) && typeof visible === 'boolean') browserTabs?.setVisible(visible)
  })
  ipcMain.handle('browser:command', async (event, command: unknown) => {
    if (!isTrustedSender(event) || !isBrowserCommand(command)) throw new Error('Invalid browser command.')
    await browserTabs?.command(command as BrowserCommand)
  })
  ipcMain.handle('browser:state:get', (event) => isTrustedSender(event) ? browserTabs?.getState() : { tabs: [], activeTabId: null })
  ipcMain.handle('ui:save', (event, state: unknown) => {
    if (!isTrustedSender(event) || !state || typeof state !== 'object') return
    const candidate = state as Record<string, unknown>
    const update: Partial<Pick<typeof settings.snapshot, 'splitRatio' | 'rightPaneMode'>> = {}
    const splitRatio = Number(candidate.splitRatio)
    if (splitRatio >= 0.25 && splitRatio <= 0.8) update.splitRatio = splitRatio
    if (candidate.rightPaneMode === 'browser' || candidate.rightPaneMode === 'notes' || candidate.rightPaneMode === 'graph') update.rightPaneMode = candidate.rightPaneMode
    if (typeof candidate.rightPaneCollapsed === 'boolean') settings.update({ rightPaneCollapsed: candidate.rightPaneCollapsed })
    if (candidate.reflowTypography && typeof candidate.reflowTypography === 'object') {
      const typography = candidate.reflowTypography as Record<string, unknown>
      if (Number(typography.fontScale) >= .8 && Number(typography.fontScale) <= 1.6
        && Number(typography.lineHeight) >= 1.2 && Number(typography.lineHeight) <= 2.2
        && Number(typography.measure) >= 44 && Number(typography.measure) <= 90) {
        settings.update({ reflowTypography: { fontScale: Number(typography.fontScale), lineHeight: Number(typography.lineHeight), measure: Number(typography.measure) } })
      }
    }
    if (Object.keys(update).length) return workspaceLibrary.updateUi(update)
  })
  ipcMain.handle('ui:get', (event) => isTrustedSender(event)
    ? { ...workspaceLibrary.activeUi, rightPaneCollapsed: settings.snapshot.rightPaneCollapsed, reflowTypography: settings.snapshot.reflowTypography }
    : { splitRatio: 0.55, rightPaneMode: 'browser', rightPaneCollapsed: false, reflowTypography: { fontScale: 1, lineHeight: 1.65, measure: 68 } })
}

function isPageNumber(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 100_000
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() } })

app.whenReady().then(async () => {
  if (!singleInstance) return
  Menu.setApplicationMenu(null)
  await settings.load()
  await workspaceLibrary.initialize()
  registerIpc()
  await createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
