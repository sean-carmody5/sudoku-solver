/**
 * Lazy ONNX sessions for the grid-detector models. Shares the wasm runtime
 * with the OCR session (same onnxruntime-web/wasm module, single-threaded).
 * All failures resolve to null so callers can fall back to classical
 * detection - the model is an upgrade, never a dependency.
 */

import { DET_CHANNELS, DET_GRID, DET_IN, decodeDetections, letterbox, type NetDetection } from './detectNet'
import type { GrayImage } from './image'

const version = (key: 'detect' | 'detectLive'): string =>
  typeof __MODEL_VERSIONS__ === 'undefined' ? 'dev' : __MODEL_VERSIONS__[key]

/** Still reads (uploads and captures). */
export const DETECT_MODEL_URL = `${import.meta.env.BASE_URL}models/detect-v1.onnx?v=${version('detect')}`
/** The live camera: the same network fine-tuned further on app and web
 * screenshots. It locks onto more screens and far fewer wrong grids, but
 * boxes printed pages worse, so still reads keep the other. */
export const LIVE_MODEL_URL = `${import.meta.env.BASE_URL}models/detect-live.onnx?v=${version('detectLive')}`

type Ort = typeof import('onnxruntime-web')

let ortPromise: Promise<Ort> | null = null
const sessions = new Map<string, Promise<import('onnxruntime-web').InferenceSession>>()

async function loadOrt(): Promise<Ort> {
  ortPromise ??= import('onnxruntime-web/wasm').then((ort) => {
    ort.env.wasm.numThreads = 1
    return ort as unknown as Ort
  })
  return ortPromise
}

function loadSession(url: string): Promise<import('onnxruntime-web').InferenceSession> {
  let session = sessions.get(url)
  if (!session) {
    session = loadOrt().then((ort) => ort.InferenceSession.create(url, { executionProviders: ['wasm'] }))
    sessions.set(url, session)
  }
  return session
}

/**
 * Run a detector on a grayscale frame. Returns detections in frame pixels,
 * best first, or null if the model can't load/run (caller falls back).
 */
async function detect(url: string, gray: GrayImage, maxDets: number, thresh: number): Promise<NetDetection[] | null> {
  try {
    const ort = await loadOrt()
    const session = await loadSession(url)
    const box = letterbox(gray)
    const input = new ort.Tensor('float32', box.input, [1, 1, DET_IN, DET_IN])
    const output = await session.run({ frame: input })
    const map = output.map.data as Float32Array
    if (map.length !== DET_CHANNELS * DET_GRID * DET_GRID) return null
    return decodeDetections(map, box, maxDets, thresh)
  } catch {
    return null
  }
}

export const runDetector = (gray: GrayImage, maxDets = 3, thresh = 0.35): Promise<NetDetection[] | null> =>
  detect(DETECT_MODEL_URL, gray, maxDets, thresh)

export const runLiveDetector = (gray: GrayImage, maxDets = 3, thresh = 0.35): Promise<NetDetection[] | null> =>
  detect(LIVE_MODEL_URL, gray, maxDets, thresh)
