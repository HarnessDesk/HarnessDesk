import { expect, it } from 'vitest'

import host from './Workbench.module.css?raw'
import workbench from './Workbench.tsx?raw'
import panelSeam from '../design/patterns/DockPanel.tsx?raw'
import fixedShellCss from '../design/patterns/FixedShell.module.css?raw'
import resizeHandle from '../design/ui/resize-handle.tsx?raw'

/**
 * How a panel hides the views that are not in front.
 *
 * Three properties, and each is load-bearing for a different reason — which is
 * exactly why this is pinned. Every one of them looks redundant on its own, and
 * removing any of them breaks something that will not be noticed for weeks.
 *
 *   `visibility: hidden`      Takes the layer out of the accessibility tree and
 *                             off the focus order.
 *   `transform: translate…`   Moves it out of the box its parent clips to. An
 *                             Electron `<webview>` is composited on its own
 *                             surface and computes `visibility: visible`
 *                             however its ancestors are set — so a browser
 *                             behind another tab went on painting full-size
 *                             over what was in front, and the Changes panel
 *                             showed the browser's page.
 *   not `display: none`       The layer keeps its size. A terminal measures
 *                             zero columns under `display: none` and reflows
 *                             its whole screen coming back; a webview tears
 *                             down its surface and returns blank.
 *
 * This used to assert the same three properties twice — once here and once in
 * the design explorer's panel prototype, which drew its own copy of the layers
 * and had to be kept in step. The prototype is gone: the Panels surface mounts
 * this file now, so there is one set of layers and nothing to keep in step.
 */

/* The declarations only — the comment inside this rule names `display: none`
   to say why it is not used, and a test that read the comment would pass on a
   rule that used it. */
const hiddenLayerRule = (css: string): string => {
  const at = css.indexOf('.layer[data-hidden]')
  expect(at, 'no hidden-layer rule at all').toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
}

it('a hidden layer is invisible, moved out of the way, and still has a size', () => {
  for (const [name, css] of [['the app', host]] as const) {
    const rule = hiddenLayerRule(css)
    expect(rule, `${name}: a hidden layer must leave the focus order`).toContain('visibility: hidden')
    expect(rule, `${name}: a webview ignores ancestor visibility, so move it out of the clip`).toContain(
      'transform: translate',
    )
    expect(rule, `${name}: display:none blanks a webview and reflows a terminal`).not.toContain(
      'display: none',
    )
  }
})

it('and the panel body clips, or moving the layer out achieves nothing', () => {
  // The layer is translated by its own width; the only thing keeping it off
  // screen is the body's overflow. That lives in the pattern layer, so this
  // asserts the app's half: the body is the positioning context it is offset
  // against.
  expect(host).toContain('.layers')
  expect(hiddenLayerRule(host)).toContain('translateX(-101%)')
})

/** A stylesheet without its comments. */
const bare = (sheet: string): string => sheet.replace(/\/\*[\s\S]*?\*\//g, '')

/** Each block at-rule in a sheet, whole from its `@` to the brace that closes it. */
const atRules = (sheet: string): string[] => {
  const blocks: string[] = []
  for (let at = sheet.indexOf('@'); at !== -1; at = sheet.indexOf('@', at + 1)) {
    const open = sheet.indexOf('{', at)
    // A statement at-rule, `@import` or `@charset`, ends at its semicolon and holds no rules.
    if (open === -1 || sheet.slice(at, open).includes(';')) continue
    let depth = 0
    for (let i = open; i < sheet.length; i += 1) {
      if (sheet[i] === '{') depth += 1
      else if (sheet[i] === '}' && --depth === 0) {
        blocks.push(sheet.slice(at, i + 1))
        at = i
        break
      }
    }
  }
  return blocks
}

/** A sheet as the flat matcher can read it: no comments, and no at-rule blocks, which it would read into. */
const flat = (sheet: string): string => atRules(bare(sheet)).reduce((rest, block) => rest.replace(block, ''), bare(sheet))

it('fixed panel hiding keeps its full box instead of shrinking it to tabs (review of #183, rounds 5 and 6)', () => {
  // The rule matcher below is flat: a [data-collapsed] rule inside an at-rule, or nested in another rule,
  // would drop out of the comparison without a word. An at-rule holding one fails here, and the rest are taken
  // out before the matcher reads, as the workbench's reduced-motion block is (#192); nesting fails outright.
  // Read without comments, so a comment that only mentions an at-rule isn't one (round 7).
  for (const block of atRules(bare(host))) expect(block).not.toContain('[data-collapsed]')
  expect(flat(host)).not.toMatch(/\{[^}]*\{|&/)
  const collapsing = (sheet: string) =>
    [...flat(sheet).matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => /flex:\s*none/.test(rule[2] ?? ''))
      .flatMap((rule) => (rule[1] ?? '').split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('[data-collapsed]'))
  // Phase B retires sidebar panel docking and tab-strip collapse entirely.
  // The original regression still matters: a closed native body must keep its
  // useful width rather than shrink to its tabs (353 px of 1199 in the app).
  expect(collapsing(host)).toEqual([])
  expect(collapsing(fixedShellCss)).toEqual([])
  const declarations = (selector: string) => [...flat(fixedShellCss).matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .find(rule => rule[1]?.trim() === selector)?.[2]
  // Read the individual geometry rule, not the shared visibility selector list.
  const hiddenRight = declarations(".shell[data-right-open='false'] .right")
  const hiddenBottom = declarations(".bottom")
  expect(hiddenRight).toContain('width: var(--frame-right-retained)')
  expect(hiddenBottom).toContain('left: var(--frame-left)')
  expect(hiddenBottom).toContain('right: 0')
  for (const rule of [hiddenRight, hiddenBottom]) {
    expect(rule).toContain('position: absolute')
    expect(rule).not.toMatch(/display:\s*none|width:\s*(?:0|fit-content)|flex:\s*none/)
  }
  expect(flat(host)).not.toContain('[data-collapsed]')
  expect(workbench).not.toContain('DockPanelTabs')
  for (const area of ['right']) {
    expect(fixedShellCss).toContain(`.shell[data-${area}-open='false'] .${area}`)
  }
  expect(fixedShellCss).toContain('visibility: hidden; pointer-events: none;')
  expect(fixedShellCss).toContain('var(--frame-bottom-retained)')
})

it('the seam has a place to grab wider than the line it draws (review of #183, round 7; #202)', () => {
  expect(workbench).toContain('<PanelSeam orientation={orientation}')
  expect(panelSeam).toMatch(/<ResizeHandle[\s\S]*?data-slot="panel-seam"[\s\S]*?appearance="line"/)
  expect(resizeHandle).toContain("after:-inset-x-1")
  expect(resizeHandle).toContain("after:-inset-y-1")
})
