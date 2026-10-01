/**
 * Lazy ONNX Runtime Web session. Loaded only when the user first scans;
 * single-threaded SIMD wasm so no COOP/COEP headers are needed (they would
 * break third-party ad iframes).
 */

import { TENSOR_SIZE } from '../cv/cells'
import { NUM_CLASSES } from './classes'
import type { LogitsRunner } from './classify'

export const MODEL_URL = `${import.meta.env.BASE_URL}models/cnn-v1.onnx?v=${typeof __MODEL_VERSIONS__ === 'undefined' ? 'dev' : __MODEL_VERSIONS__.cnn}`

type Ort = typeof import('onnxruntime-web')

let ortPromise: Promise<Ort> | null = null
let sessionPromise: Promise<import('onnxruntime-web').InferenceSession> | null = null

async function loadOrt(): Promise<Ort> {
  // The /wasm entry ships only the CPU wasm EP (no WebGPU/JSEP), keeping the
  // lazily-fetched binary a fraction of the full build's size.
  ortPromise ??= import('onnxruntime-web/wasm').then((ort) => {
    ort.env.wasm.numThreads = 1
    return ort as unknown as Ort
  })
  return ortPromise
}

export async function loadSession(): Promise<import('onnxruntime-web').InferenceSession> {
  sessionPromise ??= (async () => {
    const ort = await loadOrt()
    return ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    })
  })()
  return sessionPromise
}

/** LogitsRunner backed by the browser wasm session. */
export async function browserRunner(): Promise<LogitsRunner> {
  const ort = await loadOrt()
  const session = await loadSession()
  return async (batch: Float32Array, count: number) => {
    const input = new ort.Tensor('float32', batch, [count, 1, TENSOR_SIZE, TENSOR_SIZE])
    const output = await session.run({ cells: input })
    const logits = output.logits.data as Float32Array
    if (logits.length !== count * NUM_CLASSES) throw new Error('unexpected logits shape')
    return logits
  }
}
