// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIProviderSelect } from './AIProviderSelect'

afterEach(cleanup)

describe('Ask AI provider selection', () => {
  it('shows all five providers and reports an explicit selection', () => {
    const onChange = vi.fn()
    render(<AIProviderSelect value="chatgpt" onChange={onChange}/>)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'DeepSeek'])
    fireEvent.change(screen.getByLabelText('AI service'), { target: { value: 'deepseek' } })
    expect(onChange).toHaveBeenCalledWith('deepseek')
  })
})

