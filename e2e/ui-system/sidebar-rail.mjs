// Shared by the browser regression and the evidence capture. Read every row,
// including off-screen/nested rows, rather than sampling the counted room.
export function measureSidebarRail(sidebar) {
  const rect = node => {
    const box = node.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
  }
  const visible = node => getComputedStyle(node).display !== 'none'
    && getComputedStyle(node).visibility !== 'hidden' && node.getBoundingClientRect().width > 0
  const direct = ':scope > [data-slot="sidebar-menu-button"], :scope > div > [data-slot="sidebar-menu-button"]'
  const anchor = sidebar.querySelector('[data-region="session-row"] [data-slot="sidebar-menu-badge"] [data-slot="dot"]')
  if (!anchor) throw new Error('missing session dot rail anchor')
  const rail = rect(anchor).right
  const targetRail = rect(anchor.closest('[data-slot="sidebar-menu-badge"]')).right
  const step = Number.parseFloat(getComputedStyle(sidebar).getPropertyValue('--hd-icon-target'))
  const rows = [...sidebar.querySelectorAll('[data-slot="sidebar-menu-item"]')].flatMap(row => {
    const button = row.querySelector(direct)
    if (!button) return []
    const badges = [...row.querySelectorAll(':scope > [data-slot="sidebar-menu-badge"], :scope > div > [data-slot="sidebar-menu-badge"]')].filter(visible)
    const actions = [...row.querySelectorAll(':scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-action"]')]
      .filter(node => visible(node) && Number(getComputedStyle(node).opacity) === 1)
    const chip = button.querySelector('[data-sidebar-menu-state-full] [data-slot="chip"]')
    const state = button.querySelector('[data-sidebar-menu-state-compact] [data-slot="dot"]')
    const targets = [...badges, ...actions].map(rect)
    const chipBox = chip && visible(chip) ? rect(chip) : null
    const dotBox = state && visible(state) ? rect(state) : null
    if (!targets.length && !chipBox && !dotBox) return []
    let clip = rect(button)
    if (chipBox) {
      for (let parent = chip.parentElement; parent && parent !== button; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const box = rect(parent)
          clip = { left: Math.max(clip.left, box.left), right: Math.min(clip.right, box.right), top: Math.max(clip.top, box.top), bottom: Math.min(clip.bottom, box.bottom) }
        }
      }
    }
    return [{ name: button.getAttribute('aria-label') ?? button.textContent.trim(), chip: chip?.textContent ?? null,
      chipBox, chipRail: rail - badges.length * step, dotBox, clip,
      targetRight: targets.length ? Math.max(...targets.map(box => box.right)) : null,
      nested: Boolean(row.closest('[data-nested="true"]')) }]
  })
  return { rail, targetRail, sidebarRight: rect(sidebar).right, rows }
}
