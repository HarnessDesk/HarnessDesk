/**
 * The app frame's numbers (docs/superpowers/specs/2026-10-09-app-frame-design.md).
 *
 * `tokens.css` carries them to the components; this module carries them to
 * the checks. `e2e/ui-system/frame-contract.spec.ts` resolves every token in
 * `FRAME_TOKENS` in a real browser and measures the rendered app against
 * `FRAME`, so a number in the spec fails a check when the app differs from it
 * — the spec's own complaint was numbers that lived only in prose.
 *
 * CSS pixels at the default interface (Desk).
 */
export const FRAME = {
  bar: { height: 40, pad: 8, gap: 6, iconButton: 28, titleMin: 180, dividerHeight: 14 },
  sidebar: { width: 240, min: 200, max: 360 },
  rightPanel: { width: 400, min: 320, max: 640 },
  bottomPanel: { height: 240, min: 120 },
  main: { min: 480 },
  fold: { panelFloats: 1280, sidebarFloats: 1000 },
  page: { reading: 736, wide: 1320, gutter: 24, canvasGutter: 8 },
  rail: { rowHeight: 30, inset: 8, icon: 16, gap: 8, label: 13, line: 20, groupWeight: 500 },
  menu: { min: 200, max: 340, padding: 4, radius: 10, rowHeight: 30, rowRadius: 6 },
  infoCard: { width: 288, padding: 12 },
  summaryKey: { page: 132, panel: 92, infoCard: 96 },
} as const

/** Every token the frame names, and the pixels it must resolve to. */
export const FRAME_TOKENS: Readonly<Record<string, number>> = {
  '--hd-bar-h': FRAME.bar.height,
  '--hd-bar-divider-h': FRAME.bar.dividerHeight,
  '--hd-bar-title-min': FRAME.bar.titleMin,
  '--hd-titlebar-height': FRAME.bar.height,
  '--hd-sidebar-width': FRAME.sidebar.width,
  '--hd-column': FRAME.page.reading,
  '--hd-page-wide': FRAME.page.wide,
  '--hd-page-gutter': FRAME.page.gutter,
  '--hd-menu-min': FRAME.menu.min,
  '--hd-menu-row-radius': FRAME.menu.rowRadius,
  '--hd-popover-width-wide': FRAME.menu.max,
  '--hd-info-card-width': FRAME.infoCard.width,
  '--hd-left-row-h': FRAME.rail.rowHeight,
  '--hd-frame-icon-button': FRAME.bar.iconButton,
}

/** Phase C row internals extend A's menu without rewriting its shared entry. */
export const FRAME_MENU = {
  ...FRAME.menu,
  icon: 16, gap: 8, rowInset: 8, labelSize: 13, labelLine: 18,
  hintSize: 12, hintLine: 16, earnedPad: 6, searchHeight: 28,
  groupSize: 12, groupWeight: 500, separator: 1,
} as const
Object.assign(FRAME_TOKENS, {
  '--hd-menu-row-h': FRAME_MENU.rowHeight,
  '--hd-menu-label-line': FRAME_MENU.labelLine,
  '--hd-menu-search-h': FRAME_MENU.searchHeight,
  '--hd-info-card-key': FRAME.summaryKey.infoCard,
})
