import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PdfSession } from '../shared/types'
import { noteFileName, PdfSessionManager, SettingsStore, workspaceFolderName, type AppSettings } from './storage'

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(async (directory) => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  }))
})

describe('per-document page note layout', () => {
  it('uses one koibill folder per PDF name', () => {
    expect(workspaceFolderName('The Book')).toBe('koibill-The Book')
  })

  it('gives each page a stable, naturally sortable Markdown filename', () => {
    expect(noteFileName(1)).toBe('page-0001.md')
    expect(noteFileName(27)).toBe('page-0027.md')
    expect(noteFileName(10_000)).toBe('page-10000.md')
  })

  it('creates the document bundle immediately but page files only on request', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'koibill-notes-'))
    scratch.push(directory)
    const pdfPath = path.join(directory, 'Field Guide.pdf')
    await writeFile(pdfPath, '%PDF placeholder')
    let settings: AppSettings = {
      splitRatio: .55, browserTabs: [], activeBrowserTabId: null, recentPdfs: [], sidecarOverrides: {}, workspaceOverrides: {},
      workspaceDocuments: [], activeWorkspaceDocumentId: null, researchTray: [], researchQuestion: '', rightPaneMode: 'browser', rightPaneCollapsed: false, markdownNotes: '', acknowledgedAIProviders: [], workspaceRoot: '', registeredWorkspaces: [], activeWorkspaceId: null,
    }
    const fakeSettings = {
      get snapshot(): AppSettings { return structuredClone(settings) },
      update(update: Partial<AppSettings>): void { settings = { ...settings, ...update } },
    } as unknown as SettingsStore
    const manager = new PdfSessionManager(fakeSettings)
    const session = await (manager as unknown as { openPath(pdfPath: string): Promise<PdfSession> }).openPath(pdfPath)
    const bundle = path.join(directory, 'koibill-Field Guide')

    expect((await stat(path.join(bundle, 'notes'))).isDirectory()).toBe(true)
    expect(JSON.parse(await readFile(path.join(bundle, 'metadata.json'), 'utf8')).notes).toEqual({})
    expect((await manager.getPageNote(session.id, 12)).exists).toBe(false)
    expect((await manager.getDocumentNote(session.id)).exists).toBe(false)

    await manager.createPageNote(session.id, 12)
    await manager.savePageNote(session.id, 12, '# Page twelve\n\nA durable observation.')
    await manager.createDocumentNote(session.id)
    await manager.saveDocumentNote(session.id, '# Whole book\n\nA PDF-wide synthesis.')
    await manager.flush()

    expect(await readFile(path.join(bundle, 'notes', 'page-0012.md'), 'utf8')).toContain('A durable observation.')
    expect(await readFile(path.join(bundle, 'notes', 'document.md'), 'utf8')).toContain('A PDF-wide synthesis.')
    const metadata = JSON.parse(await readFile(path.join(bundle, 'metadata.json'), 'utf8'))
    expect(metadata.notes['12'].file).toBe('notes/page-0012.md')
    expect(metadata.documentNote.file).toBe('notes/document.md')
    expect(metadata.annotations.schemaVersion).toBe(2)

    const emptyGraph = await manager.getGraph(session.id)
    expect(emptyGraph.nodes).toEqual([])
    emptyGraph.nodes.push({
      id: 'idea-1', position: { x: 12, y: 24 }, title: 'A connection', userText: 'My synthesis', createdAt: 'now', modifiedAt: 'now',
      sources: [{ id: 'source-1', kind: 'pdf', excerpt: 'Evidence', pageNumber: 12, createdAt: 'now' }],
    })
    await manager.saveGraph(session.id, emptyGraph)
    await manager.flush()
    expect(JSON.parse(await readFile(path.join(bundle, 'graph.json'), 'utf8')).nodes[0].title).toBe('A connection')
    expect(JSON.parse(await readFile(path.join(bundle, 'metadata.json'), 'utf8')).graph.file).toBe('graph.json')
  })

  it('moves a legacy annotation sidecar into the new document bundle', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'koibill-migration-'))
    scratch.push(directory)
    const pdfPath = path.join(directory, 'Archive.pdf')
    await writeFile(pdfPath, '%PDF legacy placeholder')
    await writeFile(path.join(directory, 'Archive.koibill.json'), JSON.stringify({
      schemaVersion: 1,
      sourceFingerprint: 'old-fingerprint',
      sourceFilename: 'Archive.pdf',
      modifiedAt: '2025-01-01T00:00:00.000Z',
      pages: [],
      annotations: [{ id: 'highlight-1', type: 'highlight', pageIndex: 0, rects: [], color: '#facc15', opacity: .4, createdAt: '2025-01-01T00:00:00.000Z' }],
    }))
    let settings: AppSettings = {
      splitRatio: .55, browserTabs: [], activeBrowserTabId: null, recentPdfs: [], sidecarOverrides: {}, workspaceOverrides: {},
      workspaceDocuments: [], activeWorkspaceDocumentId: null, researchTray: [], researchQuestion: '', rightPaneMode: 'browser', rightPaneCollapsed: false, markdownNotes: '', acknowledgedAIProviders: [], workspaceRoot: '', registeredWorkspaces: [], activeWorkspaceId: null,
    }
    const fakeSettings = {
      get snapshot(): AppSettings { return structuredClone(settings) },
      update(update: Partial<AppSettings>): void { settings = { ...settings, ...update } },
    } as unknown as SettingsStore
    const manager = new PdfSessionManager(fakeSettings)
    const session = await (manager as unknown as { openPath(pdfPath: string): Promise<PdfSession> }).openPath(pdfPath)

    expect(session.annotations.annotations[0]?.id).toBe('highlight-1')
    expect(session.annotations.schemaVersion).toBe(2)
    expect((await stat(path.join(directory, 'koibill-Archive', 'legacy-annotations.v2.json'))).isFile()).toBe(true)
  })
})
