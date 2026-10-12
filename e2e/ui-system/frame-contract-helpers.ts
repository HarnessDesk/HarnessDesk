import { applySettingsNavigationActions } from './left-column-actions'
import { applyLeftColumnActions } from './left-column-actions'
import { openWallDestination } from './frame-wall-actions'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { expect, test, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_DESTINATIONS } from './frame-wall-destinations'
import { applyFrameActions } from './frame-actions'
import type { Locator } from '@playwright/test'
import { FRAME_MENU } from '../../packages/ui/src/design/frame'


/**
 * The rendered check (spec, "How it is checked"): the app measured against
 * the frame contract in `packages/ui/src/design/frame.ts`. Each phase of the
 * frame work adds what it moved; nothing here is a literal of its own.
 */
export const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width = 1440) => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.mouse.move(width - 1, 899)
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

/** A token's resolved pixels: a hidden probe takes it as its width. */
export const resolvedPx = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`
  document.body.append(probe)
  const px = probe.getBoundingClientRect().width
  probe.remove()
  return px
}, token)

export const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (color: string) => {
    const encoded = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
    const values = encoded
      ? encoded.slice(1, 4).map(value => Number(value) * 255)
      : color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    if (!values || values.length !== 3) throw new Error(`Cannot read RGB color ${color}`)
    const linear = values.map(value => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export const layoutDestinations = (() => {
  const seen = new Set<string>()
  return WALL_DESTINATIONS.filter(destination => {
    if (destination.surface === 'pattern' || destination.id.startsWith('popup-') || destination.query.includes('popup=')) return false
    if (destination.popup || destination.leftPopup || destination.hover || destination.focus || destination.plan || destination.infoTarget || destination.infoFocus || destination.contextInfo || destination.memberInfo || destination.account || destination.inbox || destination.undo || destination.git || destination.select || destination.composerAdd) return false
    const key = [new URLSearchParams(destination.query).get('frame-wall'), destination.query.includes('layout-registry=1') ? 'layout-registry' : '', destination.tab, destination.viewChoice, destination.tool, destination.holdMessages].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})()

// Task 10 extends this same window contract to the transitional
// AppWindow hosts. The pattern probe deliberately has no application lead.
export const B10_NONWORK = /frame-wall=(?:teams|agents|agent|dashboard|settings(?:-general|-runtimes)?|library|plugins|changes-review)(?:&|$)/
export const D6_NONWORK = /frame-wall=settings-(?:navigation|search)(?:&|$)/
export const B6_WORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => destination.surface !== 'pattern' && !B10_NONWORK.test(destination.query) && !D6_NONWORK.test(destination.query))
export const B10_NONWORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => B10_NONWORK.test(destination.query) || D6_NONWORK.test(destination.query))

export const menuMetrics = async (surface: Locator) => surface.evaluate((el) => {
  const css = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  const clone = el.cloneNode(true) as HTMLElement
  Object.assign(clone.style, { position: 'fixed', visibility: 'hidden', left: '-10000px', top: '0', width: 'max-content', minWidth: '0', maxWidth: 'none', maxHeight: 'none', overflow: 'visible' })
  document.body.append(clone)
  const intrinsic = clone.getBoundingClientRect().width
  clone.remove()
  return { width: box.width, intrinsic, radius: css.borderTopLeftRadius, pad: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], border: css.borderTopWidth, widthMode: el.getAttribute('data-width'), overflow: el.scrollWidth > el.clientWidth || [...el.querySelectorAll<HTMLElement>('[data-menu-label],[data-menu-hint],[data-menu-meter],[data-info-note]')].some(node => node.scrollWidth > node.clientWidth) }
})
export const rowMetrics = async (surface: Locator) => surface.evaluate(surface => [...surface.querySelectorAll('[data-menu-row]')].filter(el => el.closest('[data-popup-kind]') === surface).map(el => {
  const css = getComputedStyle(el)
  const label = el.querySelector('[data-menu-label]')!
  const hint = el.querySelector('[data-menu-hint]')
  const icon = el.querySelector('[data-menu-icon]')
  const meter = el.querySelector('[data-menu-meter]')
  const body = el.querySelector('[data-menu-body]')!
  const trailing = el.querySelector('[data-menu-trailing]')
  return { height: el.getBoundingClientRect().height, radius: css.borderTopLeftRadius, padTop: parseFloat(css.paddingTop), padBottom: parseFloat(css.paddingBottom), left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, labelHeight: label.getBoundingClientRect().height, labelSize: getComputedStyle(label).fontSize, labelLine: getComputedStyle(label).lineHeight, labelWeight: getComputedStyle(label).fontWeight, font: getComputedStyle(label).fontFamily, smoothing: getComputedStyle(label).getPropertyValue('-webkit-font-smoothing'), hintHeight: hint?.getBoundingClientRect().height ?? 0, meterHeight: meter?.getBoundingClientRect().height ?? 0, meterGap: meter ? parseFloat(getComputedStyle(meter).marginTop) : 0, hintSize: hint ? getComputedStyle(hint).fontSize : null, hintLine: hint ? getComputedStyle(hint).lineHeight : null, danger: el.hasAttribute('data-danger'), disabled: el.matches(':is([data-disabled],[aria-disabled="true"],:disabled)'), color: css.color, icon: Boolean(icon), iconLeft: icon?.getBoundingClientRect().left ?? null, iconWidth: icon?.getBoundingClientRect().width ?? 0, gap: parseFloat(css.columnGap), iconTop: icon?.getBoundingClientRect().top ?? 0, labelTop: label.getBoundingClientRect().top, labelLeft: label.getBoundingClientRect().left, bodyLeft: body.getBoundingClientRect().left, bodyRight: body.getBoundingClientRect().right, trailingLeft: trailing?.getBoundingClientRect().left ?? null, trailingRight: trailing?.getBoundingClientRect().right ?? null, trailingWhiteSpace: trailing ? getComputedStyle(trailing).whiteSpace : null }
}))
export const expectMenuPlateGeometry = async (surface: Locator) => {
  const m = await menuMetrics(surface)
  expect(m.width).toBeGreaterThanOrEqual(FRAME_MENU.min)
  expect(m.width).toBeLessThanOrEqual(FRAME_MENU.max)
  expect(m.widthMode).toBeNull()
  expect(m.width).toBeCloseTo(Math.min(FRAME_MENU.max, Math.max(FRAME_MENU.min, m.intrinsic)), 1)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME_MENU.padding}px`))
  expect(m.radius).toBe(`${FRAME_MENU.radius}px`)
  expect(m.border).toBe('0px')
  expect(m.overflow).toBe(false)
}
export const expectMenuGeometry = async (surface: Locator) => {
  await expectMenuPlateGeometry(surface)
  const rows = await rowMetrics(surface)
  expect(rows.length).toBeGreaterThan(0)
  expect(new Set(rows.map(row => row.icon)).size, 'whole-level icon policy').toBe(1)
  const declaredIcons = await surface.getAttribute('data-menu-icons')
  expect(declaredIcons).toBe(rows[0]!.icon ? 'all' : 'none')
  const checkedChoices = surface.locator('[role="menuitemradio"][aria-checked="true"]')
  for (let index = 0; index < await checkedChoices.count(); index += 1) {
    await expect(checkedChoices.nth(index).locator('[data-menu-trailing] svg')).not.toHaveCount(0)
  }
  const uniqueLabels = await surface.locator('[data-menu-row] [data-menu-label]').evaluateAll(nodes => nodes.map(node => node.textContent?.trim().replace(/\s+/g, ' ')).filter(Boolean))
  expect(new Set(uniqueLabels).size, 'menu labels are unique within a menu level').toBe(uniqueLabels.length)
  const dangerInk = await surface.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--hd-danger)'; el.append(probe)
    const color = getComputedStyle(probe).color; probe.remove(); return color
  })
  const disabledInk = await surface.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--hd-disabled-foreground)'; el.append(probe)
    const color = getComputedStyle(probe).color; probe.remove(); return color
  })
  for (const row of rows) {
    const plate = await surface.boundingBox()
    expect(row.left - plate!.x).toBeCloseTo(FRAME_MENU.padding, 2)
    expect(plate!.x + plate!.width - row.right).toBeCloseTo(FRAME_MENU.padding, 2)
    expect(row.radius).toBe(`${FRAME_MENU.rowRadius}px`)
    expect(row.labelSize).toBe(`${FRAME_MENU.labelSize}px`)
    expect(row.labelLine).toBe(`${FRAME_MENU.labelLine}px`)
    expect(row.labelWeight).toBe('400')
    expect(row.font).toContain('Geist')
    expect(row.smoothing).toBe('auto')
    expect(row.labelHeight % FRAME_MENU.labelLine).toBe(0)
    if (row.hintHeight === 0 && row.meterHeight === 0 && row.labelHeight === FRAME_MENU.labelLine) expect(row.height).toBe(FRAME_MENU.rowHeight)
    if (row.hintHeight > 0 || row.meterHeight > 0 || row.labelHeight > FRAME_MENU.labelLine) {
      expect(row.padTop).toBe(FRAME_MENU.earnedPad)
      expect(row.padBottom).toBe(FRAME_MENU.earnedPad)
      expect(row.height).toBe(row.labelHeight + row.hintHeight + row.meterHeight + row.meterGap + 2 * FRAME_MENU.earnedPad)
      if (row.hintHeight > 0) {
        expect(row.hintSize).toBe(`${FRAME_MENU.hintSize}px`)
        expect(row.hintLine).toBe(`${FRAME_MENU.hintLine}px`)
      }
    }
    if (row.icon) {
      expect(row.iconWidth).toBe(FRAME_MENU.icon)
      expect(row.gap).toBe(FRAME_MENU.gap)
      expect(row.iconTop).toBe(row.labelTop)
      expect(row.iconLeft! - plate!.x).toBeCloseTo(FRAME_MENU.contentInset, 2)
    } else expect(row.bodyLeft - plate!.x).toBeCloseTo(FRAME_MENU.contentInset, 2)
    if (!row.icon) expect(row.labelLeft - plate!.x).toBeCloseTo(FRAME_MENU.contentInset, 2)
    if (row.trailingLeft !== null) {
      expect(row.trailingWhiteSpace).toBe('nowrap')
      expect(plate!.x + plate!.width - row.trailingRight!).toBeCloseTo(FRAME_MENU.trailingInset, 2)
      expect(row.trailingLeft - row.bodyRight).toBeGreaterThanOrEqual(FRAME_MENU.gap)
    }
    if (row.danger) {
      expect(row.icon).toBe(true)
      expect(row.color).toBe(row.disabled ? disabledInk : dangerInk)
    }
  }
  await expectMenuAnatomy(surface, rows[0]!.icon)
}
export const expectMenuAnatomy = async (surface: Locator, icons: boolean) => {
  const anatomy = await surface.evaluate(el => {
    const secondary = getComputedStyle(el).getPropertyValue('--hd-secondary-foreground').trim()
    const probe = document.createElement('span'); probe.style.color = secondary; el.append(probe)
    const secondaryColor = getComputedStyle(probe).color; probe.remove()
    const own = (node: Element) => node.closest('[data-popup-kind]') === el
    return {
      groups: [...el.querySelectorAll('[data-menu-group]')].filter(own).map(node => { const css = getComputedStyle(node); return { size: css.fontSize, weight: css.fontWeight, color: css.color, icon: node.querySelector('[data-menu-icon]') !== null } }),
      hints: [...el.querySelectorAll('[data-menu-hint]')].filter(own).map(node => getComputedStyle(node).color),
      separators: [...el.querySelectorAll('[data-menu-separator]')].filter(own).map(node => { const css = getComputedStyle(node); const rect = node.getBoundingClientRect(); const plate = el.getBoundingClientRect(); return { height: rect.height, margins: [css.marginTop, css.marginRight, css.marginBottom, css.marginLeft], left: rect.left - plate.left, right: plate.right - rect.right } }),
      secondaryColor,
    }
  })
  for (const group of anatomy.groups) expect(group).toEqual({ size: `${FRAME_MENU.groupSize}px`, weight: String(FRAME_MENU.groupWeight), color: anatomy.secondaryColor, icon: false })
  const hintInk = await surface.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--hd-secondary-foreground)'; el.append(probe)
    const secondary = getComputedStyle(probe).color; probe.remove()
    const enabled: string[] = []; const refused: string[] = []
    for (const hint of el.querySelectorAll('[data-menu-hint]')) {
      if (hint.closest('[data-popup-kind]') !== el) continue
      (hint.closest('[data-menu-row]:is([data-disabled],[aria-disabled="true"],:disabled)') ? refused : enabled).push(getComputedStyle(hint).color)
    }
    return { secondary, enabled, refused }
  })
  for (const color of hintInk.refused) expect(color).toBe(hintInk.secondary)
  anatomy.hints = hintInk.enabled
  for (const color of anatomy.hints) expect(color).toBe(anatomy.secondaryColor)
  for (const color of hintInk.refused) expect(color).toBe(anatomy.secondaryColor)
  for (const separator of anatomy.separators) expect(separator).toEqual({ height: FRAME_MENU.separator, margins: [`${FRAME_MENU.padding - 2}px`, `${FRAME_MENU.separatorInset}px`, `${FRAME_MENU.padding - 2}px`, `${FRAME_MENU.separatorInset}px`], left: FRAME_MENU.padding + FRAME_MENU.separatorInset, right: FRAME_MENU.padding + FRAME_MENU.separatorInset })
  const edge = await surface.evaluate(el => {
    const box = el.getBoundingClientRect()
    const labels = [...el.querySelectorAll<HTMLElement>('[data-menu-group],[data-menu-note],[data-menu-footer],[data-menu-search]')]
    return labels.filter(n => n.offsetParent !== null && n.closest('[data-popup-kind]') === el).map(n => {
      const css = getComputedStyle(n)
      const rect = n.getBoundingClientRect()
      return {
        left: rect.left + parseFloat(css.paddingLeft) - box.left,
        right: box.right - (rect.right - parseFloat(css.paddingRight)),
      }
    })
  })
  for (const x of edge) {
    expect(x.left).toBeCloseTo(FRAME_MENU.contentInset, 2)
    expect(x.right).toBeCloseTo(FRAME_MENU.contentInset, 2)
  }
}

