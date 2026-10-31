import { expect, type Locator, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

/**
 * Capture once, check many (docs/decisions.md, 2026-10-31): a popup's layout
 * read in one pass, so `frame-contract-popup-rules.ts` can hold the C10 popup
 * contracts as pure functions over it. Everything a rule measures is a field
 * here, read the way the rule used to read it from the live page.
 *
 * Geometry does not depend on the theme, ink does. A destination is rendered
 * once, light, and read twice: as it loads, and again after its theme is
 * switched in place (`readInBothThemes`), so the ink rules hold in both
 * themes without a second render.
 */

export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** A menu row the popup owns (its nearest `[data-popup-kind]` is the popup). */
export interface OwnRow {
  readonly height: number; readonly radius: string; readonly padTop: number; readonly padBottom: number
  readonly left: number; readonly right: number
  readonly labelHeight: number; readonly labelSize: string; readonly labelLine: string; readonly labelWeight: string
  readonly font: string; readonly smoothing: string
  readonly hintHeight: number; readonly meterHeight: number; readonly meterGap: number
  readonly hintSize: string | null; readonly hintLine: string | null
  readonly danger: boolean; readonly disabled: boolean; readonly color: string
  readonly icon: boolean; readonly iconLeft: number | null; readonly iconWidth: number; readonly gap: number
  readonly iconTop: number; readonly labelTop: number; readonly labelLeft: number
  readonly bodyLeft: number; readonly bodyRight: number
  readonly trailingLeft: number | null; readonly trailingRight: number | null; readonly trailingWhiteSpace: string | null
  // The refusal and destructive-ink rule's reading of the same row.
  readonly label: string | undefined; readonly title: string | null; readonly hint: string | null
  readonly destructive: boolean; readonly disabledInk: string
  readonly iconColor: string | null; readonly labelColor: string | null; readonly trailingColor: string | null
}

/** Any menu row inside the popup, its own or a nested level's. */
export interface AnyRow {
  readonly text: string; readonly label: string; readonly danger: boolean; readonly mark: string | null
  readonly copyPathGap: number | null | 'absent'
}

export interface PopupFacts {
  readonly kind: string | null
  readonly menuIcons: string | null
  readonly startingStyle: boolean
  readonly box: Box
  readonly plate: {
    readonly width: number; readonly intrinsic: number; readonly tabular: boolean; readonly radius: string
    readonly pad: readonly string[]; readonly border: string; readonly widthMode: string | null; readonly overflow: boolean
  }
  readonly rows: readonly OwnRow[]
  readonly allRows: readonly AnyRow[]
  readonly labels: readonly string[]
  readonly checkedChoiceMarks: readonly number[]
  readonly inks: { readonly danger: string; readonly disabled: string; readonly anatomySecondary: string; readonly secondary: string }
  readonly groups: readonly { readonly size: string; readonly weight: string; readonly color: string; readonly icon: boolean }[]
  readonly hints: { readonly enabled: readonly string[]; readonly refused: readonly string[] }
  readonly separators: readonly { readonly height: number; readonly margins: readonly string[]; readonly left: number; readonly right: number }[]
  readonly edges: readonly { readonly left: number; readonly right: number }[]
  readonly trailingGaps: readonly number[]
  readonly chevrons: readonly { readonly width: number; readonly height: number; readonly color: string }[]
  readonly interactive: number
  readonly anyControl: number
  readonly infoEdges: readonly number[]
  readonly infoKeys: readonly number[]
  readonly notes: readonly string[]
  readonly footers: readonly string[]
}

export interface PopupTokens {
  readonly space2: number; readonly space4: number; readonly buttonHeightSm: number; readonly targetMin: number; readonly buttonTextSm: number
}

export interface SelectionAction {
  readonly count: number; readonly visible: boolean; readonly enabled: boolean
  readonly slot: string | null; readonly variant: string | null; readonly box: Box | null
  readonly fontSize: number; readonly ownsTarget: boolean
}

/** One destination's popups at one width, in one theme. */
export interface PopupThemeReading {
  readonly theme: 'light' | 'dark'
  readonly tokens: PopupTokens
  readonly popups: readonly PopupFacts[]
  readonly selectionActions: readonly (SelectionAction | null)[]
}

export interface PopupSnapshot {
  readonly destination: string
  readonly width: number
  readonly readings: readonly PopupThemeReading[]
}

/**
 * The read itself, run in the page. It has to be self-contained: Playwright
 * sends its source, not its closure.
 */
export const readPopupFacts = (popups: Element[]): { tokens: PopupTokens; popups: PopupFacts[] } => {
  const px = (token: string) => {
    const probe = document.createElement('div')
    probe.style.cssText = `position:absolute;visibility:hidden;width:var(${token})`
    document.body.append(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return width
  }
  const ink = (host: Element, value: string) => {
    const probe = document.createElement('span'); probe.style.color = value; host.append(probe)
    const color = getComputedStyle(probe).color; probe.remove(); return color
  }
  const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const refused = ':is([data-disabled],[aria-disabled="true"],:disabled)'
  const read = (el: Element): PopupFacts => {
    const own = (node: Element) => node.closest('[data-popup-kind]') === el
    const css = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const clone = el.cloneNode(true) as HTMLElement
    Object.assign(clone.style, { position: 'fixed', visibility: 'hidden', left: '-10000px', top: '0', width: 'max-content', minWidth: '0', maxWidth: 'none', maxHeight: 'none', overflow: 'visible' })
    document.body.append(clone)
    const intrinsic = clone.getBoundingClientRect().width
    clone.remove()
    const plate = {
      width: box.width, intrinsic,
      tabular: [...el.querySelectorAll('[data-menu-facts]')].some(facts => facts.closest('[data-popup-kind]') === el),
      radius: css.borderTopLeftRadius, pad: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft], border: css.borderTopWidth,
      widthMode: el.getAttribute('data-width'),
      overflow: el.scrollWidth > el.clientWidth || [...el.querySelectorAll<HTMLElement>('[data-menu-label],[data-menu-hint],[data-menu-meter],[data-info-note]')].some(node => node.scrollWidth > node.clientWidth),
    }
    const rows = [...el.querySelectorAll<HTMLElement>('[data-menu-row]')].filter(own).map(row => {
      const style = getComputedStyle(row)
      const rect = row.getBoundingClientRect()
      const label = row.querySelector('[data-menu-label]')!
      const hint = row.querySelector('[data-menu-hint]')
      const icon = row.querySelector('[data-menu-icon]')
      const meter = row.querySelector('[data-menu-meter]')
      const body = row.querySelector('[data-menu-body]')!
      const trailing = row.querySelector('[data-menu-trailing]')
      const labelStyle = getComputedStyle(label)
      return {
        height: rect.height, radius: style.borderTopLeftRadius, padTop: parseFloat(style.paddingTop), padBottom: parseFloat(style.paddingBottom),
        left: rect.left, right: rect.right,
        labelHeight: label.getBoundingClientRect().height, labelSize: labelStyle.fontSize, labelLine: labelStyle.lineHeight, labelWeight: labelStyle.fontWeight,
        font: labelStyle.fontFamily, smoothing: labelStyle.getPropertyValue('-webkit-font-smoothing'),
        hintHeight: hint?.getBoundingClientRect().height ?? 0, meterHeight: meter?.getBoundingClientRect().height ?? 0,
        meterGap: meter ? parseFloat(getComputedStyle(meter).marginTop) : 0,
        hintSize: hint ? getComputedStyle(hint).fontSize : null, hintLine: hint ? getComputedStyle(hint).lineHeight : null,
        danger: row.hasAttribute('data-danger'), disabled: row.matches(refused), color: style.color,
        icon: Boolean(icon), iconLeft: icon?.getBoundingClientRect().left ?? null, iconWidth: icon?.getBoundingClientRect().width ?? 0,
        gap: parseFloat(style.columnGap), iconTop: icon?.getBoundingClientRect().top ?? 0,
        labelTop: label.getBoundingClientRect().top, labelLeft: label.getBoundingClientRect().left,
        bodyLeft: body.getBoundingClientRect().left, bodyRight: body.getBoundingClientRect().right,
        trailingLeft: trailing?.getBoundingClientRect().left ?? null, trailingRight: trailing?.getBoundingClientRect().right ?? null,
        trailingWhiteSpace: trailing ? getComputedStyle(trailing).whiteSpace : null,
        label: label.textContent?.trim(), title: row.getAttribute('title'), hint: hint ? hint.textContent ?? '' : null,
        destructive: row.hasAttribute('data-danger') || row.getAttribute('data-variant') === 'destructive',
        disabledInk: ink(row, 'var(--hd-disabled-foreground)'),
        iconColor: icon ? getComputedStyle(icon).color : null, labelColor: labelStyle.color,
        trailingColor: trailing ? getComputedStyle(trailing).color : null,
      }
    })
    const allRows = [...el.querySelectorAll<HTMLElement>('[data-menu-row]')].map(row => {
      const head = row.querySelector<HTMLElement>('[data-menu-hint] [data-part="head"]')
      const tail = row.querySelector<HTMLElement>('[data-menu-hint] [data-part="tail"]')
      const words = text(row)
      return {
        text: words, label: row.querySelector('[data-menu-label]')?.textContent?.trim() ?? '', danger: row.hasAttribute('data-danger'),
        mark: row.querySelector('[data-menu-icon] svg')?.outerHTML ?? null,
        copyPathGap: !words.toLowerCase().includes('copy path') ? 'absent' as const
          : head && tail ? tail.getBoundingClientRect().left - head.getBoundingClientRect().right : null,
      }
    })
    const hints = { enabled: [] as string[], refused: [] as string[] }
    for (const hint of el.querySelectorAll('[data-menu-hint]')) {
      if (!own(hint)) continue
      ;(hint.closest(`[data-menu-row]${refused}`) ? hints.refused : hints.enabled).push(getComputedStyle(hint).color)
    }
    const trailingGaps = [...el.querySelectorAll<HTMLElement>('[data-menu-trailing]')].filter(own).flatMap(slot => {
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
      return boxes.slice(1).map((next, index) => next.left - boxes[index]!.right)
    })
    const controls = (selector: string) => el.querySelectorAll(selector).length
    return {
      kind: el.getAttribute('data-popup-kind'),
      menuIcons: el.getAttribute('data-menu-icons'),
      startingStyle: el.getAttribute('data-starting-style') === '',
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      plate,
      rows,
      allRows,
      labels: [...el.querySelectorAll('[data-menu-row] [data-menu-label]')].map(node => node.textContent?.trim().replace(/\s+/g, ' ')).filter((label): label is string => Boolean(label)),
      checkedChoiceMarks: [...el.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map(choice => choice.querySelectorAll('[data-menu-trailing] svg').length),
      inks: { danger: ink(el, 'var(--hd-danger)'), disabled: ink(el, 'var(--hd-disabled-foreground)'), anatomySecondary: ink(el, css.getPropertyValue('--hd-secondary-foreground').trim()), secondary: ink(el, 'var(--hd-secondary-foreground)') },
      groups: [...el.querySelectorAll('[data-menu-group]')].filter(own).map(node => { const style = getComputedStyle(node); return { size: style.fontSize, weight: style.fontWeight, color: style.color, icon: node.querySelector('[data-menu-icon]') !== null } }),
      hints,
      separators: [...el.querySelectorAll('[data-menu-separator]')].filter(own).map(node => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return { height: rect.height, margins: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft], left: rect.left - box.left, right: box.right - rect.right } }),
      edges: [...el.querySelectorAll<HTMLElement>('[data-menu-group],[data-menu-note],[data-menu-footer],[data-menu-search]')]
        .filter(node => node.offsetParent !== null && own(node)).map(node => {
          const style = getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          return { left: rect.left + parseFloat(style.paddingLeft) - box.left, right: box.right - (rect.right - parseFloat(style.paddingRight)) }
        }),
      trailingGaps,
      chevrons: [...el.querySelectorAll('[data-slot="dropdown-menu-sub-trigger"] [data-menu-trailing] svg')].map(node => {
        const rect = node.getBoundingClientRect()
        return { width: rect.width, height: rect.height, color: getComputedStyle(node).color }
      }),
      interactive: controls('button,a[href],input,select,textarea,[role="button"],[role^="menuitem"],[role="switch"]'),
      anyControl: controls('button,a,input,select,[role="menuitem"],[role="switch"]'),
      infoEdges: [...el.querySelectorAll('[data-info-title],[data-info-facts],[data-info-note]')].map(node => node.getBoundingClientRect().left - box.left),
      infoKeys: [...el.querySelectorAll('[data-info-facts] dt')].map(key => key.getBoundingClientRect().width),
      notes: [...el.querySelectorAll('[data-menu-note]')].map(node => text(node)),
      footers: [...el.querySelectorAll('[data-menu-footer]')].map(node => text(node)),
    }
  }
  return {
    tokens: { space2: px('--hd-space-2'), space4: px('--hd-space-4'), buttonHeightSm: px('--hd-btn-h-sm'), targetMin: px('--hd-target-min'), buttonTextSm: px('--hd-btn-text-sm') },
    popups: popups.map(read),
  }
}

