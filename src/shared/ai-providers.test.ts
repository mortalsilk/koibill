// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_PROVIDERS, buildComposerScript, detectAIProvider, isAIConversationUrl } from './ai-providers'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })

describe('AI web provider registry', () => {
  it('detects every supported host and rejects lookalikes', () => {
    for (const provider of AI_PROVIDERS) expect(detectAIProvider(provider.homeUrl)?.id).toBe(provider.id)
    expect(detectAIProvider('https://chatgpt.com.example.test/c/1')).toBeUndefined()
  })

  it.each([
    ['chatgpt', 'https://chatgpt.com/c/example'],
    ['claude', 'https://claude.ai/chat/example'],
    ['gemini', 'https://gemini.google.com/app/example'],
    ['perplexity', 'https://www.perplexity.ai/search/example'],
    ['deepseek', 'https://chat.deepseek.com/a/chat/s/example'],
  ] as const)('recognizes %s conversation URLs', (provider, url) => {
    expect(isAIConversationUrl(url, provider)).toBe(true)
    expect(isAIConversationUrl(new URL('/', url).href, provider)).toBe(false)
  })

  it.each([
    ['chatgpt', '<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>', '#prompt-textarea'],
    ['claude', '<div data-testid="chat-input" contenteditable="true"></div><button aria-label="Send message">Send</button>', '[data-testid="chat-input"]'],
    ['gemini', '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button aria-label="Send message">Send</button>', '.ql-editor'],
    ['perplexity', '<textarea placeholder="Ask anything"></textarea><button aria-label="Submit">Send</button>', 'textarea'],
    ['deepseek', '<textarea placeholder="Message DeepSeek"></textarea><button aria-label="Send">Send</button>', 'textarea'],
  ] as const)('inserts and submits with the %s adapter', async (provider, fixture, selector) => {
    vi.useFakeTimers()
    document.body.innerHTML = fixture
    const button = document.querySelector('button')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    expect(window.eval(buildComposerScript(provider, 'Quoted passage', true))).toBe(true)
    const target = document.querySelector(selector) as HTMLTextAreaElement | HTMLElement
    expect(target instanceof HTMLTextAreaElement ? target.value : target.textContent).toBe('Quoted passage')
    await vi.advanceTimersByTimeAsync(150)
    expect(clicked).toHaveBeenCalledOnce()
  })
})

