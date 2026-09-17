import { expect, test } from '@playwright/test'

/**
 * A row is one height, under every dial.
 *
 * `--hd-row-h` is `var(--hd-nav-h)` because a menu item and the rail row it
 * opens from are the same row. Saying it once is what makes a dial move both —
 * and a block that restates the alias breaks that without failing anything.
 * The shadcn palette set `--hd-row-h: 32px` beside a `--hd-nav-h` it never
 * mentioned, and the two agreed only because that block also raises the type
 * step and `--hd-nav-h` is solved from the type: 16 × 1.5 + 8 is 32. The
 * numbers matched; the contract did not.
 *
 * `row-height-alias.test.ts` refuses the restatement in the source. This reads
 * what the browser actually resolves, across every palette and both
 * interfaces, because a token can also be shadowed by a sheet nobody thought
 * to grep.
 */

const PALETTES = ['harnessdesk', 'editorial', 'shadcn'] as const
const INTERFACES = ['desk', 'studio'] as const

test('the row alias resolves to the nav row under every dial', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })

  /* By the dial's own label. A `select`'s text is every option run together,
     so "harnessdeskeditorialshadcn" contains "desk" and a text filter picks
     the palette when you asked for the interface. */
  const dial = (label: string) => page.locator('label').filter({ hasText: new RegExp(`^${label}`) }).locator('select').first()
  const palette = dial('palette')
  const look = dial('interface')
  await expect(palette).toBeVisible()
  await expect(look).toBeVisible()

  const measured: string[] = []
  for (const which of PALETTES) {
    for (const interfaceName of INTERFACES) {
      await palette.selectOption(which)
      await look.selectOption(interfaceName)
      // The dials write attributes on <body>; the sheets they pull in are
      // imported on demand, so a value read too early is the default.
      await expect
        .poll(async () => page.evaluate(() => document.body.getAttribute('data-hd-palette') ?? 'harnessdesk'))
        .toBe(which)
      measured.push(await page.evaluate(([whichName, look]) => {
        /* A fresh element per token. Re-using one and reassigning its
           `height` returns the first reading every time — which is how the
           first version of this check read 32 and 32 for a pair that was
           really 32 and 29, and reported a split that was there as agreement. */
        const read = (token: string) => {
          const probe = document.body.appendChild(document.createElement('div'))
          probe.style.cssText = `position:absolute;visibility:hidden;height:var(${token})`
          const height = Math.round(probe.getBoundingClientRect().height)
          probe.remove()
          return height
        }
        const row = read('--hd-row-h')
        const nav = read('--hd-nav-h')
        return `${whichName}/${look}: --hd-row-h ${row} · --hd-nav-h ${nav}${row === nav ? '' : '  ← SPLIT'}`
      }, [which, interfaceName] as const))
    }
  }

  // The guard on the guard: six readings, and a row of 0 would make every
  // comparison trivially true.
  expect(measured).toHaveLength(PALETTES.length * INTERFACES.length)
  expect(measured.every((line) => /--hd-row-h [1-9]/.test(line))).toBe(true)
  expect(measured.filter((line) => line.includes('SPLIT')).join('\n') || 'one row everywhere').toBe('one row everywhere')
})