/** One surface, read now: what the locator-based helpers hand to a rule. */
export const readSurface = async (surface: Locator): Promise<{ tokens: PopupTokens; popup: PopupFacts }> => {
  const handle = await surface.elementHandle()
  try {
    const { tokens, popups } = await surface.page().evaluate(readPopupFacts, [handle!])
    return { tokens, popup: popups[0]! }
  } finally {
    await handle?.dispose()
  }
}

export const SELECTION_ACTION = 'Ask in chat ⌘L'

/** The selection popover's one Button, read through its accessible name. */
export const readSelectionAction = async (surface: Locator): Promise<SelectionAction> => {
  const action = surface.getByRole('button', { name: SELECTION_ACTION, exact: true })
  const count = await action.count()
  if (count !== 1) return { count, visible: false, enabled: false, slot: null, variant: null, box: null, fontSize: 0, ownsTarget: false }
  return {
    count,
    visible: await action.isVisible(),
    enabled: await action.isEnabled(),
    slot: await action.getAttribute('data-slot'),
    variant: await action.getAttribute('data-variant'),
    box: await action.boundingBox(),
    ...await action.evaluate(node => {
      const box = node.getBoundingClientRect()
      return { fontSize: parseFloat(getComputedStyle(node).fontSize), ownsTarget: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) }
    }),
  }
}

