import { charToValue, GRID_SIZES, type Convention, type GridSize } from '../solver/board'
import { cancelSolver, countSolutionsAsync, solveAsync, solveOrderAsync } from '../solver/client'
import type { Placement } from '../solver/solve'
import { findConflicts } from '../solver/validate'
import type { CellFlag } from '../ocr/repair'
import { pickExample } from '../examples'

/** A read from the scanner, handed to the board. */
export interface ScanLoad {
  size: GridSize
  convention: Convention
  values: number[]
  flags: CellFlag[]
  /** The reading has exactly one solution (safe to solve straight away). */
  unique: boolean
  /** Straightened photo of the grid (data URL) for "compare with photo". */
  photo: string
  /** Other puzzles found in the same photo, and which one this is. */
  others: number
  chosen: number
  /** Keep the digits hidden until revealScan() (the photo is landing). */
  hold: boolean
}

/** Pause between the digits settling in and an automatic solve. */
const AUTO_SOLVE_DELAY_MS = 380
/** How long the entrance stagger runs before the class is dropped. */
const ENTER_MS = 900
/** The last cell's entrance, after the cascade's final delay. */
const CASCADE_TAIL_MS = 420

export type BoardStatus = 'editing' | 'solving' | 'animating' | 'solved' | 'error'

/** Total solve-animation duration scales with cell count but stays snappy. */
function animationInterval(placements: number): number {
  if (placements === 0) return 0
  return Math.min(45, Math.max(12, 1100 / placements))
}

const MAX_HISTORY = 100
const STORAGE_KEY = 'sudoku-board-v1'

interface SavedBoard {
  size: GridSize
  convention: Convention
  puzzle: number[]
  source: string | null
}

class BoardStore {
  size = $state<GridSize>(9)
  /** 16x16 symbol convention (hex 0-F or letter 1-G); ignored for other sizes. */
  convention = $state<Convention>('hex')
  status = $state<BoardStatus>('editing')
  /** User-entered givens (0 = empty). */
  puzzle = $state<number[]>(new Array(81).fill(0))
  solution = $state<number[] | null>(null)
  placements = $state<Placement[]>([])
  /** How many placements are currently revealed by the animation. */
  revealedCount = $state(0)
  /** Stagger between placements in the solve cascade (ms). */
  revealInterval = $state(0)
  /** Bumped per cascade, so a replay re-runs every cell's entrance. */
  cascade = $state(0)
  selected = $state(-1)
  errorMessage = $state<string | null>(null)
  multipleSolutions = $state(false)
  /** Set while a slow solve is running so the UI can show progress. */
  solveElapsedMs = $state(0)
  /** Wall-clock time the last solve took, for the stats chip. */
  solveMs = $state(0)
  /** Undo stack of puzzle snapshots (editing only). */
  history = $state<number[][]>([])
  /** Where the puzzle came from, for the stats chip / toasts. */
  source = $state<string | null>(null)
  /** Per-cell reading flags of a scanned puzzle (null: not scanned). */
  scanFlags = $state<CellFlag[] | null>(null)
  /** Straightened photo of the scanned grid, for "compare with photo". */
  scanPhoto = $state<string | null>(null)
  scanUnique = $state(false)
  scanOthers = $state(0)
  scanChosen = $state(0)
  /** Showing the photo over the board (press and hold). */
  comparing = $state(false)
  /** Scanned digits: hidden while the photo lands, then staggering in. */
  entering = $state<'hidden' | 'in' | null>(null)

  /** Scanned cells still worth a look (unclear or corrected reads). */
  /** Scanned cells to point out: while editing every unclear read (a blank
   * read with low confidence may be a missed digit); once solved, only the
   * unclear givens (the rest are the solver's). */
  flagged = $derived.by(() => {
    const out = new Set<number>()
    if (this.scanFlags === null) return out
    const editing = this.status === 'editing'
    this.scanFlags.forEach((f, i) => {
      if (f !== 'ok' && (editing || this.puzzle[i] !== 0)) out.add(i)
    })
    return out
  })
  flaggedCount = $derived(this.flagged.size)

  #exampleIndex = 0

  conflicts = $derived(findConflicts(Uint8Array.from(this.puzzle), this.size))
  givenCount = $derived(this.puzzle.filter((v) => v !== 0).length)
  canSolve = $derived(
    this.status === 'editing' && this.givenCount > 0 && this.conflicts.size === 0,
  )
  canUndo = $derived(this.status === 'editing' && this.history.length > 0)
  guessCount = $derived(this.placements.filter((p) => p.kind === 'guess').length)
  /** Value under the selection (given or revealed), for same-number highlighting. */
  selectedValue = $derived(this.selected === -1 ? 0 : this.displayValue(this.selected))

