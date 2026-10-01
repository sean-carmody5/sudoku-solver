import type { BinaryImage, Point } from './image'

export interface Component {
  label: number
  size: number
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Labelling {
  labels: Int32Array
  components: Component[]
}

/** 8-connected component labelling via an explicit-stack flood fill. */
export function labelComponents(mask: BinaryImage): Labelling {
  const { width: w, height: h, data } = mask
  const labels = new Int32Array(w * h)
  const components: Component[] = []
  const stack = new Int32Array(w * h)

  let next = 0
  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || labels[start] !== 0) continue
    const label = ++next
    let size = 0
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    let top = 0
    stack[top++] = start
    labels[start] = label
    while (top > 0) {
      const idx = stack[--top]
      const y = (idx / w) | 0
      const x = idx - y * w
      size++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        const row = ny * w
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const nIdx = row + nx
          if (data[nIdx] !== 0 && labels[nIdx] === 0) {
            labels[nIdx] = label
            stack[top++] = nIdx
          }
        }
      }
    }
    components.push({ label, size, x0, y0, x1, y1 })
  }
  return { labels, components }
}

// Moore neighbourhood in clockwise order starting east.
const MOORE_DX = [1, 1, 0, -1, -1, -1, 0, 1]
const MOORE_DY = [0, 1, 1, 1, 0, -1, -1, -1]

/**
 * Trace the outer boundary of a labelled component (Moore tracing with
 * Jacob's stopping criterion). Returns the ordered contour.
 */
export function traceBoundary(labels: Int32Array, width: number, height: number, comp: Component): Point[] {
  // Start pixel: leftmost pixel of the topmost row of the component.
  let start = -1
  outer: for (let y = comp.y0; y <= comp.y1; y++) {
    for (let x = comp.x0; x <= comp.x1; x++) {
      if (labels[y * width + x] === comp.label) {
        start = y * width + x
        break outer
      }
    }
  }
  if (start === -1) return []

  const sx = start % width
  const sy = (start / width) | 0
  const contour: Point[] = [{ x: sx, y: sy }]

  const inside = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && labels[y * width + x] === comp.label

  let cx = sx
  let cy = sy
  // Backtrack direction: we entered the start pixel from the west.
  let dir = 6 // pointing north for first scan start (west neighbour is background by construction)
  let firstDir = -1

  for (let steps = 0; steps < width * height * 4; steps++) {
    let found = -1
    // Scan clockwise from the backtrack direction.
    for (let i = 0; i < 8; i++) {
      const d = (dir + i) % 8
      const nx = cx + MOORE_DX[d]
      const ny = cy + MOORE_DY[d]
      if (inside(nx, ny)) {
        found = d
        break
      }
    }
    if (found === -1) break // isolated pixel

    const nx = cx + MOORE_DX[found]
    const ny = cy + MOORE_DY[found]

    if (nx === sx && ny === sy && firstDir !== -1 && found === firstDir) break // Jacob's criterion
    if (firstDir === -1) firstDir = found

    contour.push({ x: nx, y: ny })
    // New backtrack: opposite of arrival direction, advanced by one.
    dir = (found + 6) % 8
    cx = nx
    cy = ny
    if (contour.length > 1 && cx === sx && cy === sy) {
      // Returned to start; drop the duplicate point.
      contour.pop()
      break
    }
  }
  return contour
}
