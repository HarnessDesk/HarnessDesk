import { useLayoutEffect, useState } from 'react'

/** Choose a container's layout before painting; children wait for its first measurement. */
export const useNarrowLayout = <T extends HTMLElement>(breakpoint: number) => {
  const [box, ref] = useState<T | null>(null)
  const [narrow, setNarrow] = useState<boolean | null>(null)
  useLayoutEffect(() => {
    if (!box) return
    setNarrow(box.getBoundingClientRect().width < breakpoint)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === box)
      if (entry) setNarrow(entry.contentRect.width < breakpoint)
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [box, breakpoint])
  return { ref, narrow }
}
