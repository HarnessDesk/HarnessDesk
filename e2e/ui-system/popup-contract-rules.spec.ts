import { expect, test } from '@playwright/test'
import { FRAME, FRAME_MENU } from '../../packages/ui/src/design/frame'
import {
  checkDestinationPopups, checkInfoGeometry, checkMenuGeometry, checkReasonAndDestructiveInk, checkSelectionAction,
  checkSubmenuChevrons, checkTrailingChildGaps,
} from './frame-contract-popup-rules'
import type { OwnRow, PopupFacts, PopupSnapshot, PopupTokens, SelectionAction } from './frame-contract-popup-snapshot'

/**
 * The C10 popup rules run in Node, over a snapshot. A rule that stopped
 * asserting would still pass on a good snapshot, so each case here breaks one
 * fact of a synthesised snapshot — shaped like the ones the browser reads —
 * and expects that rule to fail with its own message. No browser starts.
 */

const ink = { text: 'rgb(36, 36, 36)', danger: 'rgb(200, 30, 30)', disabled: 'rgb(160, 160, 160)', secondary: 'rgb(110, 110, 110)' }
const tokens: PopupTokens = { space2: 8, space4: 16, buttonHeightSm: 28, targetMin: 24, buttonTextSm: 13 }
const plateX = 100, plateY = 50, width = 240

const row = (top: number, overrides: Partial<OwnRow> = {}): OwnRow => ({
  height: FRAME_MENU.rowHeight, radius: `${FRAME_MENU.rowRadius}px`, padTop: 6, padBottom: 6,
  left: plateX + FRAME_MENU.padding, right: plateX + width - FRAME_MENU.padding,
  labelHeight: FRAME_MENU.labelLine, labelSize: `${FRAME_MENU.labelSize}px`, labelLine: `${FRAME_MENU.labelLine}px`, labelWeight: '400',
  font: 'Geist, sans-serif', smoothing: 'auto',
  hintHeight: 0, meterHeight: 0, meterGap: 0, hintSize: null, hintLine: null,
  danger: false, disabled: false, color: ink.text,
  icon: true, iconLeft: plateX + FRAME_MENU.contentInset, iconWidth: FRAME_MENU.icon, gap: FRAME_MENU.gap, iconTop: top + 6, labelTop: top + 6,
  labelLeft: plateX + FRAME_MENU.contentInset + FRAME_MENU.icon + FRAME_MENU.gap,
  bodyLeft: plateX + FRAME_MENU.contentInset + FRAME_MENU.icon + FRAME_MENU.gap, bodyRight: plateX + 160,
  trailingLeft: null, trailingRight: null, trailingWhiteSpace: null,
  label: 'Rename', title: null, hint: null, destructive: false, disabledInk: ink.disabled,
  iconColor: ink.text, labelColor: ink.text, trailingColor: null,
  ...overrides,
})

const hinted = row(80, {
  height: FRAME_MENU.labelLine + FRAME_MENU.hintLine + 2 * FRAME_MENU.earnedPad, padTop: FRAME_MENU.earnedPad, padBottom: FRAME_MENU.earnedPad,
  hintHeight: FRAME_MENU.hintLine, hintSize: `${FRAME_MENU.hintSize}px`, hintLine: `${FRAME_MENU.hintLine}px`,
  disabled: true, color: ink.disabled, iconColor: ink.disabled, labelColor: ink.disabled,
  label: 'Push', title: 'Nothing to push', hint: 'Nothing to push',
})