export const expectMenuReasonAndDestructiveInk = async (surface: Locator) => {
  const problems = await surface.evaluate(el => [...el.querySelectorAll<HTMLElement>('[data-menu-row]')]
    .filter(row => row.closest('[data-popup-kind]') === el)
    .flatMap(row => {
      const disabled = row.matches(':is([data-disabled],[aria-disabled="true"],:disabled)')
      const title = row.getAttribute('title')
      const hint = row.querySelector<HTMLElement>('[data-menu-hint]')
      const failures = disabled && title && (!hint || hint.textContent?.trim() !== title.trim())
        ? [`${row.querySelector('[data-menu-label]')?.textContent?.trim()}: refusal title is not its visible hint`]
        : []
      const destructive = row.hasAttribute('data-danger') || row.getAttribute('data-variant') === 'destructive'
      const icon = row.querySelector<HTMLElement>('[data-menu-icon]')
      const label = row.querySelector<HTMLElement>('[data-menu-label]')
      const trailing = row.querySelector<HTMLElement>('[data-menu-trailing]')
      if (destructive && icon && getComputedStyle(icon).color !== getComputedStyle(row).color) {
        failures.push(`${row.querySelector('[data-menu-label]')?.textContent?.trim()}: destructive icon ink differs from its row`)
      }
      if (disabled) {
        const probe = document.createElement('span')
        probe.style.color = 'var(--hd-disabled-foreground)'
        row.append(probe)
        const disabledInk = getComputedStyle(probe).color
        probe.remove()
        if (getComputedStyle(row).color !== disabledInk) failures.push(`${label?.textContent?.trim()}: refused row does not use disabled ink`)
        for (const slot of [icon, label, trailing]) {
          if (slot && getComputedStyle(slot).color !== disabledInk) failures.push(`${label?.textContent?.trim()}: refused slot does not use disabled ink`)
        }
      }
      return failures
    }))
  expect(problems).toEqual([])
}