  /** Placement index per cell, for animation delay/staggering. -1 = given. */
  placementIndex = $derived.by(() => {
    const idx = new Array<number>(this.size * this.size).fill(-1)
    this.placements.forEach((p, i) => {
      idx[p.cell] = i
    })
    return idx
  })

  #enterTimer: ReturnType<typeof setTimeout> | undefined
  #animTimer: ReturnType<typeof setTimeout> | undefined
  #elapsedTimer: ReturnType<typeof setInterval> | undefined
  #saveTimer: ReturnType<typeof setTimeout> | undefined

  /** Remember the entered givens across reloads (debounced). */
  #persist(): void {
    clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => {
      try {
        if (this.givenCount === 0) {
          localStorage.removeItem(STORAGE_KEY)
          return
        }
        const saved: SavedBoard = {
          size: this.size,
          convention: this.convention,
          puzzle: this.puzzle,
          source: this.source,
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
      } catch {
        // Storage unavailable (private mode, quota) - the board still works.
      }
    }, 250)
  }

  /** Restore the last board, if any. Returns true when something was loaded. */
  restore(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return false
      const saved = JSON.parse(raw) as SavedBoard
      if (!GRID_SIZES.includes(saved.size) || saved.puzzle?.length !== saved.size * saved.size) return false
      if (!saved.puzzle.some((v) => v !== 0)) return false
      this.loadPuzzle(saved.size, saved.puzzle, saved.convention === 'letter' ? 'letter' : 'hex', saved.source)
      return true
    } catch {
      return false
    }
  }

  setSize(size: GridSize): void {
    if (size === this.size && this.status === 'editing' && this.givenCount === 0) return
    this.#stopTimers()
    cancelSolver()
    this.size = size
    this.convention = 'hex' // manual entry uses the hex convention
    this.reset()
  }

  reset(): void {
    this.#stopTimers()
    this.puzzle = new Array(this.size * this.size).fill(0)
    this.solution = null
    this.placements = []
    this.revealedCount = 0
    this.selected = -1
    this.status = 'editing'
    this.errorMessage = null
    this.multipleSolutions = false
    this.history = []
    this.source = null
    this.scanFlags = null
    this.scanPhoto = null
    this.scanUnique = false
    this.scanOthers = 0
    this.scanChosen = 0
    this.comparing = false
    this.entering = null
    this.#persist()
  }

  /** Drop the solution but keep the entered givens. */
  clearSolution(): void {
    this.#stopTimers()
    this.solution = null
    this.placements = []
    this.revealedCount = 0
    this.status = 'editing'
    this.errorMessage = null
    this.multipleSolutions = false
  }

  /** Load a recognised or shared puzzle. */
  loadPuzzle(
    size: GridSize,
    values: ArrayLike<number>,
    convention: Convention = 'hex',
    source: string | null = null,
  ): void {
    this.#stopTimers()
    cancelSolver()
    this.size = size
    this.convention = convention
    this.reset()
    this.puzzle = Array.from(values)
    this.source = source
    this.#persist()
  }

  /** Load a scanned puzzle; its digits wait for revealScan() when `hold`. */
  loadScan(s: ScanLoad): void {
    this.loadPuzzle(s.size, s.values, s.convention, 'your photo')
    this.scanFlags = s.flags.slice()
    this.scanPhoto = s.photo
    this.scanUnique = s.unique
    this.scanOthers = s.others
    this.scanChosen = s.chosen
    if (s.hold) this.entering = 'hidden'
    else this.revealScan()
  }

  /** The photo has landed: stagger the digits in, then solve if the read
   * is unambiguous (otherwise the flagged cells wait for a look). */
  revealScan(): void {
    clearTimeout(this.#enterTimer)
    this.entering = 'in'
    this.#enterTimer = setTimeout(() => {
      this.entering = null
    }, ENTER_MS)
    if (this.scanUnique && this.conflicts.size === 0) {
      setTimeout(() => {
        if (this.status === 'editing' && this.scanPhoto !== null) void this.solve()
      }, AUTO_SOLVE_DELAY_MS)
    }
  }

  /** Load a curated example for the current size (cycles on repeat). */
  loadExample(): void {
    const ex = pickExample(this.size, this.#exampleIndex++)
    const values = Array.from(ex.cells, (ch) => (ch === '.' ? 0 : charToValue(ex.size, ch, 'hex')))
    this.loadPuzzle(ex.size, values, 'hex', ex.name)
  }

  select(cell: number): void {
    if (this.status !== 'editing') return
    this.selected = cell
  }

  deselect(): void {
    this.selected = -1
  }

  setCell(cell: number, value: number): void {
    if (this.status !== 'editing' || this.puzzle[cell] === value) return
    this.#snapshot()
    this.puzzle[cell] = value
    // Touching a flagged cell settles it.
    if (this.scanFlags && this.scanFlags[cell] !== 'ok') this.scanFlags[cell] = 'ok'
    this.#persist()
  }

  /** Handle a typed character or keypad press for the selected cell. */
  input(ch: string): void {
    if (this.selected === -1 || this.status !== 'editing') return
    const value = charToValue(this.size, ch, this.convention)
    if (value !== 0) {
      this.setCell(this.selected, value)
      this.moveSelection(0, 1)
    }
  }

  clearSelected(): void {
    if (this.selected === -1 || this.status !== 'editing') return
    this.setCell(this.selected, 0)
  }

  undo(): void {
    if (!this.canUndo) return
    const prev = this.history[this.history.length - 1]
    this.history = this.history.slice(0, -1)
    this.puzzle = prev
    this.#persist()
  }

  #snapshot(): void {
    const next = this.history.length >= MAX_HISTORY ? this.history.slice(1) : this.history.slice()
    next.push(this.puzzle.slice())
    this.history = next
  }

  moveSelection(dRow: number, dCol: number): void {
    if (this.selected === -1) {
      this.selected = 0
      return
    }
    const n = this.size
    let r = Math.floor(this.selected / n) + dRow
    let c = (this.selected % n) + dCol
    if (c >= n) {
      c = 0
      r += 1
    }
    if (c < 0) {
      c = n - 1
      r -= 1
    }
    r = ((r % n) + n) % n
    this.selected = r * n + c
  }

  async solve(): Promise<void> {
    if (!this.canSolve) return
    this.status = 'solving'
    this.errorMessage = null
    this.selected = -1
    this.solveElapsedMs = 0
    const startedAt = performance.now()
    this.#elapsedTimer = setInterval(() => {
      this.solveElapsedMs = performance.now() - startedAt
    }, 100)

    const grid = Uint8Array.from(this.puzzle)
    const size = this.size
    try {
      const result = await solveAsync(grid, size)
      this.solveMs = performance.now() - startedAt
      if (size !== this.size) return // user switched size mid-solve
      if (result.status === 'unsolvable') {
        this.status = 'error'
        this.errorMessage = 'This puzzle has no solution. Check the entered numbers.'
        return
      }
      if (result.status === 'budget-exceeded') {
        this.status = 'error'
        this.errorMessage = 'This puzzle is pathologically hard and the search was stopped.'
        return
      }
      const solution = result.solution!
      const [placements, count] = await Promise.all([
        solveOrderAsync(grid, solution, size),
        countSolutionsAsync(grid, size, 2),
      ])
      if (size !== this.size) return
      this.solution = Array.from(solution)
      this.placements = placements
      this.multipleSolutions = count.count > 1
      this.#animate()
    } catch {
      this.status = 'error'
      this.errorMessage = 'Something went wrong while solving. Please try again.'
    } finally {
      clearInterval(this.#elapsedTimer)
      this.solveElapsedMs = 0
    }
  }

  /** The solve cascade: every placement goes onto the board at once and
   * each cell's entrance is delayed by its order (CSS, on the compositor);
   * one timer marks the end. Stepping it from a JS interval re-rendered and
   * restyled the whole grid on every tick. */
  #animate(): void {
    const total = this.placements.length
    if (total === 0) {
      this.status = 'solved'
      return
    }
    this.revealInterval = animationInterval(total)
    this.revealedCount = total
    this.cascade++
    this.status = 'animating'
    this.#animTimer = setTimeout(() => {
      this.#stopTimers()
      this.status = 'solved'
    }, total * this.revealInterval + CASCADE_TAIL_MS)
  }

  /** Play the cascade again from the start. */
  replay(): void {
    if (this.status !== 'solved' || this.placements.length === 0) return
    this.#stopTimers()
    this.#animate()
  }

  /** Scrub the cascade to a point (solved state only). */
  scrub(count: number): void {
    if (this.status !== 'solved') return
    this.revealedCount = Math.max(0, Math.min(this.placements.length, Math.round(count)))
  }

  /** Skip to the end of the reveal animation. */
  finishAnimation(): void {
    if (this.status !== 'animating') return
    this.#stopTimers()
    this.revealedCount = this.placements.length
    this.status = 'solved'
  }

  /** The value to display in a cell right now (respects animation progress). */
  displayValue(cell: number): number {
    if (this.puzzle[cell] !== 0) return this.puzzle[cell]
    if (this.solution === null) return 0
    const idx = this.placementIndex[cell]
    if (idx === -1 || idx < this.revealedCount) return this.solution[cell]
    return 0
  }

  #stopTimers(): void {
    clearTimeout(this.#animTimer)
    clearInterval(this.#elapsedTimer)
    this.#animTimer = undefined
    this.#elapsedTimer = undefined
  }
}

export const board = new BoardStore()
