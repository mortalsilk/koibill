// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceLibrarySettings } from '../../../shared/types'
import { WorkspaceChooser, WorkspaceMenu } from './WorkspaceMenu'

afterEach(cleanup)

const library: WorkspaceLibrarySettings = {
  rootLabel: 'Documents/koibill-workspaces', activeWorkspaceId: 'one',
  workspaces: [
    { id: 'one', name: 'Thesis', available: true, active: true, lastOpenedAt: '2026-01-01' },
    { id: 'two', name: 'Reading list', available: true, active: false, lastOpenedAt: '2025-01-01' },
  ],
}

describe('workspace navigation', () => {
  it('shows management actions and recent workspaces', () => {
    render(<WorkspaceMenu library={library} onLibrary={vi.fn()} onWorkspace={vi.fn()}/>)
    fireEvent.click(screen.getByRole('button', { name: /koibillthesis/i }))
    expect(screen.getByText('New Workspace')).toBeTruthy()
    expect(screen.getByText('Open Existing Workspace')).toBeTruthy()
    expect(screen.getByText('Reading list')).toBeTruthy()
    expect(screen.getByText('Rename Workspace')).toBeTruthy()
    expect(screen.getByText('Remove from Recents')).toBeTruthy()
  })

  it('presents creation and existing-workspace entry points when empty', () => {
    render(<WorkspaceChooser library={{ ...library, activeWorkspaceId: null, workspaces: [] }} onLibrary={vi.fn()} onWorkspace={vi.fn()}/>)
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Workspace name'))
    expect(screen.getByRole('button', { name: 'Open Existing Workspace' })).toBeTruthy()
  })
})
