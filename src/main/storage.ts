import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, dialog } from 'electron'
import type { AIProviderId, AnnotationDocument, GraphDocument, PdfDocumentNote, PdfPageNote, PdfSession, PdfTabDescriptor, PdfViewState, RecentPdf, ResearchWorkspace, RightPaneMode, WorkspaceUiState } from '../shared/types'
import { isGraphDocument, migrateAnnotationDocument } from '../shared/validation'
import type { WorkspaceLibrary } from './workspace-library'

interface StoredRecentPdf {
  id: string
  name: string
  path: string
}

interface StoredWorkspaceDocument {
  id: string
  name: string
  path: string
  fingerprint?: string
  viewState?: PdfViewState
}

export interface AppSettings {
  windowBounds?: { x: number; y: number; width: number; height: number }
  splitRatio: number
  browserTabs: Array<{ id: string; url: string; zoomFactor?: number; lastActivatedAt?: number }>
  activeBrowserTabId: string | null
  recentPdfs: StoredRecentPdf[]
  sidecarOverrides: Record<string, string>
  workspaceOverrides: Record<string, string>
  workspaceDocuments: StoredWorkspaceDocument[]
  activeWorkspaceDocumentId: string | null
  researchTray: ResearchWorkspace['tray']
  researchQuestion: string
  rightPaneMode: RightPaneMode
  rightPaneCollapsed: boolean
  markdownNotes: string
  acknowledgedAIProviders: AIProviderId[]
  workspaceRoot: string
  registeredWorkspaces: Array<{ id: string; name: string; path: string; lastOpenedAt: string }>
  activeWorkspaceId: string | null
}

const defaultSettings: AppSettings = {
  splitRatio: 0.55,
  browserTabs: [],
  activeBrowserTabId: null,
  recentPdfs: [],
  sidecarOverrides: {},
  workspaceOverrides: {},
  workspaceDocuments: [],
  activeWorkspaceDocumentId: null,
  researchTray: [],
  researchQuestion: '',
  rightPaneMode: 'browser',
  rightPaneCollapsed: false,
  // Retained only so pre-page-note releases can migrate a user's single note.
  markdownNotes: '',
  acknowledgedAIProviders: [],
  workspaceRoot: '',
  registeredWorkspaces: [],
  activeWorkspaceId: null,
}

export class SettingsStore {
  private value: AppSettings = structuredClone(defaultSettings)
  private writeQueue = Promise.resolve()

  async load(): Promise<void> {
    try {
      const contents = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(contents) as Partial<AppSettings>
      this.value = {
        ...structuredClone(defaultSettings),
        windowBounds: parsed.windowBounds,
        workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : '',
        registeredWorkspaces: Array.isArray(parsed.registeredWorkspaces) ? parsed.registeredWorkspaces.filter(isRegisteredWorkspace) : [],
        activeWorkspaceId: typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null,
        rightPaneCollapsed: parsed.rightPaneCollapsed === true,
        acknowledgedAIProviders: Array.isArray(parsed.acknowledgedAIProviders) ? parsed.acknowledgedAIProviders : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Unable to read settings', error)
    }
  }

  get snapshot(): AppSettings {
    return structuredClone(this.value)
  }

  update(update: Partial<AppSettings>): void {
    this.value = { ...this.value, ...update }
    this.writeQueue = this.writeQueue.then(() => atomicWrite(this.path, JSON.stringify(globalSettings(this.value), null, 2)))
  }

  flush(): Promise<void> { return this.writeQueue }

  private get path(): string {
    return path.join(app.getPath('userData'), 'settings.json')
  }
}

function isRegisteredWorkspace(value: unknown): value is AppSettings['registeredWorkspaces'][number] {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' && typeof item.lastOpenedAt === 'string'
}

function globalSettings(settings: AppSettings): Pick<AppSettings, 'windowBounds' | 'workspaceRoot' | 'registeredWorkspaces' | 'activeWorkspaceId' | 'acknowledgedAIProviders' | 'rightPaneCollapsed'> {
  return {
    windowBounds: settings.windowBounds,
    workspaceRoot: settings.workspaceRoot,
    registeredWorkspaces: settings.registeredWorkspaces,
    activeWorkspaceId: settings.activeWorkspaceId,
    acknowledgedAIProviders: settings.acknowledgedAIProviders,
    rightPaneCollapsed: settings.rightPaneCollapsed,
  }
}

interface OpenDocument {
  id: string
  documentId: string
  path: string
  name: string
  fingerprint: string
  workspacePath: string
  metadataPath: string
  metadata: DocumentMetadata
  bytes: Buffer
}

interface NoteMetadata {
  file: string
  createdAt: string
  modifiedAt: string
}

interface DocumentMetadata {
  schemaVersion: 1
  sourceFingerprint: string
  sourceFilename: string
  modifiedAt: string
  annotations: AnnotationDocument
  documentNote?: NoteMetadata
  notes: Record<string, NoteMetadata>
  graph?: { file: 'graph.json'; schemaVersion: 1; modifiedAt: string }
  viewState?: PdfViewState
  researchItems: ResearchWorkspace['tray']
}

export class PdfSessionManager {
  private readonly sessions = new Map<string, OpenDocument>()
  private readonly saveQueues = new Map<string, Promise<void>>()

