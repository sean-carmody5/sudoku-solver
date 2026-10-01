import { getTables, type Grid, type GridSize } from './board'

/**
 * Cells that conflict with another cell in the same unit (same value twice).
 * Empty result means the givens are consistent (not necessarily solvable).
 */
export function findConflicts(grid: Grid, size: GridSize): Set<number> {
  const t = getTables(size)
  const conflicts = new Set<number>()
  const seen = new Int16Array(size + 1)

  for (const unit of t.units) {
    seen.fill(-1)
    for (const c of unit) {
      const v = grid[c]
      if (v === 0) continue
      if (seen[v] !== -1) {
        conflicts.add(seen[v])
        conflicts.add(c)
      } else {
        seen[v] = c
      }
    }
  }
  return conflicts
}

/** True if `solution` is a complete, valid grid consistent with `givens`. */
export function isValidSolution(givens: Grid, solution: Grid, size: GridSize): boolean {
  if (solution.length !== size * size) return false
  for (let c = 0; c < solution.length; c++) {
    if (solution[c] < 1 || solution[c] > size) return false
    if (givens[c] !== 0 && givens[c] !== solution[c]) return false
  }
  return findConflicts(solution, size).size === 0
}
