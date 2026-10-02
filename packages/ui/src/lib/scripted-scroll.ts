/** Respect the reader's motion preference for scrolls started by the interface. */
export const scriptedScrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
