import { serveRpc } from '../workers/rpc'
import type { Grid, GridSize } from './board'
import { countSolutions, solve, solveOrder, type SolveOptions } from './solve'

serveRpc({
  solve: (grid: Grid, size: GridSize, opts?: SolveOptions) => solve(grid, size, opts),
  countSolutions: (grid: Grid, size: GridSize, limit?: number) =>
    countSolutions(grid, size, limit),
  solveOrder: (grid: Grid, solution: Grid, size: GridSize) => solveOrder(grid, solution, size),
})