  constructor(private readonly settings: SettingsStore, private readonly library?: WorkspaceLibrary) {}

  getRecents(): RecentPdf[] {
    if (this.library) return []
    return this.settings.snapshot.recentPdfs.map(({ id, name }) => ({ id, name }))
  }

  async openFromDialog(): Promise<PdfSession | null> {
    if (this.library) return (await this.importFromDialog()).sessions.at(-1) ?? null
    const result = await dialog.showOpenDialog({
      title: 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return this.openPath(result.filePaths[0])
  }

  async importFromDialog(): Promise<{ operationId?: string; sessions: PdfSession[]; cancelled?: boolean }> {
    if (!this.library) {
      const session = await this.openFromDialog()
      return { sessions: session ? [session] : [] }
    }
    const imported = await this.library.importFromDialog()
    const sessions: PdfSession[] = []
    for (const document of imported.documents) sessions.push(await this.openPath(document.path, document.record.id, path.dirname(document.path)))
    return { operationId: imported.operationId, sessions, cancelled: imported.cancelled }
  }

  async restoreWorkspace(): Promise<ResearchWorkspace> {
    if (this.library) return this.library.restore()
    const snapshot = this.settings.snapshot
    const documents: PdfTabDescriptor[] = await Promise.all(snapshot.workspaceDocuments.map(async (document) => ({
      documentId: document.id,
      name: document.name,
      fingerprint: document.fingerprint,
      missing: !(await pathExists(document.path)),
      viewState: document.viewState,
    })))
    const activeDocumentId = documents.some((document) => document.documentId === snapshot.activeWorkspaceDocumentId)
      ? snapshot.activeWorkspaceDocumentId
      : documents[0]?.documentId ?? null
    return { schemaVersion: 1, documents, activeDocumentId, tray: snapshot.researchTray, question: snapshot.researchQuestion }
  }

  async loadWorkspaceDocument(documentId: string): Promise<PdfSession | null> {
    if (this.library) {
      const pdfPath = await this.library.documentPath(documentId)
      return pdfPath ? this.openPath(pdfPath, documentId, path.dirname(pdfPath)) : null
    }
    const document = this.settings.snapshot.workspaceDocuments.find((item) => item.id === documentId)
    if (!document || !(await pathExists(document.path))) return null
    return this.openPath(document.path, document.id)
  }

  async locateWorkspaceDocument(documentId: string): Promise<PdfSession | null> {
    if (this.library) return null
    const existing = this.settings.snapshot.workspaceDocuments.find((item) => item.id === documentId)
    if (!existing) return null
    const result = await dialog.showOpenDialog({
      title: `Locate ${existing.name}`,
      properties: ['openFile'],
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return this.openPath(result.filePaths[0], documentId)
  }

  async saveWorkspace(state: WorkspaceUiState): Promise<void> {
    if (this.library) {
      await this.library.saveState(state)
      const writes: Promise<void>[] = []
      for (const session of this.sessions.values()) {
        const viewState = state.viewStates[session.documentId]
        if (!viewState) continue
        session.metadata = { ...session.metadata, modifiedAt: new Date().toISOString(), viewState, researchItems: state.tray.filter((item) => item.documentId === session.documentId) }
        writes.push(this.queueMetadataWrite(session))
      }
      await Promise.all(writes)
      return
    }
    const snapshot = this.settings.snapshot
    const byId = new Map(snapshot.workspaceDocuments.map((document) => [document.id, document]))
    const workspaceDocuments = state.documentIds.flatMap((id) => {
      const document = byId.get(id)
      return document ? [{ ...document, viewState: state.viewStates[id] }] : []
    })
    this.settings.update({
      workspaceDocuments,
      activeWorkspaceDocumentId: state.activeDocumentId,
      researchTray: state.tray,
      researchQuestion: state.question,
    })
    const writes: Promise<void>[] = []
    for (const session of this.sessions.values()) {
      const viewState = state.viewStates[session.documentId]
      if (!viewState) continue
      session.metadata = {
        ...session.metadata,
        modifiedAt: new Date().toISOString(),
        viewState,
        researchItems: state.tray.filter((item) => item.documentId === session.documentId),
      }
      writes.push(this.queueMetadataWrite(session))
    }
    await Promise.all(writes)
  }

  async closeWorkspaceDocument(documentId: string): Promise<void> {
    if (this.library) {
      for (const [sessionId, session] of this.sessions) if (session.documentId === documentId) this.sessions.delete(sessionId)
      await this.library.removeDocument(documentId)
      return
    }
    const snapshot = this.settings.snapshot
    const workspaceDocuments = snapshot.workspaceDocuments.filter((document) => document.id !== documentId)
    for (const [sessionId, session] of this.sessions) {
      if (session.documentId === documentId) this.sessions.delete(sessionId)
    }
    this.settings.update({
      workspaceDocuments,
      activeWorkspaceDocumentId: snapshot.activeWorkspaceDocumentId === documentId ? workspaceDocuments[0]?.id ?? null : snapshot.activeWorkspaceDocumentId,
    })
  }

  async openRecent(id: string): Promise<PdfSession | null> {
    if (this.library) return this.loadWorkspaceDocument(id)
    const recent = this.settings.snapshot.recentPdfs.find((item) => item.id === id)
    if (!recent) return null
    try {
      return await this.openPath(recent.path)
    } catch (error) {
      await dialog.showMessageBox({ type: 'error', title: 'Unable to open PDF', message: String(error) })
      return null
    }
  }

  async saveAnnotations(sessionId: string, document: AnnotationDocument): Promise<{ saved: boolean; pathLabel?: string }> {
    const session = this.requireSession(sessionId)
    const modifiedAt = new Date().toISOString()
    session.metadata = {
      ...session.metadata,
      sourceFingerprint: document.sourceFingerprint,
      sourceFilename: document.sourceFilename,
      modifiedAt,
      annotations: { ...document, modifiedAt },
    }
    await this.queueMetadataWrite(session)
    return { saved: true, pathLabel: path.join(path.basename(session.workspacePath), 'metadata.json') }
  }

  async getPageNote(sessionId: string, pageNumber: number): Promise<PdfPageNote> {
    const session = this.requireSession(sessionId)
    const note = session.metadata.notes[String(pageNumber)]
    const pathLabel = notePathLabel(session, pageNumber)
    if (!note) return { pageNumber, exists: false, content: '', pathLabel }
    try {
      const content = await fs.readFile(path.join(session.workspacePath, note.file), 'utf8')
      return { pageNumber, exists: true, content, pathLabel, modifiedAt: note.modifiedAt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pageNumber, exists: false, content: '', pathLabel }
      throw error
    }
  }

  async createPageNote(sessionId: string, pageNumber: number): Promise<PdfPageNote> {
    const session = this.requireSession(sessionId)
    const existing = await this.getPageNote(sessionId, pageNumber)
    if (existing.exists) return existing
    const content = `# ${path.basename(session.name, path.extname(session.name))} — Page ${pageNumber}\n\n`
    return this.writePageNote(session, pageNumber, content, true)
  }

  async savePageNote(sessionId: string, pageNumber: number, content: string): Promise<PdfPageNote> {
    const session = this.requireSession(sessionId)
    if (!session.metadata.notes[String(pageNumber)]) throw new Error('Create this page note before saving it.')
    return this.writePageNote(session, pageNumber, content, false)
  }

  async getDocumentNote(sessionId: string): Promise<PdfDocumentNote> {
    const session = this.requireSession(sessionId)
    const note = session.metadata.documentNote
    const pathLabel = documentNotePathLabel(session)
    if (!note) return { exists: false, content: '', pathLabel }
    try {
      const content = await fs.readFile(path.join(session.workspacePath, note.file), 'utf8')
      return { exists: true, content, pathLabel, modifiedAt: note.modifiedAt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, content: '', pathLabel }
      throw error
    }
  }

  async createDocumentNote(sessionId: string): Promise<PdfDocumentNote> {
    const session = this.requireSession(sessionId)
    const existing = await this.getDocumentNote(sessionId)
    if (existing.exists) return existing
    const content = `# ${path.basename(session.name, path.extname(session.name))}\n\n`
    return this.writeDocumentNote(session, content, true)
  }

  async saveDocumentNote(sessionId: string, content: string): Promise<PdfDocumentNote> {
    const session = this.requireSession(sessionId)
    if (!session.metadata.documentNote) throw new Error('Create the document note before saving it.')
    return this.writeDocumentNote(session, content, false)
  }

  async getGraph(sessionId: string): Promise<GraphDocument> {
    const session = this.requireSession(sessionId)
    const destination = path.join(session.workspacePath, 'graph.json')
    try {
      const graph = JSON.parse(await fs.readFile(destination, 'utf8')) as unknown
      if (!isGraphDocument(graph)) throw new Error('The graph file contains invalid data.')
      return graph
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyGraphDocument(session.fingerprint, session.name)
      throw error
    }
  }

  async saveGraph(sessionId: string, graph: GraphDocument): Promise<void> {
    const session = this.requireSession(sessionId)
    const modifiedAt = new Date().toISOString()
    const savedGraph: GraphDocument = {
      ...graph,
      sourceFingerprint: session.fingerprint,
      sourceFilename: session.name,
      modifiedAt,
    }
    session.metadata = {
      ...session.metadata,
      modifiedAt,
      graph: { file: 'graph.json', schemaVersion: 1, modifiedAt },
    }
    await this.queueWorkspaceWrite(session, async () => {
      await atomicWrite(path.join(session.workspacePath, 'graph.json'), JSON.stringify(savedGraph, null, 2))
      await atomicWrite(session.metadataPath, JSON.stringify(session.metadata, null, 2))
    })
  }

  getSession(id: string): OpenDocument {
    return this.requireSession(id)
  }

  async flush(): Promise<void> {
    while (this.saveQueues.size) await Promise.all([...this.saveQueues.values()])
    await this.library?.flush()
  }

  releaseAll(): void { this.sessions.clear() }

  private async openPath(pdfPath: string, requestedDocumentId?: string, managedWorkspacePath?: string): Promise<PdfSession> {
    const bytes = await fs.readFile(pdfPath)
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    const name = path.basename(pdfPath)
    const bookName = path.basename(pdfPath, path.extname(pdfPath))
    const workspacePath = managedWorkspacePath ?? await this.resolveWorkspacePath(pdfPath, fingerprint, bookName)
    const metadataPath = path.join(workspacePath, 'metadata.json')
    const legacyDefault = path.join(path.dirname(pdfPath), `${bookName}.koibill.json`)
    const legacyOverride = this.settings.snapshot.sidecarOverrides[fingerprint]
    let annotations = emptyAnnotationDocument(fingerprint, name)
    let metadata = emptyDocumentMetadata(fingerprint, name, annotations)
    let fingerprintMismatch = false

    try {
      const parsedMetadata = parseDocumentMetadata(JSON.parse(await fs.readFile(metadataPath, 'utf8')))
      if (!parsedMetadata) throw new Error('This book contains invalid koibill metadata.')
      metadata = parsedMetadata
      annotations = parsedMetadata.annotations
      fingerprintMismatch = parsedMetadata.sourceFingerprint !== fingerprint
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Unable to read koibill document metadata', error)
        throw error
      }
      const legacyPath = managedWorkspacePath ? '' : legacyOverride ?? legacyDefault
      try {
        if (!legacyPath) throw Object.assign(new Error('No legacy sidecar'), { code: 'ENOENT' })
        const parsed = migrateAnnotationDocument(JSON.parse(await fs.readFile(legacyPath, 'utf8')))
        if (parsed) {
          annotations = parsed
          fingerprintMismatch = parsed.sourceFingerprint !== fingerprint
          metadata = emptyDocumentMetadata(parsed.sourceFingerprint, name, parsed)
          await atomicWrite(metadataPath, JSON.stringify(metadata, null, 2))
          const archivedLegacy = path.join(workspacePath, 'legacy-annotations.v2.json')
          if (legacyPath !== archivedLegacy && !(await pathExists(archivedLegacy))) await fs.rename(legacyPath, archivedLegacy)
        }
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Unable to migrate legacy annotation sidecar', legacyError)
      }
    }

    if (!(await pathExists(metadataPath))) await atomicWrite(metadataPath, JSON.stringify(metadata, null, 2))

    const legacyNote = managedWorkspacePath ? '' : this.settings.snapshot.markdownNotes.trim()
    if (legacyNote && legacyNote !== '# Notes\n\nStart writing alongside your reading.' && !metadata.notes['1']) {
      const timestamp = new Date().toISOString()
      const file = path.join('notes', noteFileName(1))
      await atomicWrite(path.join(workspacePath, file), this.settings.snapshot.markdownNotes)
      metadata = {
        ...metadata,
        modifiedAt: timestamp,
        notes: { ...metadata.notes, '1': { file, createdAt: timestamp, modifiedAt: timestamp } },
      }
      await atomicWrite(metadataPath, JSON.stringify(metadata, null, 2))
    }
    if (!managedWorkspacePath && this.settings.snapshot.markdownNotes) this.settings.update({ markdownNotes: '' })

    const id = randomUUID()
    const recentId = createHash('sha1').update(pdfPath).digest('hex')
    const existingWorkspaceDocument = this.settings.snapshot.workspaceDocuments.find((item) => item.path === pdfPath)
    const documentId = requestedDocumentId ?? existingWorkspaceDocument?.id ?? recentId
    this.sessions.set(id, { id, documentId, path: pdfPath, name, fingerprint, workspacePath, metadataPath, metadata, bytes })
    if (this.library) {
      return {
        id, documentId, name, fingerprint, bytes: new Uint8Array(bytes), annotations, fingerprintMismatch,
        viewState: metadata.viewState, researchItems: metadata.researchItems,
      }
    }
    const recents = this.settings.snapshot.recentPdfs.filter((item) => item.path !== pdfPath)
    recents.unshift({ id: recentId, name, path: pdfPath })
    const workspace = this.settings.snapshot.workspaceDocuments
    const existingIndex = workspace.findIndex((item) => item.id === documentId || item.path === pdfPath)
    const descriptor = { id: documentId, name, path: pdfPath, fingerprint, viewState: existingIndex >= 0 ? workspace[existingIndex].viewState : metadata.viewState }
    const workspaceDocuments = existingIndex >= 0
      ? workspace.map((item, index) => index === existingIndex ? descriptor : item)
      : [...workspace, descriptor]
    const portableResearchItems = metadata.researchItems.filter((item) => !this.settings.snapshot.researchTray.some((existing) => existing.id === item.id))
    this.settings.update({
      recentPdfs: recents.slice(0, 10),
      workspaceDocuments,
      activeWorkspaceDocumentId: documentId,
      researchTray: [...this.settings.snapshot.researchTray, ...portableResearchItems],
    })

    return {
      id, documentId, name, fingerprint, bytes: new Uint8Array(bytes), annotations, fingerprintMismatch,
      viewState: metadata.viewState,
      researchItems: metadata.researchItems,
    }
  }

  private requireSession(id: string): OpenDocument {
    const session = this.sessions.get(id)
    if (!session) throw new Error('The PDF session is no longer available.')
    return session
  }

  private async resolveWorkspacePath(pdfPath: string, fingerprint: string, bookName: string): Promise<string> {
    const folderName = workspaceFolderName(bookName)
    const preferred = this.settings.snapshot.workspaceOverrides[fingerprint] ?? path.join(path.dirname(pdfPath), folderName)
    try {
      await fs.mkdir(path.join(preferred, 'notes'), { recursive: true })
      return preferred
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EACCES' && code !== 'EROFS' && code !== 'EPERM') throw error
      const fallback = await dialog.showOpenDialog({
        title: `Choose a location for ${folderName}`,
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (fallback.canceled || !fallback.filePaths[0]) throw new Error(`koibill needs a writable location for ${folderName}.`)
      const selected = path.join(fallback.filePaths[0], folderName)
      await fs.mkdir(path.join(selected, 'notes'), { recursive: true })
      this.settings.update({ workspaceOverrides: { ...this.settings.snapshot.workspaceOverrides, [fingerprint]: selected } })
      return selected
    }
  }

  private writePageNote(session: OpenDocument, pageNumber: number, content: string, creating: boolean): Promise<PdfPageNote> {
    const timestamp = new Date().toISOString()
    const file = path.join('notes', noteFileName(pageNumber))
    const previous = session.metadata.notes[String(pageNumber)]
    session.metadata = {
      ...session.metadata,
      modifiedAt: timestamp,
      notes: {
        ...session.metadata.notes,
        [String(pageNumber)]: { file, createdAt: previous?.createdAt ?? timestamp, modifiedAt: timestamp },
      },
    }
    const destination = path.join(session.workspacePath, file)
    return this.queueWorkspaceWrite(session, async () => {
      if (creating && await pathExists(destination)) {
        const existing = await fs.readFile(destination, 'utf8')
        return { pageNumber, exists: true, content: existing, pathLabel: notePathLabel(session, pageNumber), modifiedAt: timestamp }
      }
      await atomicWrite(destination, content)
      await atomicWrite(session.metadataPath, JSON.stringify(session.metadata, null, 2))
      return { pageNumber, exists: true, content, pathLabel: notePathLabel(session, pageNumber), modifiedAt: timestamp }
    })
  }

  private writeDocumentNote(session: OpenDocument, content: string, creating: boolean): Promise<PdfDocumentNote> {
    const timestamp = new Date().toISOString()
    const file = path.join('notes', 'document.md')
    const previous = session.metadata.documentNote
    session.metadata = {
      ...session.metadata,
      modifiedAt: timestamp,
      documentNote: { file, createdAt: previous?.createdAt ?? timestamp, modifiedAt: timestamp },
    }
    const destination = path.join(session.workspacePath, file)
    return this.queueWorkspaceWrite(session, async () => {
      if (creating && await pathExists(destination)) {
        const existing = await fs.readFile(destination, 'utf8')
        return { exists: true, content: existing, pathLabel: documentNotePathLabel(session), modifiedAt: timestamp }
      }
      await atomicWrite(destination, content)
      await atomicWrite(session.metadataPath, JSON.stringify(session.metadata, null, 2))
      return { exists: true, content, pathLabel: documentNotePathLabel(session), modifiedAt: timestamp }
    })
  }

  private queueMetadataWrite(session: OpenDocument): Promise<void> {
    return this.queueWorkspaceWrite(session, () => atomicWrite(session.metadataPath, JSON.stringify(session.metadata, null, 2)))
  }

  private queueWorkspaceWrite<T>(session: OpenDocument, operation: () => Promise<T>): Promise<T> {
    const key = session.workspacePath
    const previous = this.saveQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    const tracked = next.then(() => undefined, () => undefined)
    this.saveQueues.set(key, tracked)
    return next.finally(() => { if (this.saveQueues.get(key) === tracked) this.saveQueues.delete(key) })
  }
}

export function workspaceFolderName(bookName: string): string {
  return `koibill-${bookName}`
}

export function noteFileName(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(4, '0')}.md`
}

function notePathLabel(session: OpenDocument, pageNumber: number): string {
  return path.join(path.basename(session.workspacePath), 'notes', noteFileName(pageNumber))
}

function documentNotePathLabel(session: OpenDocument): string {
  return path.join(path.basename(session.workspacePath), 'notes', 'document.md')
}

function emptyDocumentMetadata(fingerprint: string, filename: string, annotations: AnnotationDocument): DocumentMetadata {
  return { schemaVersion: 1, sourceFingerprint: fingerprint, sourceFilename: filename, modifiedAt: new Date().toISOString(), annotations, notes: {}, researchItems: [] }
}

export function emptyGraphDocument(fingerprint: string, filename: string): GraphDocument {
  return {
    schemaVersion: 1,
    sourceFingerprint: fingerprint,
    sourceFilename: filename,
    modifiedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

function parseDocumentMetadata(value: unknown): DocumentMetadata | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const annotations = migrateAnnotationDocument(candidate.annotations)
  const notes = candidate.notes
  if (candidate.schemaVersion !== 1 || typeof candidate.sourceFingerprint !== 'string'
    || typeof candidate.sourceFilename !== 'string' || typeof candidate.modifiedAt !== 'string'
    || !annotations || !notes || typeof notes !== 'object' || Array.isArray(notes)) return null
  const validNotes: Record<string, NoteMetadata> = {}
  for (const [page, entry] of Object.entries(notes as Record<string, unknown>)) {
    if (!/^\d+$/u.test(page) || !entry || typeof entry !== 'object') continue
    const note = entry as Record<string, unknown>
    if (typeof note.file === 'string' && /^notes\/page-\d{4,}\.md$/u.test(note.file)
      && typeof note.createdAt === 'string' && typeof note.modifiedAt === 'string') {
      validNotes[page] = { file: note.file, createdAt: note.createdAt, modifiedAt: note.modifiedAt }
    }
  }
  return {
    schemaVersion: 1,
    sourceFingerprint: candidate.sourceFingerprint,
    sourceFilename: candidate.sourceFilename,
    modifiedAt: candidate.modifiedAt,
    annotations,
    documentNote: isNoteMetadata(candidate.documentNote, /^notes\/document\.md$/u),
    notes: validNotes,
    graph: isGraphMetadata(candidate.graph),
    viewState: isStoredViewState(candidate.viewState) ? candidate.viewState : undefined,
    researchItems: Array.isArray(candidate.researchItems) ? candidate.researchItems.filter(isStoredResearchItem) as ResearchWorkspace['tray'] : [],
  }
}

function isGraphMetadata(value: unknown): DocumentMetadata['graph'] {
  if (!value || typeof value !== 'object') return undefined
  const graph = value as Record<string, unknown>
  return graph.file === 'graph.json' && graph.schemaVersion === 1 && typeof graph.modifiedAt === 'string'
    ? { file: 'graph.json', schemaVersion: 1, modifiedAt: graph.modifiedAt }
    : undefined
}

function isNoteMetadata(value: unknown, filePattern: RegExp): NoteMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined
  const note = value as Record<string, unknown>
  return typeof note.file === 'string' && filePattern.test(note.file)
    && typeof note.createdAt === 'string' && typeof note.modifiedAt === 'string'
    ? { file: note.file, createdAt: note.createdAt, modifiedAt: note.modifiedAt }
    : undefined
}

function isStoredViewState(value: unknown): value is PdfViewState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return Number.isFinite(state.zoom) && Number(state.zoom) >= .25 && Number(state.zoom) <= 4
    && Number.isInteger(state.rotation) && [0, 90, 180, 270].includes(Number(state.rotation))
    && Number.isInteger(state.currentPage) && Number(state.currentPage) > 0
    && isStoredFocusSettings(state.focus)
}

function isStoredFocusSettings(value: unknown): boolean {
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

function isStoredResearchItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.documentId === 'string' && typeof item.sourceFingerprint === 'string'
    && typeof item.documentName === 'string' && Number.isInteger(item.pageNumber) && Number(item.pageNumber) > 0
    && typeof item.text === 'string' && item.text.length <= 20_000 && typeof item.createdAt === 'string'
}

export function emptyAnnotationDocument(fingerprint: string, filename: string): AnnotationDocument {
  return {
    schemaVersion: 2,
    sourceFingerprint: fingerprint,
    sourceFilename: filename,
    modifiedAt: new Date().toISOString(),
    pages: [],
    annotations: [],
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

export async function atomicWrite(destination: string, contents: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, contents)
  await fs.rename(temporary, destination)
}
