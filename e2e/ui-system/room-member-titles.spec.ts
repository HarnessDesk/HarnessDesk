import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
import { teamSeats } from './team-frame-actions'
const MEMBERS = [
  ['Alpha', 'Retry the checkout call when the service is unavailable'],
  ['Beta', 'Review the retry budget and the final failure response'],
  ['Gamma', 'Check that repeated requests keep the checkout safe'],
  ['Delta', 'Cover the growing pause between checkout attempts'],
] as const

for (const theme of ['light', 'dark'] as const) {
  test(`room member context stays whole beside compact names and models in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?side-by-side&theme=${theme}`)
    const frame = page.locator('[data-frame-id="side-by-side-two"]')
    const members = await teamSeats(frame)
    await expect(members.getByRole('button', { name: /^Actions for / })).toHaveCount(4)
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
        const row = members.getByRole('group', { name: new RegExp(`^${nickname} · `) })
        const name = row.locator('[data-slot="list-row-title"]')
        await expect(name).not.toContainText(title)
        await expect(row).toHaveAccessibleName(new RegExp(title))
        await expect(name.locator('[title]')).toHaveAttribute('title', new RegExp(title))
        const subtitle = row.locator('[data-slot="list-row-subtitle"]')
        await expect(subtitle).not.toBeEmpty()
        await expect(subtitle).not.toContainText(title)
        await row.scrollIntoViewIfNeeded()
        const geometry = await subtitle.evaluate(node => {
          const box = node.getBoundingClientRect()
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
          let contained = true
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(walker.currentNode)
            for (const rect of range.getClientRects()) {
              contained &&= rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
            }
          }
          const style = getComputedStyle(node)
          return { contained, whitespace: style.whiteSpace, ellipsis: style.textOverflow }
        })
        expect(geometry.contained).toBe(true)
        expect(geometry.whitespace).toBe('nowrap')
        expect(geometry.ellipsis).toBe('ellipsis')
        // Compact model metadata and the name share the row's centred face.
        const leadOffset = await row.evaluate(node => {
          const face = node.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
          const bounds = node.getBoundingClientRect()
          return Math.abs((face.top + face.bottom - bounds.top - bounds.bottom) / 2)
        })
        expect(leadOffset).toBeLessThan(1.5)
      }
    }
  })
}
