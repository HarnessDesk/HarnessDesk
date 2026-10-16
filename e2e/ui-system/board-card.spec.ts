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
