export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'sudoku-theme'

/** Light unless the visitor has chosen dark with the toggle. */
function initialTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

class ThemeStore {
  current = $state<Theme>(initialTheme())

  constructor() {
    $effect.root(() => {
      $effect(() => {
        document.documentElement.dataset.theme = this.current
      })
    })
  }

  /** Switch themes as one cross-fade of the whole page (a View Transition:
   * two snapshots blended on the compositor) rather than every colour on
   * the page transitioning on the main thread. Where View Transitions are
   * missing the switch is instant. */
  toggle(): void {
    const next: Theme = this.current === 'dark' ? 'light' : 'dark'
    const root = document.documentElement
    const apply = (): void => {
      root.dataset.theme = next
      this.current = next
    }
    root.classList.add('theme-swap')
    const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (doc.startViewTransition && !reduced) {
      doc
        .startViewTransition(apply)
        .finished.catch(() => undefined)
        .finally(() => root.classList.remove('theme-swap'))
    } else {
      apply()
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')))
    }
    try {
      localStorage.setItem(STORAGE_KEY, this.current)
    } catch {
      // Storage unavailable: the choice lasts for this visit.
    }
  }
}

export const theme = new ThemeStore()
