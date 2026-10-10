import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, Menu, WebContentsView, session, shell } from 'electron'
import type { AIComparisonExcerpt, AIProviderId, AnnotationConversationLink, AskAIComparisonRequest, AskAIFailure, AskAIRequest, AskAIStatus, BrowserBounds, BrowserCommand, BrowserState, BrowserTabState, GraphAppendPayload, WorkspaceBrowserState } from '../shared/types'
import { buildComposerScript, detectAIProvider, getAIProvider, isAIConversationUrl, isAIProviderUrl } from '../shared/ai-providers'
import { isChatGptAuthCompletion, isSafeWebUrl, normalizeNavigation } from '../shared/validation'
import { formatPrompt } from '../shared/prompt'
import type { SettingsStore } from './storage'

const CHATGPT_URL = getAIProvider('chatgpt').homeUrl

interface TabRecord {
  id: string
  url: string
  title: string
  favicon?: string
  loading: boolean
  view?: WebContentsView
  openerTabId?: string
  zoomFactor: number
  error?: string
  recoveryAttempts: number
  recoveryTimer?: NodeJS.Timeout
  readyToPaint: boolean
  lastActivatedAt: number
}

interface PendingLink {
  requestId: string
  provider: AIProviderId
  comparisonId?: string
  linkTargets: AskAIRequest['linkTargets']
  timeout: NodeJS.Timeout
}

interface PendingDelivery {
  request: AskAIRequest
  prompt: string
  timeout: NodeJS.Timeout
  attempting: boolean
  failureShown: boolean
}

export class BrowserTabs {
  private tabs: TabRecord[] = []
  private activeTabId: string | null = null
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private readonly pendingLinks = new Map<string, PendingLink>()
  private readonly pendingDeliveries = new Map<string, PendingDelivery>()
  private destroying = false
  private visible = true
  private attachedTabId: string | null = null
  private activeComparison: { id: string; providers: AIProviderId[] } | null = null

  constructor(
    private readonly window: BrowserWindow,
    private readonly settings: SettingsStore,
    private readonly onFailure: (failure: AskAIFailure) => void,
    private readonly onStatus: (status: AskAIStatus) => void,
    private readonly onShowRequested: () => void,
    private readonly onAppendToGraph: (payload: GraphAppendPayload) => void,
    private readonly onToggleRightPane: () => void,
    initialState?: WorkspaceBrowserState,
    private readonly onPersist?: (state: WorkspaceBrowserState) => void,
  ) {
    const stored = initialState?.tabs ?? settings.snapshot.browserTabs
    this.tabs = (stored.length ? stored : [{ id: randomUUID(), url: CHATGPT_URL }]).map((tab, index) => ({
      id: tab.id,
      url: isSafeWebUrl(tab.url) ? tab.url : CHATGPT_URL,
      title: detectAIProvider(tab.url)?.name ?? 'New tab',
      loading: false,
      zoomFactor: clampZoom(tab.zoomFactor ?? 1),
      recoveryAttempts: 0,
      readyToPaint: false,
      lastActivatedAt: tab.lastActivatedAt ?? index,
    }))
    const requestedActiveId = initialState?.activeTabId ?? settings.snapshot.activeBrowserTabId
    this.activeTabId = this.tabs.some((tab) => tab.id === requestedActiveId)
      ? requestedActiveId
      : this.tabs[0]?.id ?? null

    const browserSession = session.fromPartition('persist:koibill-browser')
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    browserSession.on('will-download', (event, item) => {
      event.preventDefault()
      this.window.webContents.send('browser:download-blocked', item.getURL())
    })
  }

  async initialize(): Promise<void> {
    if (this.activeTabId) await this.activate(this.activeTabId)
    this.emit()
  }

  getState(): BrowserState {
    const tabs: BrowserTabState[] = this.tabs.map((tab) => ({
      id: tab.id,
      url: liveUrl(tab),
      title: tab.title || 'New tab',
      favicon: tab.favicon,
      loading: tab.loading,
      canGoBack: isLive(tab.view) ? tab.view.webContents.navigationHistory.canGoBack() : false,
      canGoForward: isLive(tab.view) ? tab.view.webContents.navigationHistory.canGoForward() : false,
      active: tab.id === this.activeTabId,
      zoomFactor: tab.zoomFactor,
      error: tab.error,
    }))
    return { tabs, activeTabId: this.activeTabId }
  }

  getWorkspaceState(): WorkspaceBrowserState {
    return {
      tabs: this.tabs.map((tab) => ({ id: tab.id, url: liveUrl(tab), zoomFactor: tab.zoomFactor, lastActivatedAt: tab.lastActivatedAt })),
      activeTabId: this.activeTabId,
    }
  }

