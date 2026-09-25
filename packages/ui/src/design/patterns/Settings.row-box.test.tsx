import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { buttonVariants } from '../ui/button'
import css from './Settings.module.css?raw'
import { Row, RowButton, RowChoice, Rows } from './Settings'

/**
 * A row button is the same box as the row beside it (#866).
 *
 * `.row` in Settings.module.css draws the box — inset, gap, divider — for all
 * three. In this app a Tailwind utility wins every tie with a stylesheet class
 * by order, so any utility the Button puts on a row button that says the same
 * thing as `.row` decides it instead: `content`'s `p-0` set every row button's
 * words against the card's edge. jsdom compiles no utilities, so this reads the
 * classes; `e2e/ui-system/row-box.spec.ts` measures the box in a real engine.
 */

/* Any utility that would answer a question `.row`/`.rowButton` already answer. */
const BOX_UTILITY = /^(?:p[trblxy]?|gap|rounded|border|text|leading|font|whitespace|inline-flex|flex|items|justify)(?:-|$)/
/* The row variant's own alignment and ink, which say what `.rowButton` says. */
const VARIANT_SAYS = new Set(['justify-start', 'text-left', 'text-(--hd-foreground)'])
const boxUtilities = (classes: readonly string[]) => classes.filter((one) => BOX_UTILITY.test(one) && !VARIANT_SAYS.has(one))

const classesOf = (markup: string, selector: RegExp): string[] => {
  const match = selector.exec(markup)
  if (!match) throw new Error(`no element matched ${selector}`)
  return (/class="([^"]*)"/.exec(match[0])?.[1] ?? '').split(/\s+/).filter(Boolean)
}

it('a row button and a row choice carry no utility that ties with the row box', () => {
  const markup = renderToStaticMarkup(
    <Rows>
      <Row title="Plain" />
      <RowButton title="Opens a page" onClick={() => {}} />
      <div role="radiogroup">
        <RowChoice title="One answer" selected onClick={() => {}} />
      </div>
    </Rows>,
  )
  const button = classesOf(markup, /<button[^>]*type="button"(?![^>]*role="radio")[^>]*>/)
  const choice = classesOf(markup, /<button[^>]*role="radio"[^>]*>/)
  for (const [name, classes] of [['RowButton', button], ['RowChoice', choice]] as const) {
    // The guard on the guard: the row's own box class is there to do the job.
    expect(classes.some((one) => one.startsWith('_row_') || one === 'row' || /(^|_)row(_|$)/.test(one)), `${name} lost .row`).toBe(true)
    expect(boxUtilities(classes), `${name} carries a box utility`).toEqual([])
  }
})

it('the pattern size brings the behaviour and the variant, and none of the box', () => {
  const pattern = buttonVariants({ variant: 'row', size: 'pattern' }).split(/\s+/)
  expect(boxUtilities(pattern)).toEqual([])
  // The variant's states and the behaviour stay.
  expect(pattern).toContain('hover:bg-(--hd-hover)')
  expect(pattern).toContain('aria-checked:bg-(--hd-active)')
  expect(pattern).toContain('cursor-pointer')
  expect(pattern).toContain('disabled:opacity-50')
  // Every other size still wears the button's own box.
  expect(buttonVariants({ size: 'content' })).toContain('rounded-(--hd-btn-radius)')
  expect(buttonVariants({})).toContain('inline-flex')
})

/**
 * A narrow row stacks rather than squeezing its title (#885). The layout is
 * measured in `e2e/ui-system/row-box.spec.ts`; this keeps the three rules that
 * make it in the loop `pnpm verify` runs, where no browser is.
 */
it('a row wraps its control under a title that keeps a readable width', () => {
  const rule = (selector: string): string => {
    const match = new RegExp(`(?:^|\\n)${selector.replace(/[.:()+]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)
    if (!match?.[1]) throw new Error(`no ${selector} rule`)
    return match[1]
  }
  expect(rule('.row')).toMatch(/flex-wrap:\s*wrap/)
  // A title with no floor is the one that went a letter a line.
  expect(rule('.rowText')).toMatch(/min-width:\s*min\(100%,\s*\d/)
  // A control that never shrinks runs off the card once it is alone on a line.
  expect(rule('.rowCtl')).toMatch(/flex:\s*0 1 auto/)
  expect(rule('.rowCtl')).toMatch(/max-width:\s*100%/)
})
