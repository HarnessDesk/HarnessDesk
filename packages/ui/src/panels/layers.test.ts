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
