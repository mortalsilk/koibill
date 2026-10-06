import { AI_PROVIDERS } from '../../../shared/ai-providers'
import type { AIProviderId } from '../../../shared/types'

export function AIProviderSelect({ value, onChange }: { value: AIProviderId; onChange: (provider: AIProviderId) => void }): React.JSX.Element {
  return <label className="ai-provider-select">Ask with<select aria-label="AI service" value={value} onChange={(event) => onChange(event.target.value as AIProviderId)}>{AI_PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
}

