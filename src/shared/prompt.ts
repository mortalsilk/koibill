import type { AskAIRequest } from './types'

export function formatPrompt(request: AskAIRequest): string {
  if (request.kind === 'selection') {
    return `I'm reading “${request.documentName}”, page ${request.pageNumber}. Please help me understand this passage:\n\n> ${request.text.replace(/\n/g, '\n> ')}`
  }
  const instruction = request.question.trim() || 'Compare and synthesize these passages. Cite the numbered sources in your answer.'
  const sources = request.items.map((item, index) => (
    `[${index + 1}] “${item.documentName}”, page ${item.pageNumber}\n> ${item.text.replace(/\n/g, '\n> ')}`
  )).join('\n\n')
  return `${instruction}\n\nSources:\n\n${sources}`
}

export function promptLength(request: AskAIRequest): number {
  return formatPrompt(request).length
}
