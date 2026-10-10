import type { AskAIContextItem, AskAIRequest } from './types'

export function formatPrompt(request: AskAIRequest): string {
  if (request.kind === 'composed') return request.prompt
  if (request.kind === 'selection') {
    return `I'm reading “${request.documentName}”, ${pageLabel(request.pageNumber, request.endPageNumber)}. Please help me understand this passage:\n\n> ${request.text.replace(/\n/g, '\n> ')}`
  }
  const instruction = request.question.trim() || 'Compare and synthesize these passages. Cite the numbered sources in your answer.'
  const sources = request.items.map((item, index) => (
    `[${index + 1}] “${item.documentName}”, ${pageLabel(item.pageNumber, item.endPageNumber)}\n> ${item.text.replace(/\n/g, '\n> ')}`
  )).join('\n\n')
  return `${instruction}\n\nSources:\n\n${sources}`
}

export function formatContextPrompt(instruction: string, contexts: AskAIContextItem[]): string {
  const enabled = contexts.filter((item) => item.enabled && item.text.trim())
  const heading = instruction.trim() || 'Please help me understand and evaluate the following material.'
  const sources = enabled.map((item, index) => {
    const document = item.documentName ? ` — “${item.documentName}”` : ''
    const page = item.pageNumber ? `, ${pageLabel(item.pageNumber, item.endPageNumber)}` : ''
    return `[${index + 1}] ${item.label}${document}${page}\n> ${item.text.trim().replace(/\n/g, '\n> ')}`
  }).join('\n\n')
  return sources ? `${heading}\n\nContext:\n\n${sources}` : heading
}

function pageLabel(start: number, end?: number): string {
  return end && end > start ? `pages ${start}–${end}` : `page ${start}`
}

export function promptLength(request: AskAIRequest): number {
  return formatPrompt(request).length
}
