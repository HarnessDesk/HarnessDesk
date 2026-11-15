import { expect, test } from '@playwright/test'

for (const theme of ['light','dark'] as const) test(`BoardCard opens once with Enter and Space in ${theme}`, async ({page}) => {
 await page.emulateMedia({colorScheme:theme})
 await page.goto(`/design.html?view=board-card&theme=${theme}`)
 const card=page.getByRole('button',{name:'Open checkout',exact:true})
 await expect(card).toBeVisible()
 await page.evaluate(()=>document.fonts.ready)
 await page.screenshot({path:`output/playwright/board-card/${theme}.png`})
 await card.focus()
 await page.keyboard.press('Enter')
 await expect(page.getByRole('status')).toHaveText('Opened 1 time')
 await page.keyboard.press('Space')
 await expect(page.getByRole('status')).toHaveText('Opened 2 times')
})

test('BoardCard follows the spacing foundation without competing gap utilities', async ({page}) => {
 await page.goto('/design.html?view=board-card')
 const card=page.getByRole('button',{name:'Open checkout',exact:true})
 await expect(card).toBeVisible()
 await expect(card).toHaveCSS('gap','8px')
 await page.getByRole('radio',{name:'Roomy',exact:true}).click()
 await expect(card).toHaveCSS('gap','10px')
 await page.evaluate(()=>document.body.style.setProperty('--hd-space-2','13px'))
 await expect(card).toHaveCSS('gap','13px')
 expect(await card.evaluate(node=>node.classList.contains('gap-2'))).toBe(false)
})
