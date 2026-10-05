import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
const MEMBERS = [
  ['Alpha', 'Retry the checkout call when the service is unavailable'],
  ['Beta', 'Review the retry budget and the final failure response'],
  ['Gamma', 'Check that repeated requests keep the checkout safe'],
  ['Delta', 'Cover the growing pause between checkout attempts'],
] as const

for (const theme of ['light', 'dark'] as const) {
  test(`room member titles arrive whole in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?side-by-side&theme=${theme}`)
    const frame = page.locator('[data-frame-id="side-by-side-two"]')
    await expect(frame.locator('aside [data-slot="list-row"] button[aria-label^="Watch"]')).toHaveCount(4)
    await page.evaluate(async () => { await document.fonts.ready })

    // Optional local evidence, from the same production pane and synthetic roster.
    const capture = process.env.ROOM_TITLE_FRAMES
    if (capture) {
      mkdirSync(capture, { recursive: true })
      await frame.locator('[data-side-by-side-container]').evaluate(node => { (node as HTMLElement).style.height = '820px' })
      // Collect the exact frame the locator photographs, including tooltip and field values.
      const seen = await frame.evaluate((root, collect) => {
        const read = new Function('document', `return ${collect}`)
        return read({ body: root, title: document.title, querySelectorAll: root.querySelectorAll.bind(root) })
      }, COLLECT)
      expect(textReasons(seen, { user: USER })).toEqual([])
      await frame.screenshot({ path: `${capture}/${theme}.png` })
    }

    for (const width of [1440, 1000]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const [nickname, title] of MEMBERS) {
        const row = frame.locator('aside [data-slot="list-row"]').filter({ has: page.getByRole('button', { name: `Watch ${nickname} beside the others`, exact: true }) })
        const name = row.locator('[data-slot="list-row-title"]')
        await expect(name).not.toContainText(title)
        const subtitle = row.locator('[data-slot="list-row-subtitle"]')
        await expect(subtitle).toContainText(title)
        await row.scrollIntoViewIfNeeded()
        const geometry = await subtitle.evaluate(node => {
          const box = node.getBoundingClientRect()
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
          const lines: number[] = []
          let contained = true
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(walker.currentNode)
            for (const rect of range.getClientRects()) {
              contained &&= rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
              lines.push(Math.round(rect.top))
            }
          }
          const style = getComputedStyle(node)
          return { contained, lines: new Set(lines).size, whitespace: style.whiteSpace, overflowWrap: style.overflowWrap, ellipsis: style.textOverflow }
        })
        expect(geometry.contained).toBe(true)
        expect(geometry.lines).toBeGreaterThan(1)
        expect(geometry.whitespace).toBe('normal')
        expect(geometry.overflowWrap).toBe('normal')
        expect(geometry.ellipsis).not.toBe('ellipsis')
        // The face stays centred on the nickname's first line as the subtitle grows.
        const leadOffset = await row.evaluate(node => {
          const face = node.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(node.querySelector('[data-slot="list-row-title"]')!)
          const first = range.getClientRects()[0]!
          return Math.abs((face.top + face.bottom - first.top - first.bottom) / 2)
        })
        expect(leadOffset).toBeLessThan(1.5)
      }
    }
  })
}
