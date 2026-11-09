import type { DetectionResult, ProviderId } from '@survey-anything/shared';
import type { FetchFn } from './http';
import { parseDetection } from './parse';
import { buildPrompt } from './prompt';
import { blobToBase64 } from './image';
import { runProbe, type ProbeOpts, type ProbeResult } from './probe';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatImageRequest {
  imageB64: string;
  mime: 'image/jpeg' | 'image/png';
  system: string;
  user: string;
  maxOutputTokens: number;
  structured: boolean;
  signal?: AbortSignal;
}

export interface ChatImageResponse {
  text: string;
  usage: Usage;
}

export interface AnalyzeOpts {
  allowedEvents: readonly string[];
  maxOutputTokens: number;
  framesPerCheck?: number;
  signal?: AbortSignal;
  onUsage?: (u: Usage) => void;
}

/** §6.1 contract. `supportsVision` is set only by a passed probe, never assumed. */
export interface VisionProvider {
  readonly id: ProviderId;
  supportsVision: boolean;
  probe(opts?: ProbeOpts): Promise<ProbeResult>;
  analyze(image: Blob, prompt: string, opts: AnalyzeOpts): Promise<DetectionResult>;
}

export interface AdapterConfig {
  id: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  fetchFn: FetchFn;
  /** Anthropic only: send the direct-browser header (C24). True in the extension, false in the backend proxy. */
  directBrowser?: boolean;
}

export abstract class BaseAdapter implements VisionProvider {
  supportsVision = false;
  readonly id: ProviderId;

  constructor(protected readonly cfg: AdapterConfig) {
    this.id = cfg.id;
  }

  /** One image plus text in, model text out. Adapters implement only this. */
  abstract chatImage(req: ChatImageRequest): Promise<ChatImageResponse>;

  async analyze(image: Blob, question: string, opts: AnalyzeOpts): Promise<DetectionResult> {
    const { system, user } = buildPrompt(question, opts.allowedEvents, opts.framesPerCheck ?? 1);
    const mime = image.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = await this.chatImage({
      imageB64: await blobToBase64(image),
      mime,
      system,
      user,
      maxOutputTokens: opts.maxOutputTokens,
      structured: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.onUsage?.(out.usage);
    return parseDetection(out.text, opts.allowedEvents, this.id);
  }

  async probe(opts: ProbeOpts = {}): Promise<ProbeResult> {
    const r = await runProbe(this, opts);
    this.supportsVision = r.supportsVision;
    return r;
  }
}
