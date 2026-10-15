import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { selectFrameTab } from './frame-actions'

const capture = async (page: Page, name: string) => {
  if (process.env.HD_BEHAVIOR_REPAIR_FRAMES) await page.screenshot({path:`${process.env.HD_BEHAVIOR_REPAIR_FRAMES}/${name}.png`})
}

for (const theme of ['light','dark'] as const) {
  test(`quiet usage days retain zero and honest recorded-day coverage in ${theme}`, async ({page}) => {
    await openFrame(page,'frame-wall=dashboard&frame-view=spend&frame-fix10-ledger=partial',theme)
    const cost=page.getByRole('region',{name:'What it cost',exact:true})
    await expect(cost.locator('[data-slot="stat"]').filter({hasText:'Today'})).toContainText('$0')
    await expect(cost).toContainText('3 of 30 days with usage')
    await expect(cost).not.toContainText('days scanned')
    await capture(page,`spend-quiet-days-${theme}`)
  })

  test(`waiting command reads as approval rather than running in ${theme}`, async ({page}) => {
    await openFrame(page,'frame-wall=conversation&frame-fix9-command-waiting=1',theme)
    const transcript=page.locator('[data-live-transcript]')
    await expect(transcript).toContainText('Waiting for approval · List files in storefront')
    await expect(transcript).not.toContainText('Listing files')
    await capture(page,`conversation-approval-${theme}`)
  })

  test(`stopped Team Seats stay readable with refused agent actions in ${theme}`,async({page})=>{
    await openFrame(page,'frame-wall=team&frame-fix9-stop=1',theme)
    await selectFrameTab(page,'run')
    await page.getByRole('button',{name:'Stop run…',exact:true}).click()
    await page.getByRole('alertdialog').getByRole('button',{name:'Stop run',exact:true}).click()
    await page.getByRole('button',{name:'Details',exact:true}).first().click()
    const seats=page.getByRole('region',{name:'Seats',exact:true})
    await expect(seats).toContainText('Stopped')
    await capture(page,`team-stopped-seats-${theme}`)
    const actions=seats.getByRole('button',{name:/^Actions for/}).first()
    await actions.click()
    await expect(page.getByRole('menuitem',{name:/^Message(?:\s|$)/})).toHaveAttribute('aria-disabled','true')
  })

  test(`board-only identifies refused messages and preserves the draft in ${theme}`,async({page})=>{
    await openFrame(page,'frame-wall=team',theme)
    await selectFrameTab(page,'room')
    const composer=page.locator('[data-slot="room-body"] [data-slot="composer"]:visible').first()
    await composer.locator('textarea').fill('Check the retry budget')
    await composer.getByRole('button',{name:'Send to',exact:true}).click()
    await page.getByRole('switch',{name:'Board-only',exact:true}).click()
    await expect(composer.locator('[data-slot="composer-chip"]').filter({hasText:'Board-only'})).toHaveAttribute('title','Agents cannot message each other. Change Board-only in Send to.')
    await expect(composer.locator('textarea')).toHaveValue('Check the retry budget')
    await capture(page,`team-board-only-${theme}`)
  })

  test(`kept transcript remains readable while retry is refused in ${theme}`,async({page})=>{
    await openFrame(page,'frame-wall=conversation&frame-fix8-kept=1',theme)
    await page.getByRole('button',{name:'Kept conversation',exact:true}).click()
    await expect(page.locator('[data-live-transcript]')).toContainText('First kept message')
    await expect(page.getByRole('button',{name:'Ask the agent to try again',exact:true})).toBeDisabled()
    await capture(page,`conversation-kept-history-${theme}`)
  })
}