  async replaceWorkspaceState(state: WorkspaceBrowserState): Promise<void> {
    this.cancelAllPending('Workspace changed.')
    this.activeComparison = null
    this.detachAttachedView()
    const previousTabs = this.tabs
    this.tabs = []
    this.activeTabId = null
    for (const tab of previousTabs) {
      if (tab.recoveryTimer) clearTimeout(tab.recoveryTimer)
      const view = tab.view
      tab.view = undefined
      if (isLive(view)) view.webContents.close()
    }
    this.tabs = (state.tabs.length ? state.tabs : [{ id: randomUUID(), url: CHATGPT_URL, zoomFactor: 1, lastActivatedAt: Date.now() }]).map((tab) => ({
      id: tab.id, url: isSafeWebUrl(tab.url) ? tab.url : CHATGPT_URL, title: detectAIProvider(tab.url)?.name ?? 'New tab',
      loading: false, zoomFactor: clampZoom(tab.zoomFactor), recoveryAttempts: 0, readyToPaint: false, lastActivatedAt: tab.lastActivatedAt,
    }))
    this.activeTabId = this.tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : this.tabs[0]?.id ?? null
    if (this.activeTabId) await this.activate(this.activeTabId)
    this.emit()
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    }
    if (!this.hasUsableBounds) this.detachAttachedView()
    else if (this.visible && this.activeTab?.view) this.presentView(this.activeTab, false)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) this.detachAttachedView()
    else if (this.activeTab?.view && this.hasUsableBounds) this.presentView(this.activeTab, true)
  }

  refreshActiveView(): void {
    const view = this.activeTab?.view
    if (!view || !view.webContents || view.webContents.isDestroyed()) return
    if (this.visible && this.hasUsableBounds) this.presentView(this.activeTab!, true)
  }

  async command(command: BrowserCommand): Promise<void> {
    switch (command.type) {
      case 'new-tab':
        await this.create(command.url)
        break
      case 'activate':
        await this.activate(command.tabId)
        break
      case 'close':
        await this.close(command.tabId)
        break
      case 'move':
        this.move(command.tabId, command.direction)
        break
      case 'navigate':
        await this.navigate(command.tabId, command.value)
        break
      case 'back':
        this.tabView(command.tabId)?.webContents.navigationHistory.goBack()
        break
      case 'forward':
        this.tabView(command.tabId)?.webContents.navigationHistory.goForward()
        break
      case 'reload':
        this.tabView(command.tabId)?.webContents.reload()
        break
      case 'stop':
        this.tabView(command.tabId)?.webContents.stop()
        break
      case 'external': {
        const url = this.tabView(command.tabId)?.webContents.getURL()
        if (url && isSafeWebUrl(url) && url !== 'about:blank') await shell.openExternal(url)
        break
      }
      case 'external-url':
        if (isSafeWebUrl(command.url) && command.url !== 'about:blank') await shell.openExternal(command.url)
        break
      case 'activate-or-open': {
        this.onShowRequested()
        const existing = command.tabId ? this.tabs.find((tab) => tab.id === command.tabId) : undefined
        if (existing) {
          await this.activate(existing.id)
          if (liveUrl(existing) !== command.url) await existing.view?.webContents.loadURL(command.url)
        }
        else await this.create(command.url)
        break
      }
      case 'zoom-in':
        this.setTabZoom(command.tabId, (this.tabs.find((tab) => tab.id === command.tabId)?.zoomFactor ?? 1) + 0.1)
        break
      case 'zoom-out':
        this.setTabZoom(command.tabId, (this.tabs.find((tab) => tab.id === command.tabId)?.zoomFactor ?? 1) - 0.1)
        break
      case 'zoom-reset':
        this.setTabZoom(command.tabId, 1)
        break
      case 'recover': {
        const tab = this.tabs.find((candidate) => candidate.id === command.tabId)
        if (tab) this.recover(tab, true)
        break
      }
    }
    this.emit()
  }

  async askAI(request: AskAIRequest): Promise<void> {
    this.onShowRequested()
    const prompt = formatPrompt(request)
    if (prompt.length > 20_000) {
      this.failAsk(request, prompt)
      return
    }
    const acknowledged = Array.isArray(this.settings.snapshot.acknowledgedAIProviders)
      ? this.settings.snapshot.acknowledgedAIProviders
      : []
    if (!acknowledged.includes(request.provider)) {
      const provider = getAIProvider(request.provider)
      const result = await dialog.showMessageBox(this.window, {
        type: 'info',
        title: `Send passage to ${provider.name}?`,
        message: `koibill will insert the selected PDF text into ${provider.name}'s website.`,
        detail: `The passage will be handled under ${provider.name}'s account, privacy, and usage terms. koibill does not use an API key for this action.`,
        buttons: ['Continue', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (result.response !== 0) {
        this.onStatus({ requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, state: 'cancelled', linkTargets: request.linkTargets, message: `${provider.name} request cancelled.` })
        return
      }
      this.settings.update({ acknowledgedAIProviders: [...acknowledged, request.provider] })
    }
    const provider = getAIProvider(request.provider)
    let tab = this.activeTab && isAIProviderUrl(liveUrl(this.activeTab), provider.id) ? this.activeTab : undefined
    if (!tab) {
      tab = this.tabs
        .filter((candidate) => isAIProviderUrl(liveUrl(candidate), provider.id))
        .sort((left, right) => right.lastActivatedAt - left.lastActivatedAt)[0]
    }
    if (!tab) tab = await this.create(provider.homeUrl)
    await this.activate(tab.id)
    await this.ensureView(tab)
    this.queueDelivery(tab, request, prompt)
  }

  async compareAI(request: AskAIComparisonRequest): Promise<void> {
    this.onShowRequested()
    if (request.prompt.length > 20_000) {
      for (const provider of request.providers) this.onStatus({ requestId: `${request.requestId}:${provider}`, provider, comparisonId: request.comparisonId, state: 'failed', linkTargets: request.linkTargets, message: 'The comparison prompt exceeds 20,000 characters.' })
      return
    }
    const acknowledged = Array.isArray(this.settings.snapshot.acknowledgedAIProviders) ? this.settings.snapshot.acknowledgedAIProviders : []
    const newProviders = request.providers.filter((provider) => !acknowledged.includes(provider))
    if (newProviders.length) {
      const names = newProviders.map((provider) => getAIProvider(provider).name)
      const result = await dialog.showMessageBox(this.window, {
        type: 'info', title: 'Send context to AI providers?',
        message: `koibill will submit this prompt to ${names.join(', ')}.`,
        detail: 'Each passage will be handled under the selected provider accounts, privacy policies, and usage terms. koibill does not use API keys for this action.',
        buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
      })
      if (result.response !== 0) {
        for (const provider of request.providers) this.onStatus({ requestId: `${request.requestId}:${provider}`, provider, comparisonId: request.comparisonId, state: 'cancelled', linkTargets: request.linkTargets, message: 'Provider comparison cancelled.' })
        return
      }
      this.settings.update({ acknowledgedAIProviders: [...new Set([...acknowledged, ...newProviders])] })
    }
    this.activeComparison = { id: request.comparisonId, providers: [...request.providers] }
    const tabs: TabRecord[] = []
    for (const providerId of request.providers) {
      const provider = getAIProvider(providerId)
      this.onStatus({ requestId: `${request.requestId}:${providerId}`, provider: providerId, comparisonId: request.comparisonId, state: 'loading', linkTargets: request.linkTargets, message: `Opening ${provider.name}.` })
      let tab = this.tabs.filter((candidate) => isAIProviderUrl(liveUrl(candidate), providerId)).sort((a, b) => b.lastActivatedAt - a.lastActivatedAt)[0]
      if (!tab) tab = await this.create(provider.homeUrl, false)
      await this.ensureView(tab)
      tabs.push(tab)
      const delivery: AskAIRequest = {
        kind: 'composed', requestId: `${request.requestId}:${providerId}`, provider: providerId, mode: 'send',
        prompt: request.prompt, contexts: request.contexts, promptEdited: request.promptEdited,
        linkTargets: request.linkTargets, comparisonId: request.comparisonId,
      }
      this.queueDelivery(tab, delivery, request.prompt)
    }
    if (tabs[0]) await this.activate(tabs[0].id)
  }

  setActiveComparison(id: string | null, providers: AIProviderId[]): void {
    this.activeComparison = id ? { id, providers: [...providers] } : null
  }

  cancelAskAI(requestId: string): void {
    for (const [tabId, pending] of this.pendingDeliveries) {
      if (pending.request.requestId === requestId) this.cancelPendingDelivery(tabId, 'Ask AI request cancelled.')
    }
    for (const [tabId, pending] of this.pendingLinks) {
      if (pending.requestId !== requestId) continue
      clearTimeout(pending.timeout)
      this.pendingLinks.delete(tabId)
      this.onStatus({ requestId, provider: pending.provider, comparisonId: pending.comparisonId, state: 'cancelled', linkTargets: pending.linkTargets, message: 'Conversation linking cancelled.' })
    }
  }

  destroy(): void {
    this.destroying = true
    this.activeComparison = null
    for (const pending of this.pendingLinks.values()) clearTimeout(pending.timeout)
    this.pendingLinks.clear()
    for (const pending of this.pendingDeliveries.values()) clearTimeout(pending.timeout)
    this.pendingDeliveries.clear()
    for (const tab of this.tabs) {
      if (tab.recoveryTimer) clearTimeout(tab.recoveryTimer)
      if (!tab.view) continue
      if (this.isMounted(tab.view)) this.window.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    }
    this.attachedTabId = null
  }

  cancelAllPending(message: string): void {
    for (const id of [...this.pendingDeliveries.keys()]) this.cancelPendingDelivery(id, message)
    for (const [tabId, pending] of this.pendingLinks) {
      clearTimeout(pending.timeout); this.pendingLinks.delete(tabId)
      this.onStatus({ requestId: pending.requestId, provider: pending.provider, comparisonId: pending.comparisonId, state: 'cancelled', linkTargets: pending.linkTargets, message })
    }
  }

  private get activeTab(): TabRecord | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId)
  }

  private async create(url = 'about:blank', activate = true): Promise<TabRecord> {
    const tab: TabRecord = { id: randomUUID(), url: normalizeNavigation(url), title: 'New tab', loading: false, zoomFactor: 1, recoveryAttempts: 0, readyToPaint: false, lastActivatedAt: 0 }
    this.tabs.push(tab)
    if (activate) await this.activate(tab.id)
    this.persist()
    return tab
  }

  private async activate(id: string): Promise<void> {
    const next = this.tabs.find((tab) => tab.id === id)
    if (!next) return
    this.activeTabId = id
    next.lastActivatedAt = Date.now()
    const view = await this.ensureView(next)
    if (this.window.isDestroyed() || !view.webContents) return
    if (this.visible && this.hasUsableBounds) this.presentView(next, true)
    this.persist()
    this.emit()
  }

  private async ensureView(tab: TabRecord): Promise<WebContentsView> {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view
    tab.view = undefined
    const view = new WebContentsView({ webPreferences: secureWebPreferences() })
    tab.view = view
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    this.mountView(view)
    view.webContents.setZoomMode('isolated')
    view.webContents.setZoomFactor(tab.zoomFactor)
    this.configureView(tab, view)
    void view.webContents.loadURL(tab.url).catch((error) => {
      if (!view.webContents.isDestroyed()) console.warn(`Unable to load browser tab ${tab.url}`, error)
    })
    return view
  }

  private configureView(tab: TabRecord, view: WebContentsView): void {
    const refreshIfActive = (): void => {
      if (this.activeTabId !== tab.id || !tab.view?.webContents || tab.view.webContents.isDestroyed()) return
      if (this.visible && this.hasUsableBounds) this.presentView(tab, false)
    }
    view.webContents.setBackgroundThrottling(true)
    const renderInternalBlank = (): void => {
      if (view.webContents.getURL() !== 'about:blank') return
      void view.webContents.executeJavaScript(internalBlankScript(), true).catch(() => undefined)
    }
    view.webContents.on('did-start-loading', () => { tab.loading = true; tab.error = undefined; this.emit() })
    view.webContents.on('dom-ready', () => { tab.readyToPaint = true; renderInternalBlank(); refreshIfActive(); void this.attemptPendingDelivery(tab) })
    view.webContents.on('did-frame-finish-load', (_event, isMainFrame) => { if (isMainFrame) refreshIfActive() })
    view.webContents.on('did-finish-load', () => {
      this.clearRecoveryTimer(tab)
      tab.error = undefined
      tab.recoveryAttempts = 0
      view.webContents.setZoomFactor(tab.zoomFactor)
      refreshIfActive()
      setTimeout(refreshIfActive, 120)
      setTimeout(refreshIfActive, 600)
      void this.attemptPendingDelivery(tab)
    })
    view.webContents.on('did-stop-loading', () => { tab.loading = false; this.capture(tab); refreshIfActive(); this.emit() })
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.loading = false
      tab.error = `Page failed to load: ${errorDescription}`
      this.emit()
      if (tab.recoveryAttempts < 1) this.scheduleRecovery(tab, 500, false)
    })
    view.webContents.on('render-process-gone', (_event, details) => {
      tab.readyToPaint = false
      tab.error = `Browser renderer stopped (${details.reason}).`
      this.emit()
      if (tab.recoveryAttempts < 2) this.scheduleRecovery(tab, 600, true)
    })
    view.webContents.on('unresponsive', () => { tab.error = 'This page is not responding.'; this.emit(); this.scheduleRecovery(tab, 4_000, true) })
    view.webContents.on('responsive', () => { this.clearRecoveryTimer(tab); tab.error = undefined; this.emit(); refreshIfActive() })
    view.webContents.on('before-input-event', (event, input) => {
      if (!(input.control || input.meta) || input.type !== 'keyDown') return
      if (input.key === '+' || input.key === '=') { event.preventDefault(); this.setTabZoom(tab.id, tab.zoomFactor + 0.1) }
      if (input.key === '-') { event.preventDefault(); this.setTabZoom(tab.id, tab.zoomFactor - 0.1) }
      if (input.key === '0') { event.preventDefault(); this.setTabZoom(tab.id, 1) }
      if (input.key === '\\') { event.preventDefault(); this.onToggleRightPane() }
    })
    view.webContents.on('context-menu', (_event, params) => {
      const excerpt = params.selectionText.trim().slice(0, 20_000)
      if (!excerpt) return
      const url = view.webContents.getURL()
      const aiProvider = detectAIProvider(url)
      Menu.buildFromTemplate([
        ...(aiProvider && this.activeComparison?.providers.includes(aiProvider.id) ? [{
          label: 'Save selection to active comparison',
          click: () => this.window.webContents.send('ask-ai:comparison-excerpt', this.activeComparison!.id, {
            id: randomUUID(), provider: aiProvider.id, text: excerpt, title: tab.title,
            url: isAIProviderUrl(url, aiProvider.id) ? url : undefined, browserTabId: tab.id, createdAt: new Date().toISOString(),
          } satisfies AIComparisonExcerpt),
        }] : []),
        {
          label: 'Append to graph',
          click: () => this.onAppendToGraph({
            source: {
              kind: aiProvider ? 'ai' : 'web',
              provider: aiProvider?.id,
              excerpt,
              url: isSafeWebUrl(url) && url !== 'about:blank' ? url : undefined,
              title: tab.title,
              browserTabId: tab.id,
            },
          }),
        },
        { type: 'separator' },
        { role: 'copy', label: 'Copy' },
      ]).popup({ window: this.window })
    })
    view.webContents.on('page-title-updated', (_event, title) => { tab.title = title; this.emit() })
    view.webContents.on('page-favicon-updated', (_event, favicons) => { tab.favicon = favicons[0]; this.emit() })
    view.webContents.on('did-navigate', (_event, url) => {
      const previousUrl = tab.url
      tab.url = url
      this.capture(tab)
      this.persist()
      this.emit()
      if (isChatGptAuthCompletion(previousUrl, url)) {
        refreshIfActive()
        setTimeout(refreshIfActive, 250)
        setTimeout(refreshIfActive, 1_000)
      }
      this.resolvePendingLink(tab, url)
      this.handleDeliveryNavigation(tab, url)
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      tab.url = url; this.capture(tab); this.persist(); this.emit(); this.resolvePendingLink(tab, url); this.handleDeliveryNavigation(tab, url)
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!isSafeWebUrl(url)) event.preventDefault()
    })
    view.webContents.on('destroyed', () => {
      if (tab.view !== view) return
      void this.handleDestroyedTab(tab.id)
    })
    view.webContents.setWindowOpenHandler((details) => {
      if (!isSafeWebUrl(details.url)) return { action: 'deny' }

      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: secureWebPreferences(),
        },
        createWindow: (options) => {
          const suppliedWebContents = (options as Electron.BrowserWindowConstructorOptions & {
            webContents?: Electron.WebContents
          }).webContents
          const popupView = new WebContentsView(suppliedWebContents
            ? { webContents: suppliedWebContents }
            : { webPreferences: secureWebPreferences(options.webPreferences) })
          const popupTab: TabRecord = {
            id: randomUUID(),
            url: details.url,
            title: 'New tab',
            loading: true,
            view: popupView,
            openerTabId: tab.id,
            zoomFactor: 1,
            recoveryAttempts: 0,
            readyToPaint: false,
            lastActivatedAt: 0,
          }
          this.tabs.push(popupTab)
          this.configureView(popupTab, popupView)
          this.attachView(popupTab)

          // Electron defers WebContents creation for background tabs, so the
          // application owns the initial navigation in that case.
          if (!suppliedWebContents || details.disposition === 'background-tab') {
            void popupView.webContents.loadURL(details.url)
          }
          return popupView.webContents
        },
      }
    })
  }

  private attachView(tab: TabRecord): void {
    this.activeTabId = tab.id
    tab.lastActivatedAt = Date.now()
    if (this.visible && this.hasUsableBounds) this.presentView(tab, true)
    this.persist()
    this.emit()
  }

  private async handleDestroyedTab(id: string): Promise<void> {
    if (this.destroying) return
    if (this.attachedTabId === id) this.attachedTabId = null
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const [removed] = this.tabs.splice(index, 1)
    if (removed.recoveryTimer) clearTimeout(removed.recoveryTimer)
    const pending = this.pendingLinks.get(id)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingLinks.delete(id)
      this.onStatus({ requestId: pending.requestId, provider: pending.provider, comparisonId: pending.comparisonId, state: 'cancelled', linkTargets: pending.linkTargets, message: `The ${getAIProvider(pending.provider).name} tab was closed.` })
    }
    this.cancelPendingDelivery(id, 'The AI tab was closed.')
    if (!this.tabs.length) this.tabs.push({ id: randomUUID(), url: CHATGPT_URL, title: 'ChatGPT', loading: false, zoomFactor: 1, recoveryAttempts: 0, readyToPaint: false, lastActivatedAt: 0 })
    if (this.activeTabId === id) {
      const fallback = this.tabs.find((tab) => tab.id === removed.openerTabId)
        ?? this.tabs[Math.min(index, this.tabs.length - 1)]
      this.activeTabId = null
      await this.activate(fallback.id)
    }
    this.persist()
    this.emit()
  }

  private async close(id: string): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const [removed] = this.tabs.splice(index, 1)
    if (removed.recoveryTimer) clearTimeout(removed.recoveryTimer)
    const pending = this.pendingLinks.get(id)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingLinks.delete(id)
      this.onStatus({ requestId: pending.requestId, provider: pending.provider, comparisonId: pending.comparisonId, state: 'cancelled', linkTargets: pending.linkTargets, message: `The ${getAIProvider(pending.provider).name} tab was closed.` })
    }
    this.cancelPendingDelivery(id, 'The AI tab was closed.')
    if (removed.view) {
      if (this.attachedTabId === removed.id) this.detachAttachedView()
      if (this.isMounted(removed.view)) this.window.contentView.removeChildView(removed.view)
      removed.view.webContents.close()
    }
    if (!this.tabs.length) this.tabs.push({ id: randomUUID(), url: CHATGPT_URL, title: 'ChatGPT', loading: false, zoomFactor: 1, recoveryAttempts: 0, readyToPaint: false, lastActivatedAt: 0 })
    if (this.activeTabId === id) await this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id)
    this.persist()
  }

  private move(id: string, direction: -1 | 1): void {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= this.tabs.length) return
    const [tab] = this.tabs.splice(index, 1)
    this.tabs.splice(target, 0, tab)
    this.persist()
  }

  private async navigate(id: string, value: string): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    const view = await this.ensureView(tab)
    try {
      await view.webContents.loadURL(normalizeNavigation(value))
    } catch (error) {
      if (view.webContents && !view.webContents.isDestroyed()) console.warn('Navigation failed', error)
    }
  }

  private tabView(id: string): WebContentsView | undefined {
    return this.tabs.find((tab) => tab.id === id)?.view
  }

  private capture(tab: TabRecord): void {
    if (!isLive(tab.view)) return
    tab.url = tab.view.webContents.getURL() || tab.url
    tab.title = tab.view.webContents.getTitle() || tab.title
  }

  private emit(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send('browser:state', this.getState())
  }

  private persist(): void {
    const state = this.getWorkspaceState()
    if (this.onPersist) this.onPersist(state)
    else this.settings.update({ browserTabs: state.tabs, activeBrowserTabId: state.activeTabId })
  }

  private get hasUsableBounds(): boolean {
    return this.bounds.width >= 2 && this.bounds.height >= 2
  }

  private presentView(tab: TabRecord, focus: boolean): void {
    const view = tab.view
    if (!view || view.webContents.isDestroyed() || !this.visible || !this.hasUsableBounds || this.window.isDestroyed()) return
    if (this.attachedTabId !== tab.id) {
      this.detachAttachedView()
      this.attachedTabId = tab.id
    }
    this.mountView(view, true)
    view.setBounds(this.bounds)
    view.setVisible(true)
    if (tab.readyToPaint) view.webContents.invalidate()
    if (focus) view.webContents.focus()
    setImmediate(() => {
      if (this.destroying || this.attachedTabId !== tab.id || !this.visible || !isLive(tab.view) || !this.hasUsableBounds) return
      tab.view.setBounds(this.bounds)
      tab.view.setVisible(true)
      if (tab.readyToPaint) tab.view.webContents.invalidate()
    })
  }

  private detachAttachedView(): void {
    if (!this.attachedTabId || this.window.isDestroyed()) { this.attachedTabId = null; return }
    const tab = this.tabs.find((candidate) => candidate.id === this.attachedTabId)
    if (tab?.view && !tab.view.webContents.isDestroyed()) {
      tab.view.setVisible(false)
    }
    this.attachedTabId = null
  }

  private mountView(view: WebContentsView, bringToFront = false): void {
    if (this.window.isDestroyed() || view.webContents.isDestroyed()) return
    if (!this.isMounted(view) || bringToFront) this.window.contentView.addChildView(view)
  }

  private isMounted(view: WebContentsView): boolean {
    return !this.window.isDestroyed() && this.window.contentView.children.includes(view)
  }

  private setTabZoom(id: string, value: number): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    tab.zoomFactor = clampZoom(value)
    if (isLive(tab.view)) tab.view.webContents.setZoomFactor(tab.zoomFactor)
    this.persist()
    this.emit()
  }

  private recover(tab: TabRecord, userInitiated: boolean): void {
    if (this.destroying) return
    tab.recoveryAttempts += 1
    tab.error = undefined
    tab.loading = true
    this.emit()
    if (!isLive(tab.view)) {
      tab.view = undefined
      void this.ensureView(tab).then(() => { if (tab.id === this.activeTabId && this.visible) this.presentView(tab, true) })
      return
    }
    if (tab.id === this.activeTabId && this.visible) this.presentView(tab, userInitiated)
    tab.view.webContents.reloadIgnoringCache()
  }

  private scheduleRecovery(tab: TabRecord, delay: number, recreateView: boolean): void {
    if (this.destroying || tab.recoveryTimer) return
    tab.recoveryTimer = setTimeout(() => {
      tab.recoveryTimer = undefined
      if (this.destroying || !this.tabs.includes(tab) || tab.recoveryAttempts >= 2) return
      if (recreateView && isLive(tab.view)) {
        const staleView = tab.view
        if (this.attachedTabId === tab.id) this.detachAttachedView()
        if (this.isMounted(staleView)) this.window.contentView.removeChildView(staleView)
        tab.view = undefined
        staleView.webContents.close()
      }
      this.recover(tab, false)
    }, delay)
  }

  private clearRecoveryTimer(tab: TabRecord): void {
    if (!tab.recoveryTimer) return
    clearTimeout(tab.recoveryTimer)
    tab.recoveryTimer = undefined
  }

  private failAsk(request: AskAIRequest, prompt: string): void {
    const provider = getAIProvider(request.provider)
    this.onFailure({
      request,
      prompt,
      message: `${provider.name} is not ready for text insertion. Sign in if needed, then retry or copy the prompt.`,
    })
    this.onStatus({ requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, state: 'failed', linkTargets: request.linkTargets, message: `${provider.name} insertion failed.` })
  }

  private queueDelivery(tab: TabRecord, request: AskAIRequest, prompt: string): void {
    this.cancelPendingDelivery(tab.id, 'Superseded by a newer Ask AI request.')
    if (isLive(tab.view)) tab.view.webContents.setBackgroundThrottling(false)
    if (request.comparisonId) this.onStatus({ requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, state: 'queued', linkTargets: request.linkTargets, message: `Queued for ${getAIProvider(request.provider).name}.` })
    const timeout = setTimeout(() => {
      const pending = this.pendingDeliveries.get(tab.id)
      if (!pending || pending.request.requestId !== request.requestId) return
      this.pendingDeliveries.delete(tab.id)
      if (isLive(tab.view)) tab.view.webContents.setBackgroundThrottling(true)
      if (!pending.failureShown) this.failAsk(request, prompt)
      this.onStatus({ requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, state: 'expired', linkTargets: request.linkTargets, message: `${getAIProvider(request.provider).name} insertion expired.` })
    }, 30 * 60 * 1_000)
    this.pendingDeliveries.set(tab.id, { request, prompt, timeout, attempting: false, failureShown: false })
    void this.attemptPendingDelivery(tab)
  }

  private async attemptPendingDelivery(tab: TabRecord): Promise<void> {
    const pending = this.pendingDeliveries.get(tab.id)
    if (!pending || pending.attempting || !isLive(tab.view) || tab.view.webContents.isLoading()) return
    const currentProvider = detectAIProvider(liveUrl(tab))
    if (!currentProvider || currentProvider.id !== pending.request.provider) return
    pending.attempting = true
    let inserted = false
    for (let attempt = 0; attempt < 20 && this.pendingDeliveries.get(tab.id) === pending; attempt += 1) {
      try {
        inserted = await tab.view.webContents.executeJavaScript(
          buildComposerScript(pending.request.provider, pending.prompt, pending.request.mode === 'send'), true,
        ) as boolean
      } catch {
        inserted = false
      }
      if (inserted) break
      await new Promise((resolve) => setTimeout(resolve, 350))
      if (!isLive(tab.view) || tab.view.webContents.isLoading()) break
    }
    pending.attempting = false
    if (this.pendingDeliveries.get(tab.id) !== pending) return
    if (inserted) {
      clearTimeout(pending.timeout)
      this.pendingDeliveries.delete(tab.id)
      if (isLive(tab.view)) tab.view.webContents.setBackgroundThrottling(true)
      this.onStatus({ requestId: pending.request.requestId, provider: pending.request.provider, comparisonId: pending.request.comparisonId, state: 'inserted', linkTargets: pending.request.linkTargets, message: `Prompt inserted into ${currentProvider.name}.` })
      this.registerPendingLink(tab, pending.request)
    } else if (!pending.failureShown) {
      pending.failureShown = true
      if (isLive(tab.view)) tab.view.webContents.setBackgroundThrottling(true)
      this.failAsk(pending.request, pending.prompt)
    }
  }

  private handleDeliveryNavigation(tab: TabRecord, url: string): void {
    const pending = this.pendingDeliveries.get(tab.id)
    if (!pending) return
    const provider = detectAIProvider(url)
    if (provider && provider.id !== pending.request.provider) {
      this.cancelPendingDelivery(tab.id, `Navigation left ${getAIProvider(pending.request.provider).name}.`)
      return
    }
    if (provider) {
      pending.failureShown = false
      if (isLive(tab.view)) tab.view.webContents.setBackgroundThrottling(false)
      void this.attemptPendingDelivery(tab)
    } else if (!pending.failureShown) {
      // OAuth and account pages commonly live on a different host. Keep the
      // request alive while making the manual fallback available.
      pending.failureShown = true
      if (isLive(tab.view)) tab.view.webContents.setBackgroundThrottling(true)
      this.failAsk(pending.request, pending.prompt)
    }
  }

  private cancelPendingDelivery(tabId: string, message: string): void {
    const pending = this.pendingDeliveries.get(tabId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pendingDeliveries.delete(tabId)
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (isLive(tab?.view)) tab.view.webContents.setBackgroundThrottling(true)
    this.onStatus({ requestId: pending.request.requestId, provider: pending.request.provider, comparisonId: pending.request.comparisonId, state: 'cancelled', linkTargets: pending.request.linkTargets, message })
  }

  private registerPendingLink(tab: TabRecord, request: AskAIRequest): void {
    if (!request.linkTargets.length && !request.comparisonId) return
    const url = liveUrl(tab)
    if (isAIConversationUrl(url, request.provider)) {
      this.emitLinked(request.requestId, request.linkTargets, tab, url, request.comparisonId)
      return
    }
    const previous = this.pendingLinks.get(tab.id)
    if (previous) {
      clearTimeout(previous.timeout)
      this.onStatus({ requestId: previous.requestId, provider: previous.provider, comparisonId: previous.comparisonId, state: 'cancelled', linkTargets: previous.linkTargets, message: 'Superseded by a newer Ask AI request.' })
    }
    const timeout = setTimeout(() => {
      const pending = this.pendingLinks.get(tab.id)
      if (!pending || pending.requestId !== request.requestId) return
      this.pendingLinks.delete(tab.id)
      this.onStatus({ requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, state: 'expired', linkTargets: request.linkTargets, message: 'Conversation link expired.' })
    }, 30 * 60 * 1_000)
    this.pendingLinks.set(tab.id, { requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, linkTargets: request.linkTargets, timeout })
    this.onStatus({ requestId: request.requestId, provider: request.provider, comparisonId: request.comparisonId, state: 'pending', linkTargets: request.linkTargets, message: `Waiting for the ${getAIProvider(request.provider).name} conversation to be created.` })
  }

  private resolvePendingLink(tab: TabRecord, url: string): void {
    const pending = this.pendingLinks.get(tab.id)
    if (!pending) return
    if (isAIConversationUrl(url, pending.provider)) {
      clearTimeout(pending.timeout)
      this.pendingLinks.delete(tab.id)
      this.emitLinked(pending.requestId, pending.linkTargets, tab, url, pending.comparisonId)
      return
    }
    if (!isAIProviderUrl(url, pending.provider)) {
      clearTimeout(pending.timeout)
      this.pendingLinks.delete(tab.id)
      this.onStatus({ requestId: pending.requestId, provider: pending.provider, comparisonId: pending.comparisonId, state: 'cancelled', linkTargets: pending.linkTargets, message: `Leaving ${getAIProvider(pending.provider).name} cancelled conversation linking.` })
    }
  }

  private emitLinked(requestId: string, linkTargets: AskAIRequest['linkTargets'], tab: TabRecord, url: string, comparisonId?: string): void {
    const link: AnnotationConversationLink = {
      id: randomUUID(),
      provider: detectAIProvider(url)?.id ?? 'chatgpt',
      url,
      title: tab.title || `${detectAIProvider(url)?.name ?? 'AI'} conversation`,
      browserTabId: tab.id,
      createdAt: new Date().toISOString(),
    }
    this.onStatus({ requestId, provider: link.provider, comparisonId, state: 'linked', linkTargets, link })
  }
}