export const RICH_POPUPS = '[data-slot="popover-popup"]:visible,[data-slot="popover-surface"]:visible,[data-slot="dropdown-menu-popup"][data-popup-kind]:visible,[data-slot="dropdown-menu-content"]:visible,[data-slot="dropdown-menu-sub-content"]:visible,[data-slot="hover-card-content"]:visible,[data-slot="select-content"]:visible'

/** The visible popups as they stand, read in the theme the page shows. */
export const readPopups = async (page: Page, theme: 'light' | 'dark', selection: boolean): Promise<PopupThemeReading> => {
  const rich = page.locator(RICH_POPUPS)
  const handles = await rich.elementHandles()
  try {
    const { tokens, popups } = await page.evaluate(readPopupFacts, handles)
    const selectionActions = selection ? await Promise.all(popups.map((_, at) => readSelectionAction(rich.nth(at)))) : popups.map(() => null)
    return { theme, tokens, popups, selectionActions }
  } finally {
    await Promise.all(handles.map(handle => handle.dispose()))
  }
}

/**
 * Wait for the popups the destination staged to come to rest, the way each
 * rule used to wait before it measured: a popup out of its starting style,
 * an info card at its width. A wait that runs out is not a failure here; the
 * rule reads what is there and names it.
 */
export const settlePopups = async (page: Page) => {
  const rich = page.locator(RICH_POPUPS)
  for (let at = 0; at < await rich.count(); at += 1) {
    const popup = rich.nth(at)
    await expect(popup).not.toHaveAttribute('data-starting-style', '').catch(() => {})
    if (await popup.getAttribute('data-popup-kind') === 'info-card') {
      await expect.poll(async () => (await popup.boundingBox())?.width).toBe(FRAME.infoCard.width).catch(() => {})
    }
  }
}

/** Switch the rendered page's theme without reloading it: the attribute and colour scheme a dark load sets. */
export const switchTheme = async (page: Page, theme: 'light' | 'dark') => {
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(theme => {
    if (theme === 'dark') document.body.setAttribute('data-hd-dark-theme', '')
    else document.body.removeAttribute('data-hd-dark-theme')
    document.documentElement.style.colorScheme = theme
    // A colour transition would be read mid-flight; a load has none to run.
    void getComputedStyle(document.body).color
    for (const animation of document.getAnimations()) if (animation instanceof CSSTransition) animation.finish()
  }, theme)
}

/**
 * Read a staged destination's popups: settle, read light, switch to dark and
 * read again. A destination with no popup has nothing to read in dark, and is
 * spared the switch, which restyles the whole page. `selection` reads the
 * selection popover's Button as well.
 */
export const readInBothThemes = async (page: Page, destination: string, width: number, { selection = false } = {}): Promise<PopupSnapshot> => {
  await settlePopups(page)
  const light = await readPopups(page, 'light', selection)
  if (light.popups.length === 0) return { destination, width, readings: [light] }
  await switchTheme(page, 'dark')
  const dark = await readPopups(page, 'dark', selection)
  return { destination, width, readings: [light, dark] }
}
