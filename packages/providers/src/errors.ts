import type { ProviderErrorKind } from '@survey-anything/shared';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status: number | null = null,
    public readonly providerId: string | null = null,
    public readonly retryAfterSec: number | null = null,
    public readonly bodySnippet: string = '',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate-limit';
  if (status === 401) return 'auth';
  if (status === 402) return 'payment';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'bad-request';
}