const menu = (overrides: Partial<PopupFacts> = {}): PopupFacts => ({
  kind: 'menu', menuIcons: 'all', startingStyle: false,
  box: { x: plateX, y: plateY, width, height: 160 },
  plate: { width, intrinsic: width, tabular: false, radius: `${FRAME_MENU.radius}px`, pad: Array(4).fill(`${FRAME_MENU.padding}px`), border: '0px', widthMode: null, overflow: false },
  rows: [
    row(56, { trailingLeft: plateX + 180, trailingRight: plateX + width - FRAME_MENU.trailingInset, trailingWhiteSpace: 'nowrap', trailingColor: ink.secondary }),
    hinted,
    row(120, { danger: true, destructive: true, color: ink.danger, iconColor: ink.danger, labelColor: ink.danger, label: 'Delete' }),
  ],
  allRows: [
    { text: 'Rename ⌘R', label: 'Rename', danger: false, mark: '<svg a/>', copyPathGap: 'absent' },
    { text: 'Push Nothing to push', label: 'Push', danger: false, mark: '<svg b/>', copyPathGap: 'absent' },
    { text: 'Delete', label: 'Delete', danger: true, mark: '<svg c/>', copyPathGap: 'absent' },
  ],
  labels: ['Rename', 'Push', 'Delete'],
  checkedChoiceMarks: [1],
  inks: { danger: ink.danger, disabled: ink.disabled, anatomySecondary: ink.secondary, secondary: ink.secondary },
  groups: [{ size: `${FRAME_MENU.groupSize}px`, weight: String(FRAME_MENU.groupWeight), color: ink.secondary, icon: false }],
  hints: { enabled: [], refused: [ink.secondary] },
  separators: [{ height: FRAME_MENU.separator, margins: [`${FRAME_MENU.padding - 2}px`, `${FRAME_MENU.separatorInset}px`, `${FRAME_MENU.padding - 2}px`, `${FRAME_MENU.separatorInset}px`], left: FRAME_MENU.padding + FRAME_MENU.separatorInset, right: FRAME_MENU.padding + FRAME_MENU.separatorInset }],
  edges: [{ left: FRAME_MENU.contentInset, right: FRAME_MENU.contentInset }],
  trailingGaps: [8],
  chevrons: [{ width: 16, height: 16, color: ink.secondary }, { width: 16, height: 16, color: ink.secondary }],
  interactive: 3, anyControl: 3, infoEdges: [], infoKeys: [], notes: [], footers: [],
  ...overrides,
})

const info = (overrides: Partial<PopupFacts> = {}): PopupFacts => menu({
  kind: 'info-card', menuIcons: null,
  box: { x: plateX, y: plateY, width: FRAME.infoCard.width, height: 120 },
  plate: { width: FRAME.infoCard.width, intrinsic: 200, tabular: false, radius: `${FRAME.menu.radius}px`, pad: Array(4).fill(`${FRAME.infoCard.padding}px`), border: '1px', widthMode: null, overflow: false },
  rows: [], allRows: [], labels: [], checkedChoiceMarks: [], groups: [], hints: { enabled: [], refused: [] }, separators: [], edges: [], trailingGaps: [], chevrons: [],
  interactive: 0, anyControl: 0, infoEdges: [FRAME.infoCard.padding, FRAME.infoCard.padding], infoKeys: [FRAME.summaryKey.infoCard],
  ...overrides,
})

const action: SelectionAction = {
  count: 1, visible: true, enabled: true, slot: 'button', variant: 'ghost',
  box: { x: plateX + FRAME_MENU.padding, y: plateY + FRAME_MENU.padding, width: 120, height: tokens.buttonHeightSm },
  fontSize: tokens.buttonTextSm, ownsTarget: true,
}
const selection = menu({
  menuIcons: 'none', box: { x: plateX, y: plateY, width: FRAME_MENU.min, height: tokens.buttonHeightSm + 2 * FRAME_MENU.padding },
  plate: { ...menu().plate, width: FRAME_MENU.min, intrinsic: 132 }, rows: [], allRows: [], interactive: 1,
})

const snapshot = (destination: string, popups: PopupFacts[]): PopupSnapshot => ({
  destination, width: 1440,
  readings: [{ theme: 'light', tokens, popups, selectionActions: popups.map(() => null) }, { theme: 'dark', tokens, popups, selectionActions: popups.map(() => null) }],
})
const withRow = (at: number, change: Partial<OwnRow>) => menu({ rows: menu().rows.map((each, index) => index === at ? { ...each, ...change } : each) })

