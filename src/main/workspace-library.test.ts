import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings, SettingsStore } from './storage'
import { parseWorkspaceManifest, WorkspaceLibrary } from './workspace-library'

const scratch: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function harness(root: string, progress: ConstructorParameters<typeof WorkspaceLibrary>[1] = () => undefined): { library: WorkspaceLibrary; settings: () => AppSettings } {
  let value: AppSettings = {
    splitRatio: .55, browserTabs: [], activeBrowserTabId: null, recentPdfs: [], sidecarOverrides: {}, workspaceOverrides: {},
    workspaceDocuments: [], activeWorkspaceDocumentId: null, researchTray: [], researchQuestion: '', rightPaneMode: 'browser', rightPaneCollapsed: false, reflowTypography: { fontScale: 1, lineHeight: 1.65, measure: 68 }, markdownNotes: '',
    acknowledgedAIProviders: [], workspaceRoot: root, registeredWorkspaces: [], activeWorkspaceId: null,
  }
  const settings = {
    get snapshot(): AppSettings { return structuredClone(value) },
    update(update: Partial<AppSettings>): void { value = { ...value, ...update } },
  } as SettingsStore
  return { library: new WorkspaceLibrary(settings, progress), settings: () => value }
}

describe('workspace library', () => {
  it('creates an immutable folder and a valid portable manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-library-')); scratch.push(root)
    const { library, settings } = harness(root)
    const result = await library.create('Literary Analysis')
    expect(result.workspace?.workspaceName).toBe('Literary Analysis')
    const registered = settings().registeredWorkspaces[0]
    expect(path.basename(registered.path)).toMatch(/^Literary-Analysis--[a-f0-9]{8}$/u)
    const manifest = parseWorkspaceManifest(JSON.parse(await readFile(path.join(registered.path, 'workspace.json'), 'utf8')))
    expect(manifest?.name).toBe('Literary Analysis')
    await library.rename(manifest!.id, 'Renamed')
    expect(settings().registeredWorkspaces[0].path).toBe(registered.path)
  })

  it('imports same-named PDFs transactionally and deduplicates fingerprints', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-import-')); scratch.push(root)
    const firstDirectory = path.join(root, 'one'); const secondDirectory = path.join(root, 'two')
    const { mkdir } = await import('node:fs/promises'); await mkdir(firstDirectory); await mkdir(secondDirectory)
    const first = path.join(firstDirectory, 'Book.pdf'); const second = path.join(secondDirectory, 'Book.pdf')
    await writeFile(first, '%PDF first'); await writeFile(second, '%PDF second')
    const { library, settings } = harness(root); await library.create('Research')
    const importer = library as unknown as { importPaths(paths: string[]): Promise<{ documents: Array<{ path: string; duplicate: boolean }> }> }
    const imported = await importer.importPaths([first, second])
    expect(imported.documents).toHaveLength(2)
    expect(new Set(imported.documents.map((item) => path.dirname(item.path))).size).toBe(2)
    expect((await stat(imported.documents[0].path)).isFile()).toBe(true)
    const duplicate = await importer.importPaths([first])
    expect(duplicate.documents[0].duplicate).toBe(true)
    const manifest = JSON.parse(await readFile(path.join(settings().registeredWorkspaces[0].path, 'workspace.json'), 'utf8'))
    expect(manifest.documents).toHaveLength(2)
    await library.removeDocument(manifest.documents[0].id)
    expect(library.restore().documents).toHaveLength(1)
    await importer.importPaths([first])
    expect(library.restore().documents).toHaveLength(2)
  })

  it('cancels a copy without committing partial books', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-cancel-')); scratch.push(root)
    const source = path.join(root, 'Large.pdf'); await writeFile(source, Buffer.alloc(3 * 1024 * 1024, 1))
    let library!: WorkspaceLibrary
    const setup = harness(root, (progress) => { if (progress.state === 'copying') library.cancelImport(progress.operationId) })
    library = setup.library; await library.create('Cancel test')
    const importer = library as unknown as { importPaths(paths: string[]): Promise<{ cancelled?: boolean }> }
    expect((await importer.importPaths([source])).cancelled).toBe(true)
    const workspacePath = setup.settings().registeredWorkspaces[0].path
    expect(await readdir(path.join(workspacePath, 'books'))).toEqual([])
    expect(await readdir(path.join(workspacePath, '.imports'))).toEqual([])
  })

  it('isolates workspace UI, research, and browser state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-switch-')); scratch.push(root)
    const { library } = harness(root)
    const first = await library.create('First')
    const firstId = first.workspace!.workspaceId!
    await library.saveState({ documentIds: [], activeDocumentId: null, viewStates: {}, tray: [], question: 'First question' }, { splitRatio: .42, rightPaneMode: 'graph' })
    await library.setBrowser({ tabs: [{ id: 'claude', url: 'https://claude.ai/new', zoomFactor: 1.2, lastActivatedAt: 4 }], activeTabId: 'claude' })
    await library.create('Second')
    await library.setBrowser({ tabs: [{ id: 'gemini', url: 'https://gemini.google.com/app', zoomFactor: 1, lastActivatedAt: 5 }], activeTabId: 'gemini' })
    await library.switchTo(firstId)
    expect(library.restore().question).toBe('First question')
    expect(library.activeUi).toEqual({ splitRatio: .42, rightPaneMode: 'graph' })
    expect(library.activeBrowser.tabs[0].url).toBe('https://claude.ai/new')
  })

  it('persists provider comparisons in the workspace companion file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'koibill-comparisons-')); scratch.push(root)
    const { library, settings } = harness(root)
    await library.create('Comparisons')
    const comparison = {
      id: 'compare', title: 'Two readings', prompt: 'Compare these.', promptEdited: false, contexts: [], linkTargets: [], excerpts: [],
      providers: [{ provider: 'chatgpt' as const, state: 'queued' as const }, { provider: 'claude' as const, state: 'inserted' as const }], createdAt: 'now', modifiedAt: 'now',
    }
    await library.saveState({ documentIds: [], activeDocumentId: null, viewStates: {}, tray: [], question: '', comparisons: [comparison] })
    const workspacePath = settings().registeredWorkspaces[0].path
    const stored = JSON.parse(await readFile(path.join(workspacePath, 'comparisons.json'), 'utf8'))
    expect(stored).toMatchObject({ schemaVersion: 1, comparisons: [{ id: 'compare' }] })
    expect(library.restore().comparisons?.[0].title).toBe('Two readings')
  })

  it('rejects paths which escape the workspace', () => {
    expect(parseWorkspaceManifest({
      schemaVersion: 1, id: 'id', name: 'Unsafe', createdAt: 'now', modifiedAt: 'now', activeDocumentId: 'doc', tray: [], question: '',
      ui: { splitRatio: .55, rightPaneMode: 'browser' }, browser: { tabs: [], activeTabId: null },
      documents: [{ id: 'doc', name: 'x.pdf', relativeDirectory: '../outside', relativePdfPath: '../x.pdf', fingerprint: 'a'.repeat(64) }],
    })).toBeNull()
  })

  it('accepts optional focus preferences and rejects unsupported modes', () => {
    const manifest = {
      schemaVersion: 1, id: 'id', name: 'Reading', createdAt: 'now', modifiedAt: 'now', activeDocumentId: 'doc', tray: [], question: '',
      ui: { splitRatio: .55, rightPaneMode: 'browser' }, browser: { tabs: [], activeTabId: null },
      documents: [{ id: 'doc', name: 'x.pdf', open: true, relativeDirectory: 'books/x', relativePdfPath: 'books/x/x.pdf', fingerprint: 'a'.repeat(64), viewState: { zoom: 1, rotation: 0, currentPage: 1, focus: { enabled: true, unit: 'paragraph', surroundingVisibility: .15 } } }],
    }
    expect(parseWorkspaceManifest(manifest)).not.toBeNull()
    const invalid = structuredClone(manifest)
    invalid.documents[0].viewState.focus.unit = 'section'
    expect(parseWorkspaceManifest(invalid)).toBeNull()
  })
})
