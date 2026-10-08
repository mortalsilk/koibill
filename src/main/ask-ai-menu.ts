import type { MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { AI_PROVIDERS } from '../shared/ai-providers'
import type { AnnotationReference, AskAIRequest, SelectionMenuRequest } from '../shared/types'

export function createAskAIProviderMenu(
  base: SelectionMenuRequest,
  linkTargets: AnnotationReference[],
  run: (request: AskAIRequest) => void,
): MenuItemConstructorOptions[] {
  return AI_PROVIDERS.map((provider) => ({
    label: provider.name,
    submenu: [
      { label: 'Insert draft', click: () => run(requestFor(base, linkTargets, provider.id, 'draft')) },
      { label: 'Send now', click: () => run(requestFor(base, linkTargets, provider.id, 'send')) },
    ],
  }))
}

function requestFor(base: SelectionMenuRequest, linkTargets: AnnotationReference[], provider: AskAIRequest['provider'], mode: AskAIRequest['mode']): AskAIRequest {
  return { kind: 'selection', provider, requestId: randomUUID(), text: base.text, documentName: base.documentName, pageNumber: base.pageNumber, endPageNumber: base.endPageNumber, sourceSpans: base.sourceSpans, mode, linkTargets }
}
