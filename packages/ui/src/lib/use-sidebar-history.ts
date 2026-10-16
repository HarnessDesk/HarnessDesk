import { useLayoutEffect, useState } from 'react'

/** Follow the rendered fold, including the native corner and live seam drags. */
export const useSidebarHistory = (shown: boolean, settings: boolean) => {
  const [inMain, setInMain] = useState(false)
  useLayoutEffect(() => {
    const history = shown && !settings ? document.querySelector<HTMLElement>('[data-left-top] [data-left-history]') : null
    if (!history) { setInMain(false); return }
    const measure = () => setInMain(getComputedStyle(history).display === 'none')
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(history.parentElement!)
    return () => observer.disconnect()
  }, [shown, settings])
  return inMain
}
