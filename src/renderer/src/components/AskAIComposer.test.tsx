// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskAIComposer } from './AskAIComposer'

afterEach(cleanup)

const seed = {
  instruction: 'Explain the central claim.',
  contexts: [
    { id: 'passage', kind: 'selection' as const, label: 'Selected passage', text: 'A system is more than its parts.', enabled: true, documentName: 'systems.pdf', pageNumber: 12 },
    { id: 'note', kind: 'page-note' as const, label: 'Page note', text: 'Compare this with emergence.', enabled: false, documentName: 'systems.pdf', pageNumber: 12 },
  ],
  linkTargets: [],
}

describe('Ask AI context composer', () => {
  it('rebuilds the prompt from selected context and submits an explicit provider', () => {
    const onSingle = vi.fn()
    render(<AskAIComposer seed={seed} onClose={vi.fn()} onSingle={onSingle} onCompare={vi.fn()}/>)
    expect((screen.getByLabelText('Final prompt') as HTMLTextAreaElement).value).toContain('A system is more than its parts.')
    expect((screen.getByLabelText('Final prompt') as HTMLTextAreaElement).value).not.toContain('Compare this with emergence.')
    fireEvent.click(screen.getByText('Page note'))
    expect((screen.getByLabelText('Final prompt') as HTMLTextAreaElement).value).toContain('Compare this with emergence.')
    fireEvent.change(screen.getByLabelText('AI service'), { target: { value: 'deepseek' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(onSingle).toHaveBeenCalledWith('deepseek', 'send', expect.stringContaining('Compare this with emergence.'), expect.any(Array), false)
  })

  it('requires two providers and sends one shared comparison prompt', () => {
    const onCompare = vi.fn()
    render(<AskAIComposer seed={seed} onClose={vi.fn()} onSingle={vi.fn()} onCompare={onCompare}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Compare providers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 providers' }))
    expect(onCompare).toHaveBeenCalledWith(['chatgpt', 'claude'], expect.stringContaining('Explain the central claim.'), expect.any(Array), false)
  })

  it('keeps manual edits until the reader explicitly rebuilds', () => {
    render(<AskAIComposer seed={seed} onClose={vi.fn()} onSingle={vi.fn()} onCompare={vi.fn()}/>)
    fireEvent.change(screen.getByLabelText('Final prompt'), { target: { value: 'My exact prompt' } })
    fireEvent.click(screen.getByText('Page note'))
    expect((screen.getByLabelText('Final prompt') as HTMLTextAreaElement).value).toBe('My exact prompt')
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild from context' }))
    expect((screen.getByLabelText('Final prompt') as HTMLTextAreaElement).value).toContain('Compare this with emergence.')
  })

  it('supports a fully custom prompt and predictable dialog dismissal', () => {
    const onClose = vi.fn()
    const onSingle = vi.fn()
    const { container } = render(<AskAIComposer seed={seed} onClose={onClose} onSingle={onSingle} onCompare={vi.fn()}/>)
    expect(document.activeElement).toBe(screen.getByLabelText('Instruction'))
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    fireEvent.change(screen.getByLabelText('Final prompt'), { target: { value: 'A custom question without attached context.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Insert draft' }))
    expect(onSingle).toHaveBeenCalledWith('chatgpt', 'draft', 'A custom question without attached context.', expect.any(Array), true)
    fireEvent.mouseDown(container.firstElementChild!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not steal focus again when its parent rerenders', () => {
    const firstClose = vi.fn()
    const { rerender } = render(<AskAIComposer seed={seed} onClose={firstClose} onSingle={vi.fn()} onCompare={vi.fn()}/>)
    const prompt = screen.getByLabelText('Final prompt')
    prompt.focus()
    rerender(<AskAIComposer seed={seed} onClose={vi.fn()} onSingle={vi.fn()} onCompare={vi.fn()}/>)
    expect(document.activeElement).toBe(prompt)
  })
})
