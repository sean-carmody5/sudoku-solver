/**
 * Live-mode detection worker. Bespoke ping-pong protocol (not rpc.ts): the
 * main thread sends one frame and never sends the next before the reply -
 * natural backpressure. A frame is either an ImageBitmap (cropped and scaled
 * on the GPU by createImageBitmap; its pixels are read here, so the main
 * thread never waits on a GPU readback) or, where workers lack
 * OffscreenCanvas, an RGBA buffer that is transferred back with the reply.
 * The detection itself lives in liveDetect.ts (shared with the Node
 * benchmarks). The worker ALWAYS replies, even on internal errors: a lost
 * reply once left the main thread's busy-flag stuck and killed detection
 * for a whole session.
 */

import { runLiveDetector } from './detectSession'
import { grayFromRgba } from './image'
import { detectLive, type LiveHit, type View } from './liveDetect'

/** A frame, and the part of it that is on screen (the rest is reach). */
export type DetectRequest =
  | { bitmap: ImageBitmap; width: number; height: number; view: View }
  | { buffer: ArrayBuffer; width: number; height: number; view: View }

export interface DetectResponse extends LiveHit {
  /** The RGBA buffer handed back (buffer requests only). */
  buffer?: ArrayBuffer
}

// Kick off wasm + model fetch the moment the camera opens, not on the first
// frame - the first real detection then only pays inference, not download.
void runLiveDetector({ data: new Uint8Array(16 * 16).fill(128), width: 16, height: 16 })

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

function pixels(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height)
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  }
  // A browser that ignored createImageBitmap's resize options hands over the
  // full crop; drawing it scaled covers both cases.
  ctx!.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return ctx!.getImageData(0, 0, width, height).data
}

self.onmessage = async (e: MessageEvent<DetectRequest>) => {
  const req = e.data
  let hit: LiveHit = { corners: null, score: 0, size: 0, edge: false }
  try {
    const rgba = 'bitmap' in req ? pixels(req.bitmap, req.width, req.height) : new Uint8Array(req.buffer)
    hit = await detectLive(grayFromRgba(rgba, req.width, req.height), runLiveDetector, req.view)
  } catch {
    // Fall through - the reply below must go out regardless.
  }
  if ('buffer' in req) {
    const response: DetectResponse = { buffer: req.buffer, ...hit }
    self.postMessage(response, { transfer: [req.buffer] })
  } else {
    self.postMessage(hit satisfies DetectResponse)
  }
}
