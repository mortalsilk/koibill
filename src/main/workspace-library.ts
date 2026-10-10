import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import type {
  AIComparisonRecord, PdfImportProgress, ResearchWorkspace, UiState, WorkspaceBrowserState, WorkspaceDescriptor,
  WorkspaceDocumentRecord, WorkspaceLibrarySettings, WorkspaceManifest, WorkspaceSwitchResult, WorkspaceUiState,
} from '../shared/types'
import { isAIComparisonRecord, isResearchTrayItem } from '../shared/validation'
import type { SettingsStore } from './storage'

interface RegisteredWorkspace { id: string; name: string; path: string; lastOpenedAt: string }
interface ActiveWorkspace { path: string; manifest: WorkspaceManifest; comparisons: AIComparisonRecord[] }
interface ImportedDocument { record: WorkspaceDocumentRecord; path: string; duplicate: boolean }

const DEFAULT_UI: UiState = { splitRatio: .55, rightPaneMode: 'browser' }
function defaultBrowser(): WorkspaceBrowserState {
  const id = randomUUID()
  return { tabs: [{ id, url: 'https://chatgpt.com/', zoomFactor: 1, lastActivatedAt: Date.now() }], activeTabId: id }
}

export class WorkspaceLibrary {
  private active: ActiveWorkspace | null = null
  private readonly unavailable = new Set<string>()
  private manifestWrite = Promise.resolve()
  private readonly imports = new Map<string, AbortController>()

  constructor(
    private readonly settings: SettingsStore,
    private readonly onProgress: (progress: PdfImportProgress) => void,
  ) {}

  async initialize(): Promise<void> {
    if (!this.settings.snapshot.workspaceRoot) this.settings.update({ workspaceRoot: this.rootPath })
    await fs.mkdir(this.rootPath, { recursive: true })
    for (const item of this.registered) if (!(await exists(path.join(item.path, 'workspace.json')))) this.unavailable.add(item.id)
    const id = this.settings.snapshot.activeWorkspaceId
    if (!id) return
    const registered = this.registered.find((item) => item.id === id)
    if (!registered) return
    try { await this.loadRegistered(registered) }
    catch (error) { console.warn('Unable to restore workspace', error); this.settings.update({ activeWorkspaceId: null }) }
  }

  get activeManifest(): WorkspaceManifest | null { return this.active ? structuredClone(this.active.manifest) : null }
  get activeId(): string | null { return this.active?.manifest.id ?? null }
  get hasActiveImport(): boolean { return this.imports.size > 0 }
  get activeUi(): UiState { return structuredClone(this.active?.manifest.ui ?? DEFAULT_UI) }
  get activeBrowser(): WorkspaceBrowserState { return structuredClone(this.active?.manifest.browser ?? defaultBrowser()) }

  getLibrary(): WorkspaceLibrarySettings {
    const activeId = this.activeId
    return {
      rootLabel: path.join(path.basename(path.dirname(this.rootPath)), path.basename(this.rootPath)),
      activeWorkspaceId: activeId,
      workspaces: this.registered.slice(0, 50).map((item) => ({
        id: item.id, name: item.name, available: !this.unavailable.has(item.id), active: item.id === activeId, lastOpenedAt: item.lastOpenedAt,
      })),
    }
  }

  restore(): ResearchWorkspace {
    const manifest = this.active?.manifest
    if (!manifest) return { schemaVersion: 1, documents: [], activeDocumentId: null, tray: [], question: '', comparisons: [] }
    return {
      schemaVersion: 1,
      workspaceId: manifest.id,
      workspaceName: manifest.name,
      documents: manifest.documents.filter((item) => item.open !== false).map((item) => ({
        documentId: item.id, name: item.name, fingerprint: item.fingerprint, missing: false, viewState: item.viewState,
      })),
      activeDocumentId: manifest.activeDocumentId,
      tray: manifest.tray,
      question: manifest.question,
      comparisons: structuredClone(this.active?.comparisons ?? []),
    }
  }

