import { createRpcClient, type RpcClient } from '../workers/rpc'
import type { Grid, GridSize } from './board'
import type { CountResult, Placement, SolveOptions, SolveResult } from './solve'

let client: RpcClient | null = null

function getClient(): RpcClient {
  if (!client) {
    client = createRpcClient(
      new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' }),
    )
  }
  return client
}

export function solveAsync(grid: Grid, size: GridSize, opts?: SolveOptions): Promise<SolveResult> {
  return getClient().call('solve', [grid, size, opts])
}

export function countSolutionsAsync(
  grid: Grid,
  size: GridSize,
  limit?: number,
): Promise<CountResult> {
  return getClient().call('countSolutions', [grid, size, limit])
}

export function solveOrderAsync(grid: Grid, solution: Grid, size: GridSize): Promise<Placement[]> {
  return getClient().call('solveOrder', [grid, solution, size])
}

/** Kill a runaway solve (pathological 16x16 inputs). A new worker spawns on next call. */
export function cancelSolver(): void {
  client?.terminate()
  client = null
}
