import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

export const moveSettingsNavigationFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
  const target = event.target
  if (!(target instanceof HTMLButtonElement) || target.dataset.sidebar !== 'menu-button') return
  if (event.key === 'Enter' || event.key === ' ') {
    if (event.repeat) return
    event.preventDefault()
    target.click()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]:not(:disabled)')]
  const index = rows.indexOf(target)
  if (index < 0 || rows.length < 2) return
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? rows.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
  event.preventDefault()
  rows[next]?.focus()
}
