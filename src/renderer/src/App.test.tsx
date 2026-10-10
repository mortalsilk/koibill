// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

vi.mock('./components/PdfWorkspace', () => ({ PdfWorkspace: () => <div>PDF workspace</div> }))
vi.mock('./components/WorkspaceMenu', () => ({ WorkspaceMenu: () => <div>Workspace menu</div>, WorkspaceChooser: () => <div>Chooser</div> }))
vi.mock('./components/BrowserPane', () => ({ BrowserPane: ({ active }: { active: boolean }) => <div data-testid="browser-pane" data-active={String(active)}/> }))
vi.mock('./components/NotesPane', () => ({ NotesPane: () => <div>Notes pane</div> }))
vi.mock('./components/GraphPane', () => ({ GraphPane: () => <div>Graph pane</div> }))

let showBrowser: (() => void) | undefined
let remoteToggle: (() => void) | undefined
const saveUiState = vi.fn(async () => undefined)

afterEach(cleanup)

beforeEach(() => {
  showBrowser = undefined; remoteToggle = undefined; saveUiState.mockClear()
  window.koibill = {
    getUiState: vi.fn(async () => ({ splitRatio: .55, rightPaneMode: 'browser' as const, rightPaneCollapsed: false })),
    getWorkspaceLibrary: vi.fn(async () => ({ rootLabel: 'Workspaces', activeWorkspaceId: 'workspace', workspaces: [] })),
    saveUiState,
    onBrowserShowRequested: vi.fn((callback: () => void) => { showBrowser = callback; return () => undefined }),
    onRightPaneToggleRequested: vi.fn((callback: () => void) => { remoteToggle = callback; return () => undefined }),
    onWorkspaceFlushRequest: vi.fn(() => () => undefined),
  } as unknown as typeof window.koibill
})

describe('collapsible right workspace', () => {
  it('collapses to a toggle rail and restores the retained surface', async () => {
    const { container } = render(<App/>)
    const collapse = await screen.findByRole('button', { name: 'Collapse right pane' })
    fireEvent.click(collapse)
    expect(container.querySelector('.app-shell')?.classList.contains('right-collapsed')).toBe(true)
    expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Expand right pane' }))
    expect(container.querySelector('.app-shell')?.classList.contains('right-collapsed')).toBe(false)
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true'), { timeout: 500 })
  })

  it('supports Ctrl+\\ and automatically expands for browser requests', async () => {
    const { container } = render(<App/>)
    await screen.findByRole('button', { name: 'Collapse right pane' })
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
    expect(container.querySelector('.app-shell')?.classList.contains('right-collapsed')).toBe(true)
    act(() => showBrowser?.())
    expect(container.querySelector('.app-shell')?.classList.contains('right-collapsed')).toBe(false)
    act(() => remoteToggle?.())
    expect(container.querySelector('.app-shell')?.classList.contains('right-collapsed')).toBe(true)
  })

  it('persists collapsed state globally', async () => {
    render(<App/>)
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse right pane' }))
    await waitFor(() => expect(saveUiState).toHaveBeenCalledWith(expect.objectContaining({ rightPaneCollapsed: true })), { timeout: 500 })
  })

  it('detaches the embedded browser while an application overlay is open', async () => {
    render(<App/>)
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true'), { timeout: 500 })
    const overlay = document.createElement('div')
    overlay.className = 'modal-backdrop'
    document.body.append(overlay)
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('false'))
    overlay.remove()
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true'))
  })

  it('detaches the embedded browser while a portalled popover is open', async () => {
    render(<App/>)
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true'), { timeout: 500 })
    const popover = document.createElement('div')
    popover.className = 'ui-popover'
    document.body.append(popover)
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('false'))
    popover.remove()
    await waitFor(() => expect(screen.getByTestId('browser-pane').getAttribute('data-active')).toBe('true'))
  })
})