export const expectTrailingChildGaps = async (page: Page, surface: Locator) => {
  const gaps = await surface.evaluate(el => [...el.querySelectorAll<HTMLElement>('[data-menu-trailing]')]
    .filter(slot => slot.closest('[data-popup-kind]') === el)
    .flatMap(slot => {
      const boxes = [...slot.childNodes].flatMap(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!node.textContent?.trim()) return []
          const range = document.createRange()
          range.selectNodeContents(node)
          const rect = range.getBoundingClientRect()
          return rect.width > 0 ? [{ left: rect.left, right: rect.right }] : []
        }
        if (!(node instanceof HTMLElement)) return []
        const rect = node.getBoundingClientRect()
        return rect.width > 0 ? [{ left: rect.left, right: rect.right }] : []
      }).sort((a, b) => a.left - b.left)
      return boxes.slice(1).map((box, index) => box.left - boxes[index]!.right)
    }))
  const minimum = await resolvedPx(page, '--hd-space-2')
  expect(gaps.every(gap => gap >= minimum - 1), `trailing child gaps: ${gaps.join(', ')}`).toBe(true)
}

export const expectProjectPathHalvesJoin = async (surface: Locator) => {
  const copy = surface.locator('[data-menu-row]').filter({ hasText: 'Copy path' }).first()
  if (await copy.count() === 0) return
  const gap = await copy.evaluate(row => {
    const head = row.querySelector<HTMLElement>('[data-menu-hint] [data-part="head"]')
    const tail = row.querySelector<HTMLElement>('[data-menu-hint] [data-part="tail"]')
    return head && tail ? tail.getBoundingClientRect().left - head.getBoundingClientRect().right : null
  })
  expect(gap, 'Copy path has both middle-truncate halves').not.toBeNull()
  expect(gap, 'Copy path joins at the truncation without a space').toBeCloseTo(0, 1)
}

