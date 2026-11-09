import type { ProviderId } from '@survey-anything/shared';
import type { AdapterConfig, VisionProvider } from './adapter';
import { AnthropicAdapter } from './anthropic';
import { OpenAICompatibleAdapter } from './openai-compatible';

export * from './adapter';
export * from './anthropic';
export * from './errors';
export * from './failover';
export * from './http';
export * from './image';
export * from './openai-compatible';
export * from './parse';
export * from './probe';
export * from './prompt';

/** Text-only call for the Reasoner role (§6.1): it never receives a frame. */
export { parseReasonerOutput, reasonText, REASONER_SYSTEM, type ReasonerDecision, type ReasonerRequest, type ReasonerResponse } from './reasoner';

export function createProvider(cfg: AdapterConfig): VisionProvider & { chatImage: AnthropicAdapter['chatImage'] } {
  const id: ProviderId = cfg.id;
  switch (id) {
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'openai':
    case 'openrouter':
    case 'deepseek':
    case 'local':
      return new OpenAICompatibleAdapter(cfg);
  }
}
