import { describe, expect, it } from 'vitest'

import app from './app.css?raw'
import editorial from './editorial.css?raw'
import themes from './shadcn-themes.css?raw'
import tokens from '../design/foundation/tokens.css?raw'
import sheet from '../design/foundation/tokens.sheet.css?raw'

/**
 * Sheet is a foundation: it redefines the group, panel and left-column tokens
 * and nothing else, and it has to win over every other sheet that sets them.
 *
 * The second half is the one that broke silently. A palette's dark face is
 * keyed on two attributes (`body[data-hd-palette][data-hd-dark-theme]`), so a
 * sheet keyed on one lost to it whatever the import order said: Editorial in
 * dark kept its own left-column plate under Sheet, and Studio in dark kept its
 * tinted groups. Order only breaks a tie, so the sheet must at least tie.
 */

const uncommented = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every `selector { body }` rule of a flat sheet. */
const rules = (css: string): Array<{ selectors: string[]; body: string }> =>
  [...uncommented(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: (match[1] ?? '').split(',').map((one) => one.trim()),
    body: match[2] ?? '',
  }))

const definedBy = (body: string): string[] => [...body.matchAll(/(--hd-[\w-]+)\s*:/g)].map((m) => m[1] ?? '')

/** Specificity as one comparable number; enough for these attribute-only selectors. */
const specificity = (selector: string): number => {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\[[^\]]*\]|\.[\w-]+|:(?!:)[\w-]+/g) ?? []).length
  const types = (selector.replace(/\[[^\]]*\]/g, '').match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length
  return ids * 10_000 + classes * 100 + types
}

const surfaceRule = rules(sheet).find((rule) => !rule.selectors.some((one) => one.includes('[data-slot')))
const owned = new Set(definedBy(surfaceRule?.body ?? ''))

describe('tokens.sheet.css', () => {
  it('is reading a real sheet', () => {
    expect(owned.size).toBeGreaterThan(0)
  })

  it('redefines only the group, panel and left-column tokens', () => {
    const stray = [...owned].filter((token) => !/^--hd-(card|panel-card|sidebar|left-search)-/.test(token))
    expect(stray).toEqual([])
  })

  it('is imported after every sheet that sets the same tokens', () => {
    const at = (name: string): number => app.indexOf(name)
    for (const name of ['tokens.css', 'editorial.css', 'shadcn-themes.css']) {
      expect(at(name), name).toBeGreaterThan(-1)
      expect(at('tokens.sheet.css'), name).toBeGreaterThan(at(name))
    }
  })

  it('is at least as specific as every palette or interface rule that sets its tokens', () => {
    const own = Math.min(...(surfaceRule?.selectors ?? []).map(specificity))
    const louder = [tokens, editorial, themes].flatMap((css) =>
      rules(css)
        .filter((rule) => definedBy(rule.body).some((token) => owned.has(token)))
        .flatMap((rule) => rule.selectors)
        .filter((selector) => specificity(selector) > own),
    )
    expect(louder).toEqual([])
  })
})
