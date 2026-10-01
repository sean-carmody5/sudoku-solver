/** Minimal promise-based RPC over postMessage, used by all workers. A handler
 * can stream progress notes back to the caller while it runs. */

interface RpcRequest {
  id: number
  method: string
  args: unknown[]
}

interface RpcResponse {
  id: number
  result?: unknown
  error?: string
}

interface RpcProgress {
  id: number
  progress: string
}

/** Passed to every handler as its final argument. */
export interface RpcContext {
  /** Report a stage name to the caller (fire-and-forget). */
  progress(stage: string): void
}

export interface RpcClient {
  /** Rejects with `RpcTimeoutError` after `timeoutMs` (if given): a worker
   * the browser killed for memory (iOS does this silently) never replies. */
  call<T>(
    method: string,
    args: unknown[],
    transfer?: Transferable[],
    onProgress?: (stage: string) => void,
    timeoutMs?: number,
  ): Promise<T>
  terminate(): void
}

export class RpcTimeoutError extends Error {
  constructor(method: string) {
    super(`${method} timed out`)
    this.name = 'RpcTimeoutError'
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (stage: string) => void
}

export function createRpcClient(worker: Worker): RpcClient {
  let nextId = 1
  const pending = new Map<number, Pending>()

  worker.onmessage = (e: MessageEvent<RpcResponse | RpcProgress>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    if ('progress' in e.data) {
      p.onProgress?.(e.data.progress)
      return
    }
    pending.delete(e.data.id)
    if (e.data.error !== undefined) p.reject(new Error(e.data.error))
    else p.resolve(e.data.result)
  }
  const failAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  worker.onerror = (e) => failAll(new Error(e.message || 'worker error'))
  worker.onmessageerror = () => failAll(new Error('worker message could not be decoded'))

  return {
    call<T>(
      method: string,
      args: unknown[],
      transfer?: Transferable[],
      onProgress?: (stage: string) => void,
      timeoutMs?: number,
    ): Promise<T> {
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (): void => clearTimeout(timer)
        pending.set(id, {
          resolve: (v) => {
            done()
            resolve(v as T)
          },
          reject: (e) => {
            done()
            reject(e)
          },
          onProgress,
        })
        if (timeoutMs) {
          timer = setTimeout(() => {
            if (!pending.delete(id)) return
            reject(new RpcTimeoutError(method))
          }, timeoutMs)
        }
        const msg: RpcRequest = { id, method, args }
        try {
          worker.postMessage(msg, transfer ?? [])
        } catch (err) {
          pending.delete(id)
          done()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    terminate() {
      const err = new Error('worker terminated')
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      worker.terminate()
    },
  }
}

type Handler = (...args: never[]) => unknown

const transfers = new WeakMap<object, Transferable[]>()

/** Mark a handler's result so these objects (bitmaps, buffers) are moved to
 * the caller rather than copied. */
export function transferring<T extends object>(value: T, list: Transferable[]): T {
  transfers.set(value, list)
  return value
}

/** Call inside a worker to serve a set of methods. */
export function serveRpc(handlers: Record<string, Handler>): void {
  self.onmessage = async (e: MessageEvent<RpcRequest>) => {
    const { id, method, args } = e.data
    const response: RpcResponse = { id }
    const ctx: RpcContext = {
      progress(stage) {
        const note: RpcProgress = { id, progress: stage }
        self.postMessage(note)
      },
    }
    try {
      const handler = handlers[method]
      if (!handler) throw new Error(`unknown method: ${method}`)
      response.result = await handler(...(args as never[]), ctx as never)
    } catch (err) {
      response.error = err instanceof Error ? err.message : String(err)
    }
    const moved = response.result && typeof response.result === 'object' ? transfers.get(response.result) : undefined
    self.postMessage(response, { transfer: moved ?? [] })
  }
}
