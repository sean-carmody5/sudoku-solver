import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// iOS Safari only applies :active (every press state here) to touches when
// the page listens for them.
document.addEventListener('touchstart', () => {}, { passive: true })

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