function secureWebPreferences(inherited: Electron.WebPreferences = {}): Electron.WebPreferences {
  return {
    ...inherited,
    partition: 'persist:koibill-browser',
    preload: undefined,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    devTools: false,
    allowRunningInsecureContent: false,
    webviewTag: false,
  }
}

function isLive(view: WebContentsView | undefined): view is WebContentsView {
  return Boolean(view && !view.webContents.isDestroyed())
}

function clampZoom(value: number): number {
  return Math.min(3, Math.max(0.5, Math.round(value * 10) / 10))
}

function liveUrl(tab: TabRecord): string {
  return isLive(tab.view) ? tab.view.webContents.getURL() || tab.url : tab.url
}

function internalBlankScript(): string {
  return `(() => {
    document.title = 'New tab';
    document.documentElement.style.colorScheme = 'light';
    document.body.innerHTML = '<main><div class="mark">K</div><h1>New tab</h1><p>Enter an HTTPS address or search above.</p></main>';
    const style = document.createElement('style');
    style.textContent = 'html,body{height:100%;margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif}body{display:grid;place-items:center}main{width:min(360px,calc(100% - 48px))}.mark{display:grid;width:42px;height:42px;place-items:center;background:#000;color:#fff;font-weight:800}h1{margin:18px 0 7px;font-size:30px;letter-spacing:-.04em}p{margin:0;color:#666;font-size:14px}';
    document.head.appendChild(style);
    return true;
  })()`
}
