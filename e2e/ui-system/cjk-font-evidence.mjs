/**
 * Run against this checkout's Vite server, before and after the token edit:
 * CJK_ORIGIN=http://127.0.0.1:<port> node e2e/ui-system/cjk-font-evidence.mjs before
 * CJK_ORIGIN=http://127.0.0.1:<port> node e2e/ui-system/cjk-font-evidence.mjs after
 * Uses the typography review's CSS.getPlatformFontsForNode, one node per glyph.
 * The only content captured is the shared synthetic CJK specimen.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'

const stage = process.argv[2]
assert.ok(['before', 'after'].includes(stage), 'choose before or after')
const origin = process.env.CJK_ORIGIN
assert.ok(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'CJK_ORIGIN must be this checkout’s loopback Vite server')
const out = 'output/typography-cjk'
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('DOM.enable')
await cdp.send('CSS.enable')
const observations = []
try {
  for (const [surface, route] of [['catalogue', '/design.html?view=head'], ['preview', '/preview.html']]) {
    await page.goto(`${origin}${route}`)
    const specimen = page.getByTestId('cjk-specimen')
    await specimen.waitFor({ state: 'visible' })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => document.body.toggleAttribute('data-hd-dark-theme', theme === 'dark'), theme)
      for (const lang of ['zh-Hans', 'zh-Hant', 'ja', 'ko']) {
        await page.evaluate(async (lang) => {
          document.documentElement.lang = lang
          await document.fonts.ready
        }, lang)
        await specimen.scrollIntoViewIfNeeded()
        const sample = specimen.locator(`[data-cjk-language="${lang}"] [data-cjk-sample]`)
        const computed = await sample.evaluate((el) => {
          const cs = getComputedStyle(el)
          return { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, line: cs.lineHeight }
        })
        const { root } = await cdp.send('DOM.getDocument')
        const fontsAt = async (selector) => {
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
          assert.ok(nodeId, selector)
          return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts
        }
        const glyphs = []
        const text = await sample.textContent()
        for (let index = 0; index < [...text].length; index += 1) {
          const fonts = await fontsAt(`[data-cjk-language="${lang}"] [data-cjk-glyph="${index}"]`)
          if (stage === 'after' && lang === 'ja') {
            assert.ok(fonts.every((font) => font.familyName === 'Hiragino Sans'), `Japanese glyph ${index}: ${JSON.stringify(fonts)}`)
          }
          glyphs.push({ glyph: [...text][index], fonts })
        }
        const latin = await fontsAt('[data-cjk-latin]')
        assert.ok(latin.every((font) => font.familyName === 'Geist'), 'Latin must stay Geist')
        observations.push({ surface, theme, lang, text, computed, latin, glyphs })
        await specimen.screenshot({ path: `${out}/${stage}-${surface}-${lang}-${theme}.png` })
      }
    }
  }
  await fs.writeFile(`${out}/${stage}.json`, `${JSON.stringify({ stage, browser: browser.version(), platform: process.platform, observations }, null, 2)}\n`)
  console.log(`${stage}: ${observations.length} font measurements and frames saved to ${out}; Latin is Geist${stage === 'after' ? ', every Japanese glyph is Hiragino Sans' : ''}.`)
} finally {
  await browser.close()
}
