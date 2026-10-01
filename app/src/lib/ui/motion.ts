/**
 * Motion presets shared by components: springs matching the CSS --spring-*
 * tokens, and a transition that grows content open so whatever sits below
 * glides down instead of jumping.
 */
import type { TransitionConfig } from 'svelte/transition'
import { spring } from './morph'

export const SMOOTH = spring(0.42, 1)
export const SNAPPY = spring(0.34, 0.82)

const reduced = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Height (and vertical margins/padding) from 0 on a critically damped
 * spring, with the content fading in over the first part. In a flex/grid
 * container the gap before the item is cancelled too (a gap appears whole
 * the moment an item is inserted). */
export function grow(node: HTMLElement): TransitionConfig {
  if (reduced()) return { duration: 0 }
  const parent = node.parentElement ? getComputedStyle(node.parentElement) : null
  const gap = parent && /flex|grid/.test(parent.display) ? parseFloat(parent.rowGap) || 0 : 0
  const style = getComputedStyle(node)
  const height = parseFloat(style.height)
  const pt = parseFloat(style.paddingTop)
  const pb = parseFloat(style.paddingBottom)
  const mt = parseFloat(style.marginTop)
  const mb = parseFloat(style.marginBottom)
  return {
    duration: SMOOTH.ms,
    easing: SMOOTH.ease,
    css: (t) =>
      `overflow: hidden; height: ${t * height}px; padding-top: ${t * pt}px; padding-bottom: ${t * pb}px;` +
      `margin-top: ${(t - 1) * gap + t * mt}px; margin-bottom: ${t * mb}px; opacity: ${Math.min(1, t * 1.6)};`,
  }
}
