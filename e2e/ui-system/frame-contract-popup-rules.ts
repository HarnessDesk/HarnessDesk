import { expect } from '@playwright/test'
import { FRAME, FRAME_MENU } from '../../packages/ui/src/design/frame'
import type { PopupFacts, PopupSnapshot, PopupThemeReading, PopupTokens, SelectionAction } from './frame-contract-popup-snapshot'
import { SELECTION_ACTION } from './frame-contract-popup-snapshot'

/**
 * The C10 popup contracts as pure functions over a popup snapshot
 * (`frame-contract-popup-snapshot.ts`). Each assertion and its message is the
 * one the live check made; `popup-contract-rules.spec.ts` breaks each
 * of them in a synthesised snapshot and expects the rule to say so.
 */

export const checkMenuPlate = (popup: PopupFacts) => {
  const m = popup.plate
  expect(m.width).toBeGreaterThanOrEqual(FRAME_MENU.min)
  expect(m.width).toBeLessThanOrEqual(FRAME_MENU.max)
  expect(m.widthMode).toBeNull()
  // A facts table reserves the wide measure for its name/reading/reset
  // columns; action-only menus still size to their intrinsic content.
  expect(m.width).toBeCloseTo(m.tabular ? FRAME_MENU.max : Math.min(FRAME_MENU.max, Math.max(FRAME_MENU.min, m.intrinsic)), 1)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME_MENU.padding}px`))
  expect(m.radius).toBe(`${FRAME_MENU.radius}px`)
  expect(m.border).toBe('0px')
  expect(m.overflow).toBe(false)
}

/** A selection popover contains one small Button, rather than menu rows. */
export const checkSelectionAction = (popup: PopupFacts, action: SelectionAction | null, tokens: PopupTokens) => {
  checkMenuPlate(popup)
  expect(popup.allRows, 'selection popover menu rows').toHaveLength(0)
  expect(popup.interactive, 'selection popover controls').toBe(1)
  expect(action?.count, `the ${SELECTION_ACTION} button`).toBe(1)
  expect(action!.visible, `${SELECTION_ACTION} is visible`).toBe(true)
  expect(action!.enabled, `${SELECTION_ACTION} is enabled`).toBe(true)
  expect(action!.slot).toBe('button')
  expect(action!.variant).toBe('ghost')
  const box = action!.box!, plate = popup.box
  expect(box.height).toBe(tokens.buttonHeightSm)
  expect(box.width).toBeGreaterThanOrEqual(tokens.targetMin)
  expect(action!.fontSize).toBe(tokens.buttonTextSm)
  expect(box.x - plate.x).toBeCloseTo(FRAME_MENU.padding, 2)
  expect(box.y - plate.y).toBeCloseTo(FRAME_MENU.padding, 2)
  expect(plate.y + plate.height - box.y - box.height).toBeCloseTo(FRAME_MENU.padding, 2)
  expect(box.x + box.width).toBeLessThanOrEqual(plate.x + plate.width - FRAME_MENU.padding)
  expect(action!.ownsTarget, 'the selection action owns its pointer target').toBe(true)
}

export const checkMenuGeometry = (popup: PopupFacts) => {
  checkMenuPlate(popup)
  const rows = popup.rows
  expect(rows.length).toBeGreaterThan(0)
  expect(new Set(rows.map(row => row.icon)).size, 'whole-level icon policy').toBe(1)
  expect(popup.menuIcons).toBe(rows[0]!.icon ? 'all' : 'none')
  for (const marks of popup.checkedChoiceMarks) expect(marks, 'a checked choice carries its trailing mark').not.toBe(0)
  expect(new Set(popup.labels).size, 'menu labels are unique within a menu level').toBe(popup.labels.length)
  const plate = popup.box
  for (const row of rows) {
    expect(row.left - plate.x).toBeCloseTo(FRAME_MENU.padding, 2)
    expect(plate.x + plate.width - row.right).toBeCloseTo(FRAME_MENU.padding, 2)
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
      expect(row.iconLeft! - plate.x).toBeCloseTo(FRAME_MENU.contentInset, 2)
    } else expect(row.bodyLeft - plate.x).toBeCloseTo(FRAME_MENU.contentInset, 2)
    if (!row.icon) expect(row.labelLeft - plate.x).toBeCloseTo(FRAME_MENU.contentInset, 2)
    if (row.trailingLeft !== null) {
      expect(row.trailingWhiteSpace).toBe('nowrap')
      expect(plate.x + plate.width - row.trailingRight!).toBeCloseTo(FRAME_MENU.trailingInset, 2)
      expect(row.trailingLeft - row.bodyRight).toBeGreaterThanOrEqual(FRAME_MENU.gap)
    }
    if (row.danger) {
      expect(row.icon).toBe(true)
      expect(row.color).toBe(row.disabled ? popup.inks.disabled : popup.inks.danger)
    }
  }
  checkMenuAnatomy(popup)
}

export const checkMenuAnatomy = (popup: PopupFacts) => {
  // The anatomy's secondary ink is the custom property's own value, read on
  // the plate; the hint check's is the same property through `var()`.
  const secondaryColor = popup.inks.anatomySecondary
  for (const group of popup.groups) expect(group).toEqual({ size: `${FRAME_MENU.groupSize}px`, weight: String(FRAME_MENU.groupWeight), color: secondaryColor, icon: false })
  for (const color of popup.hints.refused) expect(color).toBe(popup.inks.secondary)
  for (const color of popup.hints.enabled) expect(color).toBe(secondaryColor)
  for (const color of popup.hints.refused) expect(color).toBe(secondaryColor)
  for (const separator of popup.separators) expect(separator).toEqual({ height: FRAME_MENU.separator, margins: [`${FRAME_MENU.padding - 2}px`, `${FRAME_MENU.separatorInset}px`, `${FRAME_MENU.padding - 2}px`, `${FRAME_MENU.separatorInset}px`], left: FRAME_MENU.padding + FRAME_MENU.separatorInset, right: FRAME_MENU.padding + FRAME_MENU.separatorInset })
  for (const x of popup.edges) {
    expect(x.left).toBeCloseTo(FRAME_MENU.contentInset, 2)
    expect(x.right).toBeCloseTo(FRAME_MENU.contentInset, 2)
  }
}

export const checkReasonAndDestructiveInk = (popup: PopupFacts) => {
  const problems = popup.rows.flatMap(row => {
    const failures = row.disabled && row.title && (row.hint === null || row.hint.trim() !== row.title.trim())
      ? [`${row.label}: refusal title is not its visible hint`]
      : []
    if (row.destructive && row.iconColor !== null && row.iconColor !== row.color) {
      failures.push(`${row.label}: destructive icon ink differs from its row`)
    }
    if (row.disabled) {
      if (row.color !== row.disabledInk) failures.push(`${row.label}: refused row does not use disabled ink`)
      for (const slot of [row.iconColor, row.labelColor, row.trailingColor]) {
        if (slot !== null && slot !== row.disabledInk) failures.push(`${row.label}: refused slot does not use disabled ink`)
      }
    }
    return failures
  })
  expect(problems).toEqual([])
}

export const checkTrailingChildGaps = (popup: PopupFacts, tokens: PopupTokens) => {
  const gaps = popup.trailingGaps
  expect(gaps.every(gap => gap >= tokens.space2 - 1), `trailing child gaps: ${gaps.join(', ')}`).toBe(true)
}

export const checkProjectPathHalvesJoin = (popup: PopupFacts) => {
  const copy = popup.allRows.find(row => row.copyPathGap !== 'absent')
  if (!copy) return
  expect(copy.copyPathGap, 'Copy path has both middle-truncate halves').not.toBeNull()
  expect(copy.copyPathGap, 'Copy path joins at the truncation without a space').toBeCloseTo(0, 1)
}

export const checkSubmenuChevrons = (popup: PopupFacts, tokens: PopupTokens) => {
  const size = tokens.space4
  for (const arrow of popup.chevrons) expect([arrow.width, arrow.height]).toEqual([size, size])
  expect(new Set(popup.chevrons.map(arrow => arrow.color)).size, 'submenu chevrons share one ink in a menu').toBeLessThanOrEqual(1)
}

export const checkInfoGeometry = (popup: PopupFacts) => {
  expect(popup.box.width, 'info card width once it settles').toBe(FRAME.infoCard.width)
  const m = popup.plate
  expect(m.width).toBe(FRAME.infoCard.width)
  expect(m.pad).toEqual(Array(4).fill(`${FRAME.infoCard.padding}px`))
  expect(m.radius).toBe(`${FRAME.menu.radius}px`)
  expect(m.overflow).toBe(false)
  expect(popup.interactive, 'info card controls').toBe(0)
  for (const x of popup.infoEdges) expect(x).toBe(FRAME.infoCard.padding)
  for (const width of popup.infoKeys) expect(width).toBe(FRAME.summaryKey.infoCard)
}

const COMPOSER_CONTEXT_LABELS = ['Current page preview', 'Working tree changes', 'Issue reference', 'Last test run', 'Project notes']

/** Every popup a destination staged, in one theme; returns the popup kinds it found. */
export const checkDestinationReading = (destination: string, reading: PopupThemeReading): Set<string> => {
  const kinds = new Set<string>()
  for (const [at, popup] of reading.popups.entries()) {
    expect(popup.startingStyle, 'popup has left its starting style').toBe(false)
    const kind = popup.kind
    expect(['menu', 'wide-menu', 'info-card']).toContain(kind)
    kinds.add(kind!)
    const expectedIcons = S17_ICON_POLICY[destination]
    if (kind !== 'info-card') {
      expect(expectedIcons, `${destination} needs a declared menu icon policy`).toBeDefined()
      expect(popup.menuIcons).toBe(expectedIcons)
    }
    if (kind === 'info-card') {
      checkInfoGeometry(popup)
      expect(popup.anyControl).toBe(0)
    } else if (destination === 'editor-ask') {
      checkSelectionAction(popup, reading.selectionActions[at] ?? null, reading.tokens)
    } else if (destination === 'left-inbox') {
      // The sidebar's empty Inbox has facts and a footer, with exactly zero actions.
      expect(popup.kind).toBe('wide-menu')
      expect(popup.menuIcons).toBe('none')
      expect(popup.allRows, 'empty Inbox menu rows').toHaveLength(0)
      expect(popup.notes).toEqual(['Nothing kept yet. Messages an Agent sends you wait here.'])
      expect(popup.footers).toEqual(['Kept until you clear them.'])
      checkMenuPlate(popup)
      checkMenuAnatomy(popup)
    } else {
      checkMenuGeometry(popup)
      checkReasonAndDestructiveInk(popup)
      checkTrailingChildGaps(popup, reading.tokens)
      checkProjectPathHalvesJoin(popup)
      checkSubmenuChevrons(popup, reading.tokens)
      if (destination === 'popup-composer-add') {
        const marks = popup.allRows.filter(row => COMPOSER_CONTEXT_LABELS.includes(row.label)).map(row => row.mark ?? undefined)
        expect(marks).toHaveLength(COMPOSER_CONTEXT_LABELS.length)
        expect(marks.every(Boolean)).toBe(true)
        expect(new Set(marks).size).toBe(marks.length)
      }
      if (destination === 'popup-seat-actions') {
        const remove = popup.allRows.filter(row => row.text.toLowerCase().includes('remove from team'))
        expect(remove.map(row => row.danger), 'the one Remove from Team row is destructive').toEqual([true])
      }
    }
  }
  return kinds
}

/** A destination's snapshot, every reading; the kinds found in any of them. */
export const checkDestinationPopups = (snapshot: PopupSnapshot): Set<string> => {
  const kinds = new Set<string>()
  for (const reading of snapshot.readings) for (const kind of checkDestinationReading(snapshot.destination, reading)) kinds.add(kind)
  return kinds
}

export const S17_ICON_POLICY: Readonly<Record<string, 'all' | 'none'>> = {
  'editor-ask': 'none',
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
  'popup-composer-add': 'all',
  'popup-conversation-more': 'all',
  'popup-wide-menu': 'none',
  'popup-metered-menu': 'none',
  'popup-plan-usage': 'all',
  'popup-branch-flyout': 'all',
  'popup-branch-context': 'all',
  'popup-account-menu': 'all',
  'popup-account-info': 'all',
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
