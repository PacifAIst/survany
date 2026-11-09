/**
 * WHIP publisher for OME (§4.3 step 4, M5). Non-trickle: gather, POST application/sdp, apply answer.
 * URLs carry `direction=whip&transport=all` so OME offers its TcpRelay (D11). H.264 is preferred
 * because LL-HLS cannot carry VP8.
 */
import { whipRequest } from '../sw/guarded-fetch';
import type { CandidateType } from '../sw/messages';

export function ensureWhipQuery(url: string): string {
  const u = new URL(url);
  u.searchParams.set('direction', 'whip');
  u.searchParams.set('transport', 'all');
  return u.href;
}

function preferH264(transceiver: RTCRtpTransceiver): boolean {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || typeof transceiver.setCodecPreferences !== 'function') return false;
  const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (h264.length === 0) return false;
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
  transceiver.setCodecPreferences([...h264, ...rest]);
  return true;
}

async function waitForIceGathering(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

export class WhipPublisher {
  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;
  h264 = false;

  constructor(private readonly track: MediaStreamTrack) {}

  async start(url: string, iceServers: RTCIceServer[], onState: (s: RTCPeerConnectionState) => void): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.onconnectionstatechange = () => onState(pc.connectionState);
    const tr = pc.addTransceiver(this.track, { direction: 'sendonly' });
    this.h264 = preferH264(tr);
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, 3000);
    const target = ensureWhipQuery(url);
    const res = await whipRequest(target, 'POST', pc.localDescription?.sdp ?? '');
    if (res.status !== 201 && res.status !== 200) throw new Error(`WHIP endpoint answered HTTP ${res.status}`);
    const loc = res.location;
    this.resourceUrl = loc ? new URL(loc, target).href : null;
    await pc.setRemoteDescription({ type: 'answer', sdp: res.body });
  }

  /** Candidate type of the selected pair: never an IP address (M5). */
  async selectedCandidateType(): Promise<CandidateType> {
    const pc = this.pc;
    if (!pc) return 'none';
    const stats = await pc.getStats();
    let localId: string | null = null;
    stats.forEach((r: { type?: string; state?: string; nominated?: boolean; selected?: boolean; localCandidateId?: string }) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected) && r.localCandidateId) localId = r.localCandidateId;
    });
    if (!localId) return 'none';
    const local = stats.get(localId) as { candidateType?: string; protocol?: string; relayProtocol?: string } | undefined;
    if (!local) return 'none';
    if (local.candidateType === 'relay') return 'relay';
    return local.protocol === 'tcp' ? 'tcp' : 'udp';
  }

  async stop(): Promise<void> {
    const url = this.resourceUrl;
    this.resourceUrl = null;
    this.pc?.close();
    this.pc = null;
    if (url) await whipRequest(url, 'DELETE', '').catch(() => undefined);
  }
}

/** Synthetic black canvas track for the arm-time reachability probe: never captured pixels, so not a stream under SG-13. */
export function blackProbeTrack(): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  const paint = (): void => {
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  const interval = setInterval(paint, 200);
  const stream = canvas.captureStream(5);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('canvas captureStream produced no track');
  return {
    track,
    stop: () => {
      clearInterval(interval);
      track.stop();
    },
  };
}
