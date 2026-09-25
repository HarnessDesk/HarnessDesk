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

/*
 * The properties the row's own sheet says, read from `.row`, `.rowButton` and
 * `.rowChoice` themselves. A shorthand counts as each longhand it sets, and
 * `border-bottom` as the border.
 */
const SHORTHAND: Record<string, readonly string[]> = {
  font: ['font-size', 'line-height', 'font-weight', 'font-family'],
  'border-bottom': ['border'],
}
const sheetSays = (): Set<string> => {
  const said = new Set<string>()
  for (const selector of ['.row', '.rowButton', '.rowChoice']) {
    const body = new RegExp(`(?:^|\\n)\\${selector} \\{([^}]*)\\}`).exec(css)?.[1]?.replace(/\/\*[\s\S]*?\*\//g, '') ?? ''
    for (const [, property] of body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
      for (const one of SHORTHAND[property!] ?? [property!]) said.add(one)
    }
  }
  return said
}

/* The one property each utility the Button can put on a row sets, whatever
   state modifier it is written under: a state is still a tie while it holds. */
const PROPERTY: readonly [RegExp, string][] = [
  [/^p[trblxy]?-/, 'padding'],
  [/^gap-/, 'gap'],
  [/^rounded/, 'border-radius'],
  [/^border/, 'border'],
  [/^text-(?:left|right|center|start|end)$/, 'text-align'],
  [/^text-(?:\(length:|xs|sm|base|lg|xl)/, 'font-size'],
  [/^text-/, 'color'],
  [/^leading-/, 'line-height'],
  [/^font-/, 'font-weight'],
  [/^whitespace-/, 'white-space'],
  [/^(?:inline-flex|flex|grid|block|inline-block)$/, 'display'],
  [/^flex-wrap|^flex-nowrap/, 'flex-wrap'],
  [/^items-/, 'align-items'],
  [/^justify-/, 'justify-content'],
  [/^w-/, 'width'],
  [/^bg-/, 'background'],
  [/^cursor-/, 'cursor'],
]
const propertyOf = (utility: string): string | undefined => {
  const bare = utility.split(/:(?![^[(]*[\])])/).at(-1) ?? utility
  return PROPERTY.find(([pattern]) => pattern.test(bare))?.[1]
}
/* Every utility on the element that sets a property the row's sheet also sets. */
const ties = (classes: readonly string[]): string[] => {
  const said = sheetSays()
  return classes.filter((one) => {
    const property = propertyOf(one)
    return property !== undefined && said.has(property)
  })
}

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
    expect(ties(classes), `${name} carries a utility that ties with the row's sheet`).toEqual([])
  }
})

it('the pattern size brings the behaviour and the variant, and none of the box', () => {
  // The guard on the guard: the sheet says the box and the ink, so a tie on
  // any of them would be found.
  expect([...sheetSays()]).toEqual(expect.arrayContaining(['padding', 'gap', 'border', 'border-radius', 'color', 'display', 'width']))
  const pattern = buttonVariants({ variant: 'row', size: 'pattern' }).split(/\s+/)
  expect(ties(pattern)).toEqual([])
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
