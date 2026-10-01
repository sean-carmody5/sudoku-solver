// CSS linear() easings sampled from damped springs (Apple's response /
// damping-fraction parametrisation), with the settle time each needs as its
// duration. Paste the output into app.css.
// Usage: node scripts/review/springs.mjs
const spring = (response, damping) => {
  const w = (2 * Math.PI) / response
  const x = (t) => {
    if (damping >= 1) return 1 - Math.exp(-w * t) * (1 + w * t)
    const wd = w * Math.sqrt(1 - damping * damping)
    return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t))
  }
  // Settled: stays within 0.1% of the target from here on.
  let settle = 0
  for (let t = 0; t < 5; t += 0.001) if (Math.abs(x(t) - 1) > 0.001) settle = t
  const n = 48
  const pts = []
  for (let i = 0; i <= n; i++) pts.push(+x((i / n) * settle).toFixed(4))
  pts[n] = 1
  return { ms: Math.round(settle * 1000), css: `linear(${pts.join(', ')})`, overshoot: Math.max(...pts) - 1 }
}
for (const [name, r, d] of [
  ['smooth', 0.42, 1],
  ['snappy', 0.34, 0.82],
  ['bouncy', 0.48, 0.66],
]) {
  const s = spring(r, d)
  console.log(`  /* ${name}: response ${r}s, damping ${d}, overshoot ${(s.overshoot * 100).toFixed(1)}% */`)
  console.log(`  --spring-${name}: ${s.css};`)
  console.log(`  --spring-${name}-ms: ${s.ms}ms;`)
}
