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
  const project = sidebar.querySelector('[data-draggable]')?.closest('[data-slot="sidebar-menu-item"]')
  const anchor = [...(project?.querySelectorAll(':scope > [data-slot="sidebar-menu-action"]') ?? [])].at(-1)
  if (!anchor) throw new Error('missing top-level project rail anchor')
  const targetRail = rect(anchor).right
  const css = getComputedStyle(sidebar)
  const step = Number.parseFloat(css.getPropertyValue('--hd-icon-target'))
  const dotWidth = Number.parseFloat(css.getPropertyValue('--hd-space-2')) - Number.parseFloat(css.getPropertyValue('--hd-space-px'))
  const rail = targetRail - (step - dotWidth) / 2
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
    const words = chip?.querySelector('[data-slot="chip-words"]')
    const textRange = document.createRange()
    if (words) textRange.selectNodeContents(words)
    const textBox = chipBox && words ? rect(textRange) : null
    const chipStyle = chipBox ? getComputedStyle(chip) : null
    const title = button.querySelector('[data-slot="sidebar-menu-label-content"] > span > span:first-child')
    const titleBox = title ? rect(title) : null
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
      chipBox, textBox, chipRail: rail - badges.length * step, dotBox, clip,
      titleBox,
      chipStyle: chipStyle && { background: chipStyle.backgroundColor, border: chipStyle.borderWidth,
        shadow: chipStyle.boxShadow, paddingLeft: chipStyle.paddingLeft, paddingRight: chipStyle.paddingRight },
      targetRight: targets.length ? Math.max(...targets.map(box => box.right)) : null,
      nested: Boolean(row.closest('[data-nested="true"]')) }]
  })
  return { rail, targetRail, sidebarRight: rect(sidebar).right, rows }
}