export const expectSubmenuChevrons = async (page: Page, surface: Locator) => {
  const arrows = surface.locator('[data-slot="dropdown-menu-sub-trigger"] [data-menu-trailing] svg')
  const size = await resolvedPx(page, '--hd-space-4')
  const colors = new Set<string>()
  for (let index = 0; index < await arrows.count(); index += 1) {
    const arrow = arrows.nth(index)
    const box = (await arrow.boundingBox())!
    expect([box.width, box.height]).toEqual([size, size])
    colors.add(await arrow.evaluate(node => getComputedStyle(node).color))
  }
  expect(colors.size, 'submenu chevrons share one ink in a menu').toBeLessThanOrEqual(1)
}

export const expectInfoGeometry = async (card: Locator) => {
  await expect(card).toBeVisible()
  await expect.poll(async () => (await card.boundingBox())?.width).toBe(FRAME.infoCard.width)
  const m = await menuMetrics(card)
  expect(m.width).toBe(FRAME.infoCard.width)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME.infoCard.padding}px`))
  expect(m.radius).toBe(`${FRAME.menu.radius}px`)
  expect(m.overflow).toBe(false)
  await expect(card.locator('button,a[href],input,select,textarea,[role="button"],[role^="menuitem"],[role="switch"]')).toHaveCount(0)
  const edges = await card.evaluate(el => {
    const x = el.getBoundingClientRect().left
    return [...el.querySelectorAll<HTMLElement>('[data-info-title],[data-info-facts],[data-info-note]')].map(node => node.getBoundingClientRect().left - x)
  })
  for (const x of edges) expect(x).toBe(FRAME.infoCard.padding)
  const keys = await card.locator('[data-info-facts] dt').evaluateAll(keys => keys.map(key => key.getBoundingClientRect().width))
  for (const width of keys) expect(width).toBe(FRAME.summaryKey.infoCard)
}
export const expectRefusedMenuRow = async (row: Locator) => {
  const colors = await row.evaluate(el => {
    const disabledProbe = document.createElement('span'); disabledProbe.style.color = 'var(--hd-disabled-foreground)'; el.append(disabledProbe)
    const disabled = getComputedStyle(disabledProbe).color; disabledProbe.remove()
    const secondaryProbe = document.createElement('span'); secondaryProbe.style.color = 'var(--hd-secondary-foreground)'; el.append(secondaryProbe)
    const secondary = getComputedStyle(secondaryProbe).color; secondaryProbe.remove()
    return {
      disabled,
      secondary,
      tracks: [el, ...el.querySelectorAll('[data-menu-icon],[data-menu-label],[data-menu-trailing]')].map(node => getComputedStyle(node).color),
      reason: el.querySelector('[data-menu-hint]') ? getComputedStyle(el.querySelector('[data-menu-hint]')!).color : null,
    }
  })
  expect(colors.tracks.length).toBe(4)
  for (const color of colors.tracks) expect(color).toBe(colors.disabled)
  if (colors.reason !== null) expect(colors.reason).toBe(colors.secondary)
  const icon = row.locator('[data-menu-icon] svg')
  await expect(icon).toHaveCount(1)
  const box = (await icon.boundingBox())!
  expect([box.width, box.height]).toEqual([16, 16])
  const hint = row.locator('[data-menu-hint]')
  expect(await hint.evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(['12px', '16px'])
}

export const expectDestinationPopupContracts = async (page: Page, destination: typeof WALL_DESTINATIONS[number], theme: 'light' | 'dark', width: number) => test.step(destination.id, async () => {
  await openFrame(page, destination.query, theme, width)
  await applyFrameActions(page, destination)
  await applyLeftColumnActions(page, destination)
  await applySettingsNavigationActions(page, destination)
  await openWallDestination(page, destination)
  const kinds = new Set<string>()
  const rich = page.locator('[data-slot="popover-popup"]:visible,[data-slot="popover-surface"]:visible,[data-slot="dropdown-menu-popup"][data-popup-kind]:visible,[data-slot="dropdown-menu-content"]:visible,[data-slot="dropdown-menu-sub-content"]:visible,[data-slot="hover-card-content"]:visible,[data-slot="select-content"]:visible')
  for (let at = 0; at < await rich.count(); at += 1) {
    const popup = rich.nth(at)
    await expect(popup).not.toHaveAttribute('data-starting-style', '')
    const kind = await popup.getAttribute('data-popup-kind')
    expect(['menu', 'wide-menu', 'info-card']).toContain(kind)
    kinds.add(kind!)
    const expectedIcons = S17_ICON_POLICY[destination.id]
    if (kind !== 'info-card') {
      expect(expectedIcons, `${destination.id} needs a declared menu icon policy`).toBeDefined()
      expect(await popup.getAttribute('data-menu-icons')).toBe(expectedIcons)
    }
    if (kind === 'info-card') {
      await expectInfoGeometry(popup)
      expect(await popup.locator('button,a,input,select,[role="menuitem"],[role="switch"]').count()).toBe(0)
    } else if (destination.id === 'left-inbox') {
      // The sidebar's empty Inbox has facts and a footer, with exactly zero actions.
      await expect(popup).toHaveAttribute('data-popup-kind', 'wide-menu')
      await expect(popup).toHaveAttribute('data-menu-icons', 'none')
      await expect(popup.locator('[data-menu-row]')).toHaveCount(0)
      await expect(popup.locator('[data-menu-note]')).toHaveText('Nothing kept yet. Messages an Agent sends you wait here.')
      await expect(popup.locator('[data-menu-footer]')).toHaveText('Kept until you clear them.')
      await expectMenuPlateGeometry(popup)
      await expectMenuAnatomy(popup, false)
    } else {
      await expectMenuGeometry(popup)
      await expectMenuReasonAndDestructiveInk(popup)
      await expectTrailingChildGaps(page, popup)
      await expectProjectPathHalvesJoin(popup)
      await expectSubmenuChevrons(page, popup)
      if (destination.id === 'popup-composer-add') {
        const contextLabels = ['Current page preview', 'Working tree changes', 'Issue reference', 'Last test run', 'Project notes']
        const marks = await popup.locator('[data-menu-row]').evaluateAll((rows, labels) => rows
          .filter(row => labels.includes(row.querySelector('[data-menu-label]')?.textContent?.trim() ?? ''))
          .map(row => row.querySelector('[data-menu-icon] svg')?.outerHTML), contextLabels)
        expect(marks).toHaveLength(contextLabels.length)
        expect(marks.every(Boolean)).toBe(true)
        expect(new Set(marks).size).toBe(marks.length)
      }
      if (destination.id === 'popup-seat-actions') {
        await expect(popup.locator('[data-menu-row]').filter({ hasText: 'Remove from Team' })).toHaveAttribute('data-danger', '')
      }
    }
  }
  return kinds
})

export const S17_ICON_POLICY: Readonly<Record<string, 'all' | 'none'>> = {
  'popup-composer-model': 'none',
  'popup-topbar-view': 'none',
  'popup-folded-tabs': 'none',
  'popup-dropdown-none': 'none',
  'popup-dropdown-icons': 'all',
  'conversation-seat-usage': 'all',
  'conversation-more-terminal': 'all',
  'left-inbox': 'none',
  'left-account': 'all',
  'left-start': 'all',
  'left-project-menu': 'all',
  'left-session-menu': 'all',
  'popup-menu-icons': 'all',
  'popup-disabled-rows': 'all',
  'popup-select-disabled': 'none',
  'popup-menu-none': 'none',
  'popup-disabled-rows': 'all',
  'popup-composer-add': 'all',
  'popup-conversation-more': 'all',
  'popup-wide-menu': 'none',
  'popup-metered-menu': 'none',
  'popup-plan-usage': 'all',
  'popup-branch-flyout': 'all',
  'popup-branch-context': 'all',
  'popup-account-menu': 'all',
  'popup-other-agents': 'all',
  'popup-info-menu-exclusion': 'all',
  'popup-publication-actions': 'all',
  'popup-subject-actions': 'all',
  'popup-inbox': 'none',
  'popup-inbox-expanded': 'none',
  'popup-suggestions': 'none',
  'popup-select': 'none',
  'popup-seat-actions': 'all',
}

// Small batches keep the normal test timeout without dropping a wall destination.
export const popupContractDestinations = WALL_DESTINATIONS.filter(destination => !destination.gitRef)
