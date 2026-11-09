// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { base64ToBytes, bytesToBase64 } from '@survey-anything/shared';

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** C4: frames cross extension contexts as base64; analyze() rebuilds the Blob. */
export function base64ToBlob(b64: string, mime: string): Blob {
  const bytes = base64ToBytes(b64);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mime });
}

// ---- Minimal PNG encoder (grayscale, stored deflate) so the probe works in a service worker, a page and Node alike.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    const final = i + len >= raw.length ? 1 : 0;
    blocks.push(final, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255);
    for (let j = 0; j < len; j++) blocks.push(raw[i + j] ?? 0);
  }
  blocks.push(...u32(adler32(raw)));
  return new Uint8Array(blocks);
}

/** Encodes an 8-bit grayscale bitmap (row-major, `width*height` bytes) as PNG. */
export function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 0, 0, 0, 0]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