  async create(name: string): Promise<WorkspaceSwitchResult> {
    const cleanName = validateName(name)
    const id = randomUUID()
    const directory = path.join(this.rootPath, `${slug(cleanName)}--${id.slice(0, 8)}`)
    const timestamp = new Date().toISOString()
    const browser = defaultBrowser()
    const manifest: WorkspaceManifest = {
      schemaVersion: 1, id, name: cleanName, createdAt: timestamp, modifiedAt: timestamp,
      documents: [], activeDocumentId: null, tray: [], question: '', ui: DEFAULT_UI, browser,
    }
    await fs.mkdir(path.join(directory, 'books'), { recursive: true })
    await fs.mkdir(path.join(directory, '.imports'), { recursive: true })
    await atomicWrite(path.join(directory, 'workspace.json'), JSON.stringify(manifest, null, 2))
    await atomicWrite(path.join(directory, 'comparisons.json'), JSON.stringify({ schemaVersion: 1, comparisons: [] }, null, 2))
    this.active = { path: directory, manifest, comparisons: [] }
    this.unavailable.delete(manifest.id)
    this.register({ id, name: cleanName, path: directory, lastOpenedAt: timestamp })
    return { switched: true, workspace: this.restore(), ui: manifest.ui }
  }

  async openExisting(): Promise<WorkspaceSwitchResult> {
    const result = await dialog.showOpenDialog({ title: 'Open koibill workspace', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { switched: false }
    const directory = await fs.realpath(result.filePaths[0])
    const manifest = await readManifest(directory)
    await ensureWritable(directory)
    const timestamp = new Date().toISOString()
    this.active = { path: directory, manifest, comparisons: await readComparisons(directory) }
    this.unavailable.delete(manifest.id)
    this.register({ id: manifest.id, name: manifest.name, path: directory, lastOpenedAt: timestamp })
    await this.cleanupStaging()
    return { switched: true, workspace: this.restore(), ui: manifest.ui }
  }

  async switchTo(id: string): Promise<WorkspaceSwitchResult> {
    const registered = this.registered.find((item) => item.id === id)
    if (!registered) return { switched: false, message: 'Workspace is not registered.' }
    await this.loadRegistered(registered)
    return { switched: true, workspace: this.restore(), ui: this.active!.manifest.ui }
  }

  async rename(id: string, name: string): Promise<WorkspaceDescriptor> {
    const cleanName = validateName(name)
    const item = this.registered.find((candidate) => candidate.id === id)
    if (!item) throw new Error('Workspace is not registered.')
    const directory = item.path
    const manifest = this.active?.manifest.id === id ? this.active.manifest : await readManifest(directory)
    manifest.name = cleanName
    manifest.modifiedAt = new Date().toISOString()
    await atomicWrite(path.join(directory, 'workspace.json'), JSON.stringify(manifest, null, 2))
    if (this.active?.manifest.id === id) this.active.manifest = manifest
    this.register({ ...item, name: cleanName })
    return this.getLibrary().workspaces.find((candidate) => candidate.id === id)!
  }

  unregister(id: string): void {
    const next = this.registered.filter((item) => item.id !== id)
    if (this.activeId === id) this.active = null
    this.settings.update({ registeredWorkspaces: next, activeWorkspaceId: this.activeId })
  }

  async reveal(id: string): Promise<void> {
    const item = this.registered.find((candidate) => candidate.id === id)
    if (!item) throw new Error('Workspace is not registered.')
    shell.showItemInFolder(path.join(item.path, 'workspace.json'))
  }

  async chooseRoot(): Promise<void> {
    const result = await dialog.showOpenDialog({ title: 'Choose workspace library folder', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    const selected = path.join(result.filePaths[0], path.basename(result.filePaths[0]) === 'koibill-workspaces' ? '' : 'koibill-workspaces')
    await fs.mkdir(selected, { recursive: true })
    await ensureWritable(selected)
    this.settings.update({ workspaceRoot: selected })
  }

  async saveState(state: WorkspaceUiState, ui?: Partial<UiState>, browser?: WorkspaceBrowserState): Promise<void> {
    if (!this.active) return
    const byId = new Map(this.active.manifest.documents.map((item) => [item.id, item]))
    const openIds = new Set(state.documentIds)
    const opened = state.documentIds.flatMap((id) => {
      const item = byId.get(id)
      return item ? [{ ...item, open: true, viewState: state.viewStates[id] }] : []
    })
    const closed = this.active.manifest.documents.filter((item) => !openIds.has(item.id)).map((item) => ({ ...item, open: false }))
    this.active.manifest.documents = [...opened, ...closed]
    this.active.manifest.activeDocumentId = state.activeDocumentId
    this.active.manifest.tray = state.tray
    this.active.manifest.question = state.question
    this.active.comparisons = structuredClone(state.comparisons ?? [])
    if (ui) this.active.manifest.ui = { ...this.active.manifest.ui, ...ui }
    if (browser) this.active.manifest.browser = structuredClone(browser)
    this.active.manifest.modifiedAt = new Date().toISOString()
    await Promise.all([this.writeManifest(), this.writeComparisons()])
  }

  async setBrowser(browser: WorkspaceBrowserState): Promise<void> {
    if (!this.active) return
    this.active.manifest.browser = structuredClone(browser)
    this.active.manifest.modifiedAt = new Date().toISOString()
    await this.writeManifest()
  }

  async updateUi(ui: Partial<UiState>): Promise<void> {
    if (!this.active) return
    this.active.manifest.ui = { ...this.active.manifest.ui, ...ui }
    this.active.manifest.modifiedAt = new Date().toISOString()
    await this.writeManifest()
  }

  async removeDocument(id: string): Promise<void> {
    if (!this.active) return
    this.active.manifest.documents = this.active.manifest.documents.map((item) => item.id === id ? { ...item, open: false } : item)
    if (this.active.manifest.activeDocumentId === id) this.active.manifest.activeDocumentId = this.active.manifest.documents.find((item) => item.open !== false)?.id ?? null
    await this.writeManifest()
  }

  document(id: string): WorkspaceDocumentRecord | undefined {
    return this.active?.manifest.documents.find((item) => item.id === id)
  }

  async documentPath(id: string): Promise<string | null> {
    const record = this.document(id)
    if (!record || !this.active) return null
    const candidate = path.resolve(this.active.path, record.relativePdfPath)
    const root = await fs.realpath(this.active.path)
    const real = await fs.realpath(candidate).catch(() => '')
    return real && contained(root, real) ? real : null
  }

  async importFromDialog(): Promise<{ operationId?: string; documents: ImportedDocument[]; cancelled?: boolean }> {
    if (!this.active) throw new Error('Create or open a workspace before importing PDFs.')
    const result = await dialog.showOpenDialog({ title: 'Import PDFs', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePaths.length) return { documents: [], cancelled: true }
    return this.importPaths(result.filePaths)
  }

  cancelImport(operationId: string): void { this.imports.get(operationId)?.abort() }

  async cancelAllImports(): Promise<void> {
    for (const controller of this.imports.values()) controller.abort()
    while (this.imports.size) await new Promise((resolve) => setTimeout(resolve, 20))
  }

  async flush(): Promise<void> { await this.manifestWrite }

  private async importPaths(paths: string[]): Promise<{ operationId: string; documents: ImportedDocument[]; cancelled?: boolean }> {
    if (!this.active) throw new Error('No active workspace.')
    const operationId = randomUUID()
    const controller = new AbortController()
    this.imports.set(operationId, controller)
    const stagingRoot = path.join(this.active.path, '.imports', operationId)
    const stats = await Promise.all(paths.map((item) => fs.stat(item)))
    const totalExpected = stats.reduce((sum, item) => sum + item.size, 0)
    let totalBytes = 0
    const staged: Array<{ record: WorkspaceDocumentRecord; stagedDirectory: string; finalDirectory: string }> = []
    const duplicates: ImportedDocument[] = []
    const knownFingerprints = new Map(this.active.manifest.documents.map((item) => [item.fingerprint, item]))
    const originalDocuments = structuredClone(this.active.manifest.documents)
    const originalActiveDocumentId = this.active.manifest.activeDocumentId
    try {
      await fs.mkdir(stagingRoot, { recursive: true })
      for (let index = 0; index < paths.length; index += 1) {
        if (controller.signal.aborted) throw abortError()
        const source = paths[index]
        const initial = stats[index]
        const name = path.basename(source)
        const id = randomUUID()
        const bundleName = `koibill-${slug(path.basename(name, path.extname(name)))}--${id.slice(0, 8)}`
        const stagedDirectory = path.join(stagingRoot, bundleName)
        const destination = path.join(stagedDirectory, name)
        await fs.mkdir(path.join(stagedDirectory, 'notes'), { recursive: true })
        const hash = createHash('sha256')
        const input = await fs.open(source, 'r')
        const output = await fs.open(destination, 'wx')
        let fileBytes = 0
        try {
          const buffer = Buffer.allocUnsafe(1024 * 1024)
          while (true) {
            if (controller.signal.aborted) throw abortError()
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
            if (!bytesRead) break
            await output.write(buffer, 0, bytesRead)
            hash.update(buffer.subarray(0, bytesRead)); fileBytes += bytesRead; totalBytes += bytesRead
            this.onProgress({ operationId, state: 'copying', fileName: name, fileIndex: index + 1, fileCount: paths.length, fileBytes, fileTotalBytes: initial.size, totalBytes, totalBytesExpected: totalExpected })
          }
          await output.sync()
        } finally { await Promise.allSettled([input.close(), output.close()]) }
        const current = await fs.stat(source)
        if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) throw new Error(`${name} changed while it was being copied.`)
        const fingerprint = hash.digest('hex')
        const duplicate = knownFingerprints.get(fingerprint)
        if (duplicate) {
          duplicate.open = true
          const existingPath = await this.documentPath(duplicate.id)
          if (existingPath) duplicates.push({ record: duplicate, path: existingPath, duplicate: true })
          await fs.rm(stagedDirectory, { recursive: true, force: true })
          continue
        }
        const relativeDirectory = path.posix.join('books', bundleName)
        const record: WorkspaceDocumentRecord = { id, name, open: true, relativeDirectory, relativePdfPath: path.posix.join(relativeDirectory, name), fingerprint }
        staged.push({ record, stagedDirectory, finalDirectory: path.join(this.active.path, relativeDirectory) })
        knownFingerprints.set(fingerprint, record)
      }
      this.onProgress({ operationId, state: 'finalizing', fileName: '', fileIndex: paths.length, fileCount: paths.length, fileBytes: 0, fileTotalBytes: 0, totalBytes, totalBytesExpected: totalExpected })
      for (const item of staged) {
        if (controller.signal.aborted) throw abortError()
        await fs.rename(item.stagedDirectory, item.finalDirectory)
      }
      this.active.manifest.documents.push(...staged.map((item) => item.record))
      this.active.manifest.activeDocumentId = staged.at(-1)?.record.id ?? duplicates.at(-1)?.record.id ?? this.active.manifest.activeDocumentId
      await this.writeManifest()
      const documents = [...duplicates, ...staged.map((item) => ({ record: item.record, path: path.join(this.active!.path, item.record.relativePdfPath), duplicate: false }))]
      this.onProgress({ operationId, state: 'complete', fileName: '', fileIndex: paths.length, fileCount: paths.length, fileBytes: 0, fileTotalBytes: 0, totalBytes, totalBytesExpected: totalExpected })
      return { operationId, documents }
    } catch (error) {
      const cancelled = controller.signal.aborted || (error as Error).name === 'AbortError'
      const message = cancelled ? 'Import cancelled.' : importErrorMessage(error)
      this.active.manifest.documents = originalDocuments
      this.active.manifest.activeDocumentId = originalActiveDocumentId
      for (const item of staged) await fs.rm(item.finalDirectory, { recursive: true, force: true }).catch(() => undefined)
      this.onProgress({ operationId, state: cancelled ? 'cancelled' : 'error', fileName: '', fileIndex: 0, fileCount: paths.length, fileBytes: 0, fileTotalBytes: 0, totalBytes, totalBytesExpected: totalExpected, message })
      if (!cancelled) throw new Error(message)
      return { operationId, documents: [], cancelled: true }
    } finally {
      this.imports.delete(operationId)
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async loadRegistered(registered: RegisteredWorkspace): Promise<void> {
    const directory = await fs.realpath(registered.path)
    const manifest = await readManifest(directory)
    if (manifest.id !== registered.id) throw new Error('Workspace identity does not match its registration.')
    await ensureWritable(directory)
    this.active = { path: directory, manifest, comparisons: await readComparisons(directory) }
    this.unavailable.delete(manifest.id)
    this.register({ ...registered, name: manifest.name, path: directory, lastOpenedAt: new Date().toISOString() })
    await this.cleanupStaging()
  }

  private async cleanupStaging(): Promise<void> {
    if (!this.active) return
    const staging = path.join(this.active.path, '.imports')
    await fs.mkdir(staging, { recursive: true })
    for (const entry of await fs.readdir(staging)) await fs.rm(path.join(staging, entry), { recursive: true, force: true })
  }

  private register(item: RegisteredWorkspace): void {
    const next = [item, ...this.registered.filter((candidate) => candidate.id !== item.id)].slice(0, 50)
    this.settings.update({ registeredWorkspaces: next, activeWorkspaceId: item.id })
  }

  private get registered(): RegisteredWorkspace[] { return this.settings.snapshot.registeredWorkspaces ?? [] }
  private get rootPath(): string { return this.settings.snapshot.workspaceRoot || path.join(app.getPath('documents'), 'koibill-workspaces') }

  private writeManifest(): Promise<void> {
    if (!this.active) return Promise.resolve()
    const target = path.join(this.active.path, 'workspace.json')
    const payload = JSON.stringify(this.active.manifest, null, 2)
    this.manifestWrite = this.manifestWrite.catch(() => undefined).then(() => atomicWrite(target, payload))
    return this.manifestWrite
  }

  private writeComparisons(): Promise<void> {
    if (!this.active) return Promise.resolve()
    const target = path.join(this.active.path, 'comparisons.json')
    const payload = JSON.stringify({ schemaVersion: 1, comparisons: this.active.comparisons }, null, 2)
    this.manifestWrite = this.manifestWrite.catch(() => undefined).then(() => atomicWrite(target, payload))
    return this.manifestWrite
  }
}

async function readComparisons(directory: string): Promise<AIComparisonRecord[]> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'comparisons.json'), 'utf8')) as Record<string, unknown>
    if (value.schemaVersion !== 1 || !Array.isArray(value.comparisons) || value.comparisons.length > 100 || !value.comparisons.every(isAIComparisonRecord)) throw new Error('Invalid comparisons file.')
    return (value.comparisons as AIComparisonRecord[]).map((comparison) => ({
      ...comparison,
      providers: comparison.providers.map((provider) => ['queued', 'loading', 'pending'].includes(provider.state)
        ? { ...provider, state: 'cancelled', message: 'Interrupted when koibill last closed. Retry to send again.' }
        : provider),
    }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function parseWorkspaceManifest(value: unknown): WorkspaceManifest | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1 || typeof item.id !== 'string' || typeof item.name !== 'string'
    || typeof item.createdAt !== 'string' || typeof item.modifiedAt !== 'string'
    || !Array.isArray(item.documents) || item.documents.length > 1000
    || !Array.isArray(item.tray) || !item.tray.every(isResearchTrayItem)
    || typeof item.question !== 'string' || item.question.length > 20_000
    || !isUi(item.ui) || !isBrowser(item.browser)) return null
  const documents: WorkspaceDocumentRecord[] = []
  const ids = new Set<string>()
  for (const raw of item.documents) {
    if (!raw || typeof raw !== 'object') return null
    const document = raw as Record<string, unknown>
    if (typeof document.id !== 'string' || ids.has(document.id) || typeof document.name !== 'string'
      || typeof document.relativeDirectory !== 'string' || !safeRelative(document.relativeDirectory)
      || typeof document.relativePdfPath !== 'string' || !safeRelative(document.relativePdfPath)
      || typeof document.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(document.fingerprint)
      || (document.open !== undefined && typeof document.open !== 'boolean')
      || (document.viewState !== undefined && !isViewState(document.viewState))) return null
    ids.add(document.id); documents.push(document as unknown as WorkspaceDocumentRecord)
  }
  if (item.activeDocumentId !== null && (typeof item.activeDocumentId !== 'string' || !documents.some((document) => document.id === item.activeDocumentId && document.open !== false))) return null
  return { ...(item as unknown as WorkspaceManifest), documents }
}

async function readManifest(directory: string): Promise<WorkspaceManifest> {
  try {
    const manifest = parseWorkspaceManifest(JSON.parse(await fs.readFile(path.join(directory, 'workspace.json'), 'utf8')))
    if (!manifest) throw new Error('invalid')
    return manifest
  } catch { throw new Error('This folder does not contain a valid koibill workspace.') }
}

function isUi(value: unknown): value is UiState {
  if (!value || typeof value !== 'object') return false
  const ui = value as Record<string, unknown>
  return Number(ui.splitRatio) >= .25 && Number(ui.splitRatio) <= .8 && ['browser', 'notes', 'graph'].includes(String(ui.rightPaneMode))
}

function isViewState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return Number(state.zoom) >= .25 && Number(state.zoom) <= 4
    && [0, 90, 180, 270].includes(Number(state.rotation))
    && Number.isInteger(state.currentPage) && Number(state.currentPage) > 0
    && isFocusSettings(state.focus) && isReflowSettings(state.reflow)
}

function isReflowSettings(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const reflow = value as Record<string, unknown>
  return ['original', 'reflow', 'split'].includes(String(reflow.mode))
    && Number(reflow.splitRatio) >= .25 && Number(reflow.splitRatio) <= .75
}

function isFocusSettings(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const focus = value as Record<string, unknown>
  return typeof focus.enabled === 'boolean'
    && ['line', 'sentence', 'paragraph'].includes(String(focus.unit))
    && Number(focus.surroundingVisibility) >= .05
    && Number(focus.surroundingVisibility) <= .4
    && (focus.magnification === undefined || (Number.isFinite(focus.magnification) && Number(focus.magnification) >= 1.1 && Number(focus.magnification) <= 1.6))
}

function isBrowser(value: unknown): value is WorkspaceBrowserState {
  if (!value || typeof value !== 'object') return false
  const browser = value as Record<string, unknown>
  if (!Array.isArray(browser.tabs) || browser.tabs.length > 100 || (browser.activeTabId !== null && typeof browser.activeTabId !== 'string')) return false
  const ids = new Set<string>()
  const valid = browser.tabs.every((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const tab = raw as Record<string, unknown>
    try {
      const protocol = new URL(String(tab.url)).protocol
      if (typeof tab.id !== 'string' || ids.has(tab.id)) return false
      ids.add(tab.id)
      return (protocol === 'https:' || String(tab.url) === 'about:blank') && Number(tab.zoomFactor) >= .5 && Number(tab.zoomFactor) <= 3 && Number.isFinite(tab.lastActivatedAt)
    }
    catch { return false }
  })
  return valid && (browser.activeTabId === null || ids.has(String(browser.activeTabId)))
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/u).includes('..') && path.normalize(value) === value
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function validateName(value: string): string {
  const clean = value.trim().replace(/[\u0000-\u001f]/gu, '')
  if (!clean || clean.length > 80) throw new Error('Workspace names must contain 1–80 characters.')
  return clean
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'workspace'
}

async function ensureWritable(directory: string): Promise<void> {
  const probe = path.join(directory, `.koibill-write-${randomUUID()}`)
  try { await fs.writeFile(probe, ''); await fs.unlink(probe) }
  catch { await fs.unlink(probe).catch(() => undefined); throw new Error('The selected workspace folder is not writable.') }
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, contents, 'utf8')
  await fs.rename(temporary, destination)
}

function abortError(): Error { return Object.assign(new Error('Import cancelled.'), { name: 'AbortError' }) }

function importErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') return 'There is not enough free space to import these PDFs.'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'The workspace or source PDF is not writable/readable with the current permissions.'
  if (code === 'ENOENT') return 'A selected PDF disappeared before it could be copied.'
  if (error instanceof Error && error.message.includes('changed while')) return error.message
  return 'The PDFs could not be copied into this workspace.'
}

async function exists(candidate: string): Promise<boolean> {
  try { await fs.access(candidate); return true } catch { return false }
}
