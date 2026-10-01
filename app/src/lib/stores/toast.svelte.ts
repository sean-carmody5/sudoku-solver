export interface Toast {
  id: number
  message: string
  kind: 'info' | 'ok' | 'warn'
}

class ToastStore {
  items = $state<Toast[]>([])
  #next = 1

  show(message: string, kind: Toast['kind'] = 'info', ms = 2400): void {
    const id = this.#next++
    this.items = [...this.items, { id, message, kind }]
    setTimeout(() => this.dismiss(id), ms)
  }

  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id)
  }
}

export const toast = new ToastStore()
