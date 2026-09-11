import { expect, it } from 'vitest'

import host from './Workbench.module.css?raw'
import prototype from '../design/showcase/panel-playground.module.css?raw'

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
 * The prototype in the design explorer draws the same layers, and the two
 * files have to agree about this or the surface built to validate the panel
 * system stops predicting it.
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
  for (const [name, css] of [
    ['the app', host],
    ['the prototype', prototype],
  ] as const) {
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

it('collapses a panel to its tabs in the sidebar only, and the two sheets agree (review of #183, rounds 5 and 6)', () => {
  // The rule matcher below is flat: a [data-collapsed] rule inside an at-rule, or nested in another rule,
  // would drop out of the comparison without a word. An at-rule holding one fails here, and the rest are taken
  // out before the matcher reads, as the workbench's reduced-motion block is (#192); nesting fails outright.
  // Read without comments, so a comment that only mentions an at-rule isn't one (round 7).
  for (const sheet of [host, prototype]) {
    for (const block of atRules(bare(sheet))) expect(block).not.toContain('[data-collapsed]')
    expect(flat(sheet)).not.toMatch(/\{[^}]*\{|&/)
  }
  const collapsing = (sheet: string) =>
    [...flat(sheet).matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => /flex:\s*none/.test(rule[2] ?? ''))
      .flatMap((rule) => (rule[1] ?? '').split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('[data-collapsed]'))
  expect(collapsing(host).length).toBeGreaterThan(0)
  expect(collapsing(prototype)).toEqual(collapsing(host))
  // Only the sidebar lays its panels out in a column. In the row docks, flex: none gives back width,
  // and a collapsed bottom strip shrank to its tabs (353 px of 1199 in the app).
  for (const selector of collapsing(host)) expect(selector.startsWith('.sidebar ')).toBe(true)
})

it('both splits give the seam a place to grab wider than the line it draws (review of #183, round 7; #202)', () => {
  const hitArea = (sheet: string) =>
    [...flat(sheet).matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => (rule[1] ?? '').includes('.splitSeam::after'))
      .map((rule) => `${(rule[1] ?? '').trim()} { ${(rule[2] ?? '').trim().replace(/\s+/g, ' ')} }`)
  expect(hitArea(host)).toHaveLength(3)
  expect(hitArea(prototype)).toEqual(hitArea(host))
  expect(hitArea(host).join('\n')).toContain('inset: 0 -4px')
  expect(hitArea(host).join('\n')).toContain('inset: -4px 0')
})
