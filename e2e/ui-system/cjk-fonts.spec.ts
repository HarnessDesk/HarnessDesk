import { expect, test } from '@playwright/test'

const stacks = {
  sc: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'],
  tc: ['PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK TC'],
  ja: ['Hiragino Sans', 'Yu Gothic', 'Meiryo', 'Noto Sans CJK JP'],
  ko: ['Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR'],
}
const languages = [
  { lang: '', order: ['sc', 'tc', 'ja', 'ko'] },
  { lang: 'en', order: ['sc', 'tc', 'ja', 'ko'] },
  { lang: 'zh-Hans', order: ['sc', 'tc', 'ja', 'ko'] },
  { lang: 'zh-CN', order: ['sc', 'tc', 'ja', 'ko'] },
  { lang: 'zh-Hant', order: ['tc', 'sc', 'ja', 'ko'] },
  { lang: 'zh-Hant-TW', order: ['tc', 'sc', 'ja', 'ko'] },
  { lang: 'zh-TW', order: ['tc', 'sc', 'ja', 'ko'] },
  { lang: 'zh-HK', order: ['tc', 'sc', 'ja', 'ko'] },
  { lang: 'zh-MO', order: ['tc', 'sc', 'ja', 'ko'] },
  { lang: 'ja', order: ['ja', 'sc', 'tc', 'ko'] },
  { lang: 'ja-JP', order: ['ja', 'sc', 'tc', 'ko'] },
  { lang: 'ko-KR', order: ['ko', 'sc', 'tc', 'ja'] },
] as const

for (const theme of ['light', 'dark'] as const) {
  test(`the ${theme} interface orders CJK faces by document language and rolls back with one token`, async ({ page }) => {
    await page.goto('/design.html?view=button')
    const button = page.getByRole('button', { name: 'Continue', exact: true }).first()
    await expect(button).toBeVisible()
    await page.evaluate((dark) => document.body.toggleAttribute('data-hd-dark-theme', dark), theme === 'dark')
    const metrics = await button.evaluate((el) => {
      const cs = getComputedStyle(el)
      return [cs.fontSize, cs.fontWeight, cs.lineHeight]
    })

    for (const { lang, order } of languages) {
      await page.evaluate((lang) => document.documentElement.lang = lang, lang)
      const expected = [
        // Chromium serializes the BlinkMacSystemFont alias as system-ui.
        'Geist', '-apple-system', 'system-ui', 'Segoe UI',
        ...order.flatMap((key) => stacks[key]),
        'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif',
      ]
      const family = await button.evaluate((el) => getComputedStyle(el).fontFamily)
      expect(family.split(',').map((name) => name.trim().replace(/["']/g, '')), lang || 'unset').toEqual(expected)
      expect(await button.evaluate((el) => {
        const cs = getComputedStyle(el)
        return [cs.fontSize, cs.fontWeight, cs.lineHeight]
      })).toEqual(metrics)
    }

    // A reviewer can restore the old behaviour without undoing any role or screen.
    const oldFamily = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    await page.evaluate((value) => document.body.style.setProperty('--hd-font-family', value), oldFamily)
    for (const lang of ['zh-Hans', 'zh-Hant', 'ja', 'ko']) {
      await page.evaluate((lang) => document.documentElement.lang = lang, lang)
      expect(await button.evaluate((el) => getComputedStyle(el).fontFamily)).toBe('Geist, -apple-system, "system-ui", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif')
    }
  })
}

test('the catalogue and preview show the real text and controls in all four CJK scripts', async ({ page }) => {
  for (const route of ['/design.html?view=head', '/preview.html']) {
    await page.goto(route)
    const specimen = page.getByTestId('cjk-specimen')
    await expect(specimen).toBeVisible()
    for (const lang of ['zh-Hans', 'zh-Hant', 'ja', 'ko']) {
      const sample = specimen.locator(`[data-cjk-language="${lang}"]`)
      await expect(sample.locator('[data-cjk-sample]')).toBeVisible()
      await expect(sample.locator('[data-cjk-glyph]')).not.toHaveCount(0)
      await expect(sample.locator('[data-slot="button"]')).toBeVisible()
      await expect(sample.locator('[data-slot="chip"]')).toBeVisible()
      await expect(sample.locator('input')).toBeVisible()
    }
  }
})
