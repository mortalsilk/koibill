import { describe, expect, it, vi } from 'vitest'
import { createAskAIProviderMenu } from './ask-ai-menu'

describe('native Ask AI menu', () => {
  it('gives every provider draft and send actions with the selected provider attached', () => {
    const run = vi.fn()
    const menu = createAskAIProviderMenu({ kind: 'selection', text: 'Passage', documentId: 'document', sourceFingerprint: 'fp', documentName: 'book.pdf', pageNumber: 3 }, [], run)
    expect(menu.map((item) => item.label)).toEqual(['ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'DeepSeek'])
    const claude = menu[1].submenu as Electron.MenuItemConstructorOptions[]
    expect(claude.map((item) => item.label)).toEqual(['Insert draft', 'Send now'])
    ;(claude[1].click as () => void)()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', mode: 'send', text: 'Passage' }))
  })
})

