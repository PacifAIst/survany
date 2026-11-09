/**
 * OME REST client. The API listens only on the compose network with an AccessToken (SG-20).
 * Used to cut a stream immediately on Stop or /stop; admission `lifetime` cuts it at TTL anyway.
 */
export class OmeClient {
  constructor(
    private readonly apiUrl: string,
    private readonly accessToken: string,
    private readonly app: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private auth(): string {
    return `Basic ${Buffer.from(this.accessToken).toString('base64')}`;
  }

  async deleteStream(streamId: string): Promise<boolean> {
    const res = await this.fetchFn(`${this.apiUrl}/v1/vhosts/default/apps/${encodeURIComponent(this.app)}/streams/${encodeURIComponent(streamId)}`, {
      method: 'DELETE',
      headers: { authorization: this.auth() },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok || res.status === 404;
  }

  async listStreams(): Promise<string[]> {
    const res = await this.fetchFn(`${this.apiUrl}/v1/vhosts/default/apps/${encodeURIComponent(this.app)}/streams`, {
      headers: { authorization: this.auth() },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`OME API HTTP ${res.status}`);
    const j = (await res.json()) as { response?: string[] };
    return j.response ?? [];
  }
}
