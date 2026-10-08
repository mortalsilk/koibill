// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Popover } from './Popover'

afterEach(cleanup)

describe('Popover', () => {
  it('opens, closes outside, and restores trigger focus on Escape', () => {
    render(<div><Popover label="Reading settings" trigger={<button>Open settings</button>}><button>First setting</button></Popover><button>Outside</button></div>)
    const trigger = screen.getByRole('button', { name: 'Open settings' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Reading settings' })).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Reading settings' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog', { name: 'Reading settings' })).toBeNull()
  })

  it('reports controlled state changes', () => {
    const change = vi.fn()
    render(<Popover label="Menu" open={false} onOpenChange={change} trigger={<button>Menu</button>}><button>Item</button></Popover>)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(change).toHaveBeenCalledWith(true)
  })
})
