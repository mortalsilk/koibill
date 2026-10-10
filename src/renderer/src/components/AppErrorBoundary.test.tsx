// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from './AppErrorBoundary'

function Broken(): React.JSX.Element { throw new Error('fixture failure') }

describe('application error boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows a recovery surface and can retry rendering', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(<AppErrorBoundary><Broken/></AppErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toContain('unexpected problem')
    rerender(<AppErrorBoundary><div>Recovered workspace</div></AppErrorBoundary>)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Recovered workspace')).toBeTruthy()
  })
})
