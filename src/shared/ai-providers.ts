import type { AIProviderId } from './types'

export interface AIWebProvider {
  id: AIProviderId
  name: string
  homeUrl: string
  hosts: readonly string[]
  composerSelectors: readonly string[]
  sendSelectors: readonly string[]
  conversationPaths: readonly RegExp[]
}

export const AI_PROVIDERS: readonly AIWebProvider[] = [
  {
    id: 'chatgpt', name: 'ChatGPT', homeUrl: 'https://chatgpt.com/', hosts: ['chatgpt.com'],
    composerSelectors: ['#prompt-textarea', 'textarea[data-id="root"]'],
    sendSelectors: ['[data-testid="send-button"]', 'button[aria-label*="Send"]'],
    conversationPaths: [/^\/c\/[^/]+/u],
  },
  {
    id: 'claude', name: 'Claude', homeUrl: 'https://claude.ai/new', hosts: ['claude.ai'],
    composerSelectors: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'],
    sendSelectors: ['button[aria-label*="Send"]', 'button[data-testid*="send"]'],
    conversationPaths: [/^\/chat\/[^/]+/u],
  },
  {
    id: 'gemini', name: 'Gemini', homeUrl: 'https://gemini.google.com/app', hosts: ['gemini.google.com'],
    composerSelectors: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[data-placeholder][contenteditable="true"]'],
    sendSelectors: ['button[aria-label*="Send message"]', 'button.send-button', 'button[aria-label*="Send"]'],
    conversationPaths: [/^\/app\/[^/]+/u],
  },
  {
    id: 'perplexity', name: 'Perplexity', homeUrl: 'https://www.perplexity.ai/', hosts: ['perplexity.ai'],
    composerSelectors: ['textarea[placeholder*="Ask"]', 'textarea[aria-label*="Ask"]', '[data-lexical-editor="true"][contenteditable="true"]'],
    sendSelectors: ['button[aria-label*="Submit"]', 'button[aria-label*="Send"]', 'button[data-testid*="submit"]'],
    conversationPaths: [/^\/search\/[^/]+/u, /^\/page\/[^/]+/u],
  },
  {
    id: 'deepseek', name: 'DeepSeek', homeUrl: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'],
    composerSelectors: ['textarea#chat-input', 'textarea[data-testid="chat-input"]', 'textarea[placeholder*="Message"]'],
    sendSelectors: ['button[aria-label*="Send"]', 'button[data-testid*="send"]'],
    conversationPaths: [/^\/a\/chat\/s\/[^/]+/u, /^\/chat\/[^/]+/u],
  },
] as const

export function isAIProviderId(value: unknown): value is AIProviderId {
  return AI_PROVIDERS.some((provider) => provider.id === value)
}

export function getAIProvider(id: AIProviderId): AIWebProvider {
  return AI_PROVIDERS.find((provider) => provider.id === id)!
}

export function detectAIProvider(value: string): AIWebProvider | undefined {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return AI_PROVIDERS.find((provider) => provider.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)))
  } catch {
    return undefined
  }
}

export function isAIProviderUrl(value: string, providerId?: AIProviderId): boolean {
  const provider = detectAIProvider(value)
  return Boolean(provider && (!providerId || provider.id === providerId))
}

export function isAIConversationUrl(value: string, providerId?: AIProviderId): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const provider = detectAIProvider(value)
    return Boolean(provider && (!providerId || provider.id === providerId)
      && provider.conversationPaths.some((pattern) => pattern.test(url.pathname)))
  } catch {
    return false
  }
}

export function buildComposerScript(providerId: AIProviderId, prompt: string, send: boolean): string {
  const provider = getAIProvider(providerId)
  return `(() => {
    const composerSelectors = ${JSON.stringify(provider.composerSelectors)};
    const sendSelectors = ${JSON.stringify(provider.sendSelectors)};
    const target = composerSelectors.map(selector => document.querySelector(selector)).find(element =>
      element instanceof HTMLElement && !element.hidden && element.getAttribute('aria-hidden') !== 'true'
    );
    if (!(target instanceof HTMLElement)) return false;
    const value = ${JSON.stringify(prompt)};
    target.focus();
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
      if (setter) setter.call(target, value); else target.value = value;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      target.replaceChildren(document.createTextNode(value));
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    if (${send}) setTimeout(() => {
      const button = sendSelectors.map(selector => document.querySelector(selector)).find(element =>
        element instanceof HTMLButtonElement && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      );
      if (button instanceof HTMLButtonElement) button.click();
      else target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }, 120);
    return true;
  })()`
}