test('a well-formed snapshot passes every popup rule', () => {
  checkMenuGeometry(menu())
  checkReasonAndDestructiveInk(menu())
  checkTrailingChildGaps(menu(), tokens)
  checkSubmenuChevrons(menu(), tokens)
  checkInfoGeometry(info())
  checkSelectionAction(selection, action, tokens)
  expect([...checkDestinationPopups(snapshot('popup-menu-icons', [menu(), info()]))].sort()).toEqual(['info-card', 'menu'])
})

/** Each case breaks one fact; the rule's failure has to name it. */
const breaks: [string, () => void, RegExp][] = [
  ['plate under the menu minimum', () => checkMenuGeometry(menu({ plate: { ...menu().plate, width: FRAME_MENU.min - 1, intrinsic: FRAME_MENU.min - 1 } })), /toBeGreaterThanOrEqual/],
  ['plate over the wide measure', () => checkMenuGeometry(menu({ plate: { ...menu().plate, width: FRAME_MENU.max + 1, intrinsic: FRAME_MENU.max + 1 } })), /toBeLessThanOrEqual/],
  ['a declared width mode', () => checkMenuGeometry(menu({ plate: { ...menu().plate, widthMode: 'wide' } })), /toBeNull/],
  ['plate wider than its content', () => checkMenuGeometry(menu({ plate: { ...menu().plate, intrinsic: width - 20 } })), /toBeCloseTo/],
  ['facts table off the wide measure', () => checkMenuGeometry(menu({ plate: { ...menu().plate, tabular: true } })), /toBeCloseTo/],
  ['plate padding', () => checkMenuGeometry(menu({ plate: { ...menu().plate, pad: ['6px', '6px', '6px', '5px'] } })), /toEqual/],
  ['plate radius', () => checkMenuGeometry(menu({ plate: { ...menu().plate, radius: '8px' } })), /toBe/],
  ['plate border', () => checkMenuGeometry(menu({ plate: { ...menu().plate, border: '1px' } })), /"0px"/],
  ['clipped text', () => checkMenuGeometry(menu({ plate: { ...menu().plate, overflow: true } })), /toBe/],
  ['a menu with no rows', () => checkMenuGeometry(menu({ rows: [] })), /toBeGreaterThan/],
  ['mixed icon policy', () => checkMenuGeometry(withRow(0, { icon: false, iconLeft: null, iconWidth: 0 })), /whole-level icon policy/],
  ['declared icon policy differs', () => checkMenuGeometry(menu({ menuIcons: 'none' })), /"all"/],
  ['checked choice without its mark', () => checkMenuGeometry(menu({ checkedChoiceMarks: [0] })), /a checked choice carries its trailing mark/],
  ['repeated label', () => checkMenuGeometry(menu({ labels: ['Rename', 'Rename', 'Delete'] })), /menu labels are unique within a menu level/],
  ['row off the plate padding', () => checkMenuGeometry(withRow(0, { left: plateX + 4 })), /toBeCloseTo/],
  ['row right edge', () => checkMenuGeometry(withRow(0, { right: plateX + width - 4 })), /toBeCloseTo/],
  ['row radius', () => checkMenuGeometry(withRow(0, { radius: '6px' })), /"4px"/],
  ['label size', () => checkMenuGeometry(withRow(0, { labelSize: '14px' })), /"13px"/],
  ['label line', () => checkMenuGeometry(withRow(0, { labelLine: '20px' })), /"18px"/],
  ['label weight', () => checkMenuGeometry(withRow(0, { labelWeight: '500' })), /"400"/],
  ['label face', () => checkMenuGeometry(withRow(0, { font: 'Inter' })), /toContain/],
  ['label smoothing', () => checkMenuGeometry(withRow(0, { smoothing: 'antialiased' })), /"auto"/],
  ['label off the line grid', () => checkMenuGeometry(withRow(0, { labelHeight: 19 })), /toBe/],
  ['one-line row height', () => checkMenuGeometry(withRow(0, { height: 32 })), /30/],
  ['earned row top padding', () => checkMenuGeometry(withRow(1, { padTop: 4 })), /toBe/],
  ['earned row bottom padding', () => checkMenuGeometry(withRow(1, { padBottom: 4 })), /toBe/],
  ['earned row height', () => checkMenuGeometry(withRow(1, { height: 50 })), /toBe/],
  ['hint size', () => checkMenuGeometry(withRow(1, { hintSize: '13px' })), /"12px"/],
  ['hint line', () => checkMenuGeometry(withRow(1, { hintLine: '18px' })), /"16px"/],
  ['icon size', () => checkMenuGeometry(withRow(0, { iconWidth: 14 })), /16/],
  ['icon gap', () => checkMenuGeometry(withRow(0, { gap: 8 })), /12/],
  ['icon off the label line', () => checkMenuGeometry(withRow(0, { iconTop: 57 })), /toBe/],
  ['icon inset', () => checkMenuGeometry(withRow(0, { iconLeft: plateX + 12 })), /toBeCloseTo/],
  ['iconless body inset', () => checkMenuGeometry(menu({ menuIcons: 'none', rows: menu().rows.map(each => ({ ...each, icon: false, danger: false, bodyLeft: plateX + 12, labelLeft: plateX + FRAME_MENU.contentInset })) })), /toBeCloseTo/],
  ['iconless label inset', () => checkMenuGeometry(menu({ menuIcons: 'none', rows: menu().rows.map(each => ({ ...each, icon: false, danger: false, bodyLeft: plateX + FRAME_MENU.contentInset, labelLeft: plateX + 12 })) })), /toBeCloseTo/],
  ['trailing wraps', () => checkMenuGeometry(withRow(0, { trailingWhiteSpace: 'normal' })), /"nowrap"/],
  ['trailing inset', () => checkMenuGeometry(withRow(0, { trailingRight: plateX + width - 10 })), /toBeCloseTo/],
  ['trailing crowds the body', () => checkMenuGeometry(withRow(0, { trailingLeft: plateX + 165 })), /toBeGreaterThanOrEqual/],
  ['destructive row without an icon', () => checkMenuGeometry(menu({ menuIcons: 'none', rows: menu().rows.map(each => ({ ...each, icon: false, bodyLeft: plateX + FRAME_MENU.contentInset, labelLeft: plateX + FRAME_MENU.contentInset })) })), /true/],
  ['destructive ink', () => checkMenuGeometry(withRow(2, { color: ink.text })), /rgb\(200, 30, 30\)/],
  ['refused destructive ink', () => checkMenuGeometry(withRow(2, { disabled: true, color: ink.danger })), /rgb\(160, 160, 160\)/],
  ['group label anatomy', () => checkMenuGeometry(menu({ groups: [{ size: '13px', weight: '400', color: ink.secondary, icon: false }] })), /toEqual/],
  ['group label icon', () => checkMenuGeometry(menu({ groups: [{ size: '12px', weight: '400', color: ink.secondary, icon: true }] })), /toEqual/],
  ['enabled hint ink', () => checkMenuGeometry(menu({ hints: { enabled: [ink.text], refused: [] } })), /rgb\(110, 110, 110\)/],
  ['refused hint ink', () => checkMenuGeometry(menu({ hints: { enabled: [], refused: [ink.disabled] } })), /rgb\(110, 110, 110\)/],
  ['separator margins', () => checkMenuGeometry(menu({ separators: [{ ...menu().separators[0]!, margins: ['6px', '10px', '6px', '10px'] }] })), /toEqual/],
  ['separator inset', () => checkMenuGeometry(menu({ separators: [{ ...menu().separators[0]!, left: 12 }] })), /toEqual/],
  ['note left edge', () => checkMenuGeometry(menu({ edges: [{ left: 12, right: FRAME_MENU.contentInset }] })), /toBeCloseTo/],
  ['note right edge', () => checkMenuGeometry(menu({ edges: [{ left: FRAME_MENU.contentInset, right: 12 }] })), /toBeCloseTo/],
  ['refusal title is not its hint', () => checkReasonAndDestructiveInk(withRow(1, { hint: 'Something else' })), /refusal title is not its visible hint/],
  ['refusal title with no hint', () => checkReasonAndDestructiveInk(withRow(1, { hint: null })), /refusal title is not its visible hint/],
  ['destructive icon ink', () => checkReasonAndDestructiveInk(withRow(2, { iconColor: ink.text })), /destructive icon ink differs from its row/],
  ['refused row ink', () => checkReasonAndDestructiveInk(withRow(1, { color: ink.text })), /refused row does not use disabled ink/],
  ['refused slot ink', () => checkReasonAndDestructiveInk(withRow(1, { labelColor: ink.text })), /refused slot does not use disabled ink/],
  ['trailing children touch', () => checkTrailingChildGaps(menu({ trailingGaps: [8, 2] }), tokens), /trailing child gaps: 8, 2/],
  ['submenu chevron size', () => checkSubmenuChevrons(menu({ chevrons: [{ width: 14, height: 14, color: ink.secondary }] }), tokens), /toEqual/],
  ['submenu chevron inks', () => checkSubmenuChevrons(menu({ chevrons: [{ width: 16, height: 16, color: ink.secondary }, { width: 16, height: 16, color: ink.text }] }), tokens), /submenu chevrons share one ink in a menu/],
  ['info card that never settled', () => checkInfoGeometry(info({ box: { ...info().box, width: 280 } })), /info card width once it settles/],
  ['info plate width', () => checkInfoGeometry(info({ plate: { ...info().plate, width: 280 } })), /288/],
  ['info padding', () => checkInfoGeometry(info({ plate: { ...info().plate, pad: Array(4).fill('10px') } })), /toEqual/],
  ['info radius', () => checkInfoGeometry(info({ plate: { ...info().plate, radius: '8px' } })), /"10px"/],
  ['info overflow', () => checkInfoGeometry(info({ plate: { ...info().plate, overflow: true } })), /toBe/],
  ['a control in an info card', () => checkInfoGeometry(info({ interactive: 1 })), /info card controls/],
  ['info content edge', () => checkInfoGeometry(info({ infoEdges: [12, 14] })), /12/],
  ['info key width', () => checkInfoGeometry(info({ infoKeys: [92] })), /96/],
  ['selection with menu rows', () => checkSelectionAction(menu({ ...selection, allRows: menu().allRows }), action, tokens), /selection popover menu rows/],
  ['selection with two controls', () => checkSelectionAction(menu({ ...selection, interactive: 2 }), action, tokens), /selection popover controls/],
  ['selection without its action', () => checkSelectionAction(selection, { ...action, count: 0 }, tokens), /the Ask in chat ⌘L button/],
  ['selection action hidden', () => checkSelectionAction(selection, { ...action, visible: false }, tokens), /Ask in chat ⌘L is visible/],
  ['selection action disabled', () => checkSelectionAction(selection, { ...action, enabled: false }, tokens), /Ask in chat ⌘L is enabled/],
  ['selection action slot', () => checkSelectionAction(selection, { ...action, slot: 'menu-item' }, tokens), /"button"/],
  ['selection action variant', () => checkSelectionAction(selection, { ...action, variant: 'outline' }, tokens), /"ghost"/],
  ['selection action height', () => checkSelectionAction(selection, { ...action, box: { ...action.box!, height: 32 } }, tokens), /28/],
  ['selection action target', () => checkSelectionAction(selection, { ...action, box: { ...action.box!, width: 20 } }, tokens), /toBeGreaterThanOrEqual/],
  ['selection action text', () => checkSelectionAction(selection, { ...action, fontSize: 14 }, tokens), /13/],
  ['selection action inset', () => checkSelectionAction(selection, { ...action, box: { ...action.box!, x: plateX + 4 } }, tokens), /toBeCloseTo/],
  ['selection action top', () => checkSelectionAction(selection, { ...action, box: { ...action.box!, y: plateY + 4 } }, tokens), /toBeCloseTo/],
  ['selection action past the plate', () => checkSelectionAction(selection, { ...action, box: { ...action.box!, width: FRAME_MENU.min } }, tokens), /toBeLessThanOrEqual/],
  ['selection action covered', () => checkSelectionAction(selection, { ...action, ownsTarget: false }, tokens), /the selection action owns its pointer target/],
  ['popup still in its starting style', () => checkDestinationPopups(snapshot('popup-menu-icons', [menu({ startingStyle: true })])), /popup has left its starting style/],
  ['an unknown popup kind', () => checkDestinationPopups(snapshot('popup-menu-icons', [menu({ kind: 'sheet' })])), /toContain/],
  ['a menu with no declared policy', () => checkDestinationPopups(snapshot('popup-not-declared', [menu()])), /popup-not-declared needs a declared menu icon policy/],
  ['a policy the menu does not declare', () => checkDestinationPopups(snapshot('popup-menu-none', [menu()])), /"none"/],
  ['a control in a destination info card', () => checkDestinationPopups(snapshot('popup-info-card', [info({ anyControl: 1 })])), /toBe/],
  ['empty Inbox with a row', () => checkDestinationPopups(snapshot('left-inbox', [menu({ kind: 'wide-menu', menuIcons: 'none', allRows: menu().allRows, notes: ['Nothing kept yet. Messages an Agent sends you wait here.'], footers: ['Kept until you clear them.'] })])), /empty Inbox menu rows/],
  ['empty Inbox note', () => checkDestinationPopups(snapshot('left-inbox', [menu({ kind: 'wide-menu', menuIcons: 'none', allRows: [], notes: ['Empty.'], footers: ['Kept until you clear them.'] })])), /toEqual/],
  ['composer context marks repeat', () => checkDestinationPopups(snapshot('popup-composer-add', [menu({ allRows: ['Current page preview', 'Working tree changes', 'Issue reference', 'Last test run', 'Project notes'].map(label => ({ text: label, label, danger: false, mark: '<svg same/>', copyPathGap: 'absent' as const })) })])), /toBe/],
  ['Remove from Team is not destructive', () => checkDestinationPopups(snapshot('popup-seat-actions', [menu({ allRows: [{ text: 'Remove from Team', label: 'Remove from Team', danger: false, mark: null, copyPathGap: 'absent' }] })])), /the one Remove from Team row is destructive/],
  ['Copy path halves apart', () => checkDestinationPopups(snapshot('popup-menu-icons', [menu({ allRows: [{ text: 'Copy path /repo/…/a.ts', label: 'Copy path', danger: false, mark: null, copyPathGap: 4 }] })])), /Copy path joins at the truncation without a space/],
  ['Copy path not truncated in halves', () => checkDestinationPopups(snapshot('popup-menu-icons', [menu({ allRows: [{ text: 'Copy path /repo/a.ts', label: 'Copy path', danger: false, mark: null, copyPathGap: null }] })])), /Copy path has both middle-truncate halves/],
]

/** A rule's failure as a person reads it: the matcher's colour codes highlight inside quoted values. */
const failure = (run: () => void): string | null => {
  try {
    run()
  } catch (error) {
    return (error as Error).message.replace(/\u001b\[[0-9;]*m/g, '')
  }
  return null
}

for (const [name, run, message] of breaks) test(`the popup rules catch ${name}`, () => {
  const said = failure(run)
  expect(said, 'the rule fails').not.toBeNull()
  expect(said).toMatch(message)
})

test('a dark reading is checked as well as the light one', () => {
  const light = snapshot('popup-menu-icons', [menu()]).readings[0]!
  const dark = { ...light, theme: 'dark' as const, popups: [withRow(1, { color: ink.text })] }
  expect(failure(() => checkDestinationPopups({ destination: 'popup-menu-icons', width: 720, readings: [light, dark] }))).toMatch(/Push: refused row does not use disabled ink/)
})
