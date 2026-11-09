/**
 * C11: a ring of MediaRecorder chunks is not independently playable, so two recorders run
 * staggered by half a segment and each restarts every `seconds`. One complete, playable file
 * of `seconds` length always exists, ending at most seconds/2 ago.
 * MP4 when the browser can encode it, otherwise WebM (sent via sendDocument).
 */
import { bytesToBase64 } from '@survey-anything/shared';
import type { ClipPayload, ClipSetup } from '../sw/messages';

export const MIME_PREFERENCE = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function pickMime(isSupported: (m: string) => boolean): string {
  return MIME_PREFERENCE.find((m) => isSupported(m)) ?? 'video/webm';
}

interface Lane {
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ClipRecorders {
  private readonly lanes: Lane[] = [
    { recorder: null, chunks: [], startedAt: 0, timer: null },
    { recorder: null, chunks: [], startedAt: 0, timer: null },
  ];
  private latest: { blob: Blob; durationMs: number; endedAt: number } | null = null;
  private stagger: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  readonly mime: string;

  constructor(
    private readonly stream: MediaStream,
    private readonly setup: ClipSetup,
  ) {
    this.mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
  }

  start(): void {
    this.stopped = false;
    this.runLane(0);
    this.stagger = setTimeout(() => this.runLane(1), (this.setup.seconds * 1000) / 2);
  }

  private runLane(i: number): void {
    if (this.stopped) return;
    const lane = this.lanes[i];
    if (!lane) return;
    const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: this.setup.videoBitsPerSecond });
    lane.recorder = rec;
    lane.chunks = [];
    lane.startedAt = Date.now();
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) lane.chunks.push(e.data);
    };
    rec.onstop = () => {
      const durationMs = Date.now() - lane.startedAt;
      if (lane.chunks.length > 0 && durationMs >= this.setup.seconds * 1000 * 0.9) {
        this.latest = { blob: new Blob(lane.chunks, { type: this.mime.split(';')[0] }), durationMs, endedAt: Date.now() };
      }
      lane.chunks = [];
      if (!this.stopped) this.runLane(i);
    };
    rec.start();
    lane.timer = setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, this.setup.seconds * 1000);
  }

  async latestClip(): Promise<ClipPayload | null> {
    if (!this.latest) return null;
    const bytes = new Uint8Array(await this.latest.blob.arrayBuffer());
    return { mime: this.latest.blob.type, b64: bytesToBase64(bytes), durationMs: this.latest.durationMs };
  }

  stop(): void {
    this.stopped = true;
    if (this.stagger) clearTimeout(this.stagger);
    for (const lane of this.lanes) {
      if (lane.timer) clearTimeout(lane.timer);
      if (lane.recorder && lane.recorder.state !== 'inactive') lane.recorder.stop();
    }
  }
}
