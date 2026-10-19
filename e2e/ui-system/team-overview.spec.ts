import { expect, test } from '@playwright/test'
import { closeTeamDetails, teamSeats } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`Team Overview: precedence, resting ink, faces, fold and pane width in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const wide = page.locator('#team-overview-running [data-slot="team-overview"]')
    await expect(wide).toBeVisible()
    await expect(wide).toHaveAttribute('data-layout', 'table')
    await expect(wide.locator('[data-seat]')).toHaveCount(4)
    expect(await wide.locator('[data-seat]').evaluateAll(rows => rows.map(row => row.textContent))).toEqual(expect.arrayContaining([expect.stringContaining('Needs you'), expect.stringContaining('Unread'), expect.stringContaining('Working'), expect.stringContaining('Idle')]))
    expect(await wide.locator('[data-seat]').evaluateAll(rows => rows.map(row => row.getAttribute('data-seat')))).toEqual(['seat-1', 'seat-2', 'seat-0', 'seat-3'])
    await expect(wide.locator('[data-shape="face"]')).toHaveCount(4)
    // The face shares the whole cell centre, including the name and role.
    for (const row of await wide.locator('[data-seat]').all()) {
      const delta = await row.evaluate(e => {
        const face = e.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
        const cell = e.querySelector('[data-slot="table-cell"]')!.getBoundingClientRect()
        return Math.abs((face.top + face.bottom) / 2 - (cell.top + cell.bottom) / 2)
      })
      expect(delta).toBeLessThan(1.5)
    }
    const doing = wide.locator('[data-seat="seat-0"] [data-slot="seat-doing"]')
    await expect(doing).toHaveAttribute('title', /Edit/)
    expect(await doing.locator('[data-part="head"]').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true)
    const quiet = wide.locator('[data-resting]').last()
    const ink = await quiet.evaluate(e => {
      const text = e.querySelector('[data-slot="text"]') ?? e
      const mark = document.createElement('span'); mark.style.color = 'var(--hd-muted-foreground)'; e.append(mark)
      const expected = getComputedStyle(mark).color; const actual = getComputedStyle(text).color; mark.remove()
      return { actual, expected }
    })
    expect(ink.actual).toBe(ink.expected)
    const done = page.locator('#team-overview-done [data-slot="team-overview"]')
    await expect(done.getByRole('button', { name: '3 done' })).toHaveAttribute('aria-expanded', 'false')
    await expect(done.locator('[data-seat]')).toHaveCount(0)
    await done.getByRole('button', { name: '3 done' }).click()
    await expect(done.locator('[data-seat]')).toHaveCount(3)
    const narrow = page.locator('#team-overview-narrow [data-slot="team-overview"]')
    await expect(narrow).toHaveAttribute('data-layout', 'narrow')
    await expect(narrow.locator('[data-seat][data-slot="list-row"]')).toHaveCount(4)
    expect(await narrow.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
    const rig = page.locator('#team-overview-team')
    await expect(rig.locator('[data-slot="team-overview"]')).toBeVisible()
    await expect(rig.getByText('2 done', { exact: true })).toBeVisible()
    const members = await teamSeats(rig)
    await expect(members.locator('[data-slot="list-row"]')).toHaveCount(2)
    const guides = await members.evaluate(section => ({
      card: section.getBoundingClientRect().left,
      row: section.querySelector('[data-slot="list-row"]')!.getBoundingClientRect().left,
    }))
    expect(guides.row - guides.card).toBe(0)
    console.log(JSON.stringify({ theme, seatsGuides: guides, delta: guides.row - guides.card }))
    const completed = members.locator('[data-slot="list-row-trail"] [data-slot="chip"]').filter({ hasText: /^Done$/ })
    await expect(completed).toHaveCount(2)
    for (const state of await completed.all()) {
      expect(await state.evaluate(e => {
        const label = e.getBoundingClientRect()
        const row = e.closest('[data-slot="list-row"]')!.getBoundingClientRect()
        return label.left >= row.left && label.right <= row.right
      })).toBe(true)
    }
    await closeTeamDetails(rig)
    const tree = page.locator('#team-overview-sidebar')
    const rows = tree.locator('[data-left-row]')
    expect(await rows.count()).toBeGreaterThan(0)
    expect(await rows.evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display === 'list-item'))).toEqual([])
    await expect(tree.locator('ul, ol')).toHaveCount(0)
    const attention = tree.locator('[data-left-mark][aria-label="Needs you"]')
    await expect(attention).toBeVisible()
    await expect(attention.locator('[data-slot="dot"]')).toHaveAttribute('data-state', 'limit')
    await expect(tree.locator('[data-slot="spinner"]')).toHaveCount(0)
    await expect(tree.locator('[data-slot="chip"]')).toHaveCount(0)
    // A Team that is not open starts folded; its chevron lists the seats under it and folds them again.
    const disclosure = tree.getByRole('button', { name: 'Show the agents in Retry the checkout call', exact: true })
    await expect(disclosure).toHaveCount(1)
    await expect(tree.locator('[data-left-nested]')).toHaveCount(0)
    await disclosure.click()
    const fold = tree.getByRole('button', { name: 'Hide the agents in Retry the checkout call', exact: true })
    await expect(fold).toHaveCount(1)
    expect(await tree.locator('[data-left-nested]').count()).toBeGreaterThan(0)
    await tree.getByRole('button', { name: 'Room Retry the checkout call', exact: true }).hover({ position: { x: 8, y: 16 } })
    await fold.click()
    await expect(tree.locator('[data-left-nested]')).toHaveCount(0)
    const team = tree.getByRole('button', { name: 'Room Retry the checkout call', exact: true })
    const project = tree.locator('[data-project-root] button[data-draggable]')
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await project.click()
    await expect(project).toHaveAttribute('aria-expanded', 'false')
    await expect(team).toHaveCount(0)
    await project.click()
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await expect(team).toBeVisible()
    // Details still lists every seat with its conversation.
    const running = page.locator('#team-overview-live-running')
    const runningSeats = await teamSeats(running)
    await expect(runningSeats.locator('[data-slot="list-row"]')).toHaveCount(2)
    await expect(runningSeats.locator('[data-slot="list-row-title"]')).toHaveText(['Alpha', 'Beta'])
    await expect(runningSeats).toContainText('Writer conversation')
    await expect(runningSeats).toContainText('Reviewer conversation')
    await closeTeamDetails(running)
  })
}

for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, scene] of (['running', 'narrow']).entries()) test(`Team Overview: attention sentences wrap whole in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.goto(`/preview.html?team-overview&theme=${theme}`)
      const attention = page.locator(`#team-overview-${scene} [aria-label="Needs you"]`)
      const sentence = attention.locator('[data-slot="list-row-subtitle"]')
      await expect(sentence).toHaveText(/choose whether to keep the original payment method/)
      expect(await sentence.evaluate(e => {
        const style = getComputedStyle(e)
        const range = document.createRange(); range.selectNodeContents(e)
        const bounds = e.getBoundingClientRect()
        return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, lines: range.getClientRects().length, fits: e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight, inside: [...range.getClientRects()].every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1 && r.bottom <= bounds.bottom + 1) }
      })).toMatchObject({ whiteSpace: 'normal', textOverflow: 'clip', fits: true, inside: true })
      if (scene === 'narrow') expect(await sentence.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThan(30)


    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, [scene, sentence]] of ([
      ['running', 'Alpha is working'],
      ['needs-you', 'Beta is waiting for your approval'],
      ['stalled', 'Choose the target before this Run can continue'],
    ]).entries()) test(`Team Overview: the Run strip keeps live status and clickable faces align in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.goto(`/preview.html?team-overview&theme=${theme}`)
      await page.evaluate(() => document.fonts.ready)
      const overview = page.locator(`#team-overview-live-${scene} [data-slot="team-overview"]`)
      if (scene === 'stalled') {
        // A stalled Run owns its refusal; Overview keeps the action that opens it.
        await expect(overview.locator('[data-slot="room-live-line"]')).toHaveCount(0)
        await expect(overview).not.toContainText(sentence!)
        await expect(page.locator(`#team-overview-live-${scene}`).getByRole('button', { name: 'Review stopped Run', exact: true })).toBeVisible()
      } else await expect(overview.locator('[aria-label="Run"] [data-slot="room-live-line"]')).toContainText(sentence!)
      await expect(overview.locator('[data-slot="room-run-reason"]')).toHaveCount(0)
      for (const row of await overview.locator('[data-slot="table-row"][data-seat]').all()) {
        const delta = await row.evaluate(e => {
          const face = e.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
          const cell = e.querySelector('[data-slot="table-cell"]')!.getBoundingClientRect()
          const name = e.querySelector('[data-role="subject"]')!
          const range = document.createRange(); range.selectNodeContents(name)
          const line = range.getClientRects()[0]!
          const role = e.querySelector('[data-slot="table-cell"] [data-role="meta"]')
          const roleRange = document.createRange(); if (role) roleRange.selectNodeContents(role)
          return {
            face: Math.abs((face.top + face.bottom) / 2 - (cell.top + cell.bottom) / 2),
            column: role ? Math.abs(line.left - roleRange.getClientRects()[0]!.left) : 0
          }
        })
        expect(delta.face).toBeLessThan(1.5)
        expect(delta.column).toBeLessThan(1.5)
        const opener = row.getByRole('button', { name: /^Open / })
        const box = await opener.boundingBox()
        expect(box!.width).toBeGreaterThanOrEqual(24)
        expect(box!.height).toBeGreaterThanOrEqual(24)
        await opener.hover()
        await expect(opener).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        for (const title of await row.locator('[title]').all()) {
          expect(await title.evaluate(el => {
            const box = el.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            return hit !== null && el.contains(hit)
          })).toBe(true)
        }
      }
      if (scene === 'stalled') {
        const frame = page.locator(`#team-overview-live-${scene}`)
        await frame.getByRole('button', { name: 'Review stopped Run', exact: true }).click()
        await expect(frame.locator('[data-slot="run-view"]').first()).toContainText(sentence!)
        expect((await frame.textContent())?.split(sentence!)).toHaveLength(2)
      }


    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team Overview: evidence and unrouted reasons stay visible once in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const waiting = page.locator('#team-overview-live-waiting-evidence [data-slot="team-overview"]')
    await expect(waiting.locator('[aria-label="Needs you"]')).toHaveCount(0)
    await expect(waiting.locator('[aria-label="Run"]')).toContainText('Waiting for CI to go green at this revision.')
    await expect(waiting).not.toContainText('Rule ')
    await expect(waiting.locator('[data-slot="room-pending-release-line"]')).toHaveText('Waiting for a Seat to finish before releasing its checkout.')
    expect((await waiting.textContent())?.split('Waiting for CI to go green at this revision.')).toHaveLength(2)
    await waiting.getByRole('button', { name: 'Build and review', exact: true }).click()
    await expect(page.locator('#team-overview-live-waiting-evidence [data-slot="run-view"]').first()).toBeVisible()
    const reason = '"Review the change" (#2) answered revise; no rule continues from it, so this waits for you'
    const run = page.locator('#team-overview-live-unrouted [data-slot="team-overview"] [aria-label="Run"]')
    await expect(run.locator('[data-slot="room-run-reason"]')).toHaveText(reason)
    expect((await run.textContent())?.split(reason)).toHaveLength(2)

  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Overview keeps unknown stopped timing as a dash in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const overview = page.locator('#team-overview-live-stopped-unknown [data-slot="team-overview"]')
    expect(await overview.locator('th').allTextContents()).not.toContain('Now')
    await expect(overview.locator('[data-slot="seat-state"]')).toHaveText(['Stopped', 'Stopped'])
    for (const seat of await overview.locator('[data-seat]').all()) await expect(seat.locator('td[data-align="end"]').nth(1)).toHaveText('—')
    await expect(overview).not.toContainText('is working')
  })
  test(`Overview keeps findings, posting and pending release reasons once in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const overview = page.locator('#team-overview-live-findings-and-posting [data-slot="team-overview"]')
    const text = await overview.textContent()
    for (const reason of ['Waiting for 3 open blocking findings to be confirmed resolved.', 'This review is waiting to be posted.', 'Waiting for a Seat to finish before releasing its checkout.']) expect(text?.split(reason)).toHaveLength(2)
    await expect(overview).not.toContainText('after-review')
    await expect(overview.getByRole('button', { name: 'Open findings', exact: true })).toHaveCount(2)
    await overview.getByRole('button', { name: 'Open findings', exact: true }).first().click()
    await expect(page.locator('#team-overview-live-findings-and-posting [aria-label="Findings"]').first()).toBeVisible()
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Overview gives the name the available width and drops empty readings in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const overview = page.locator('#team-overview-live-running [data-slot="team-overview"]')
    const widths = await overview.locator('th').evaluateAll(heads => heads.map(head => head.getBoundingClientRect().width))
    expect(widths[0]).toBeGreaterThan(widths[4]!)
    await expect(overview.locator('[data-seat="seat-0"] [data-slot="seat-card"]')).toHaveCSS('white-space', 'nowrap')
    const done = page.locator('#team-overview-comparison [data-slot="team-overview"]')
    await expect(done.locator('th')).toHaveText(['Agent', 'Card', 'Round', 'State', 'Time', 'Open conversation'])
    expect(await done.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)

  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`an unreadable findings ledger raises attention and opens Findings in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    const rig = page.locator('#team-overview-live-unreadable-ledger')
    const overview = rig.locator('[data-slot="team-overview"]')
    const reason = 'Some findings could not be read, so this cannot be ready. A person has to look.'
    await expect(overview.getByText('Needs you', { exact: true })).toBeVisible()
    await expect(overview.locator('[aria-label="Needs you"]')).toContainText(reason)
    expect((await overview.textContent())?.split(reason)).toHaveLength(2)
    await expect(overview).not.toContainText('Rule ')
    const open = overview.getByRole('button', { name: 'Open findings', exact: true })
    await expect(open).toHaveAttribute('title', 'You or the reviewer can resolve this wait in Findings.')
    await open.click()
    await expect(rig.locator('[aria-label="Findings"]').first()).toBeVisible()
  })
}


for (const theme of ['light', 'dark'] as const) {
  test(`short Seat openers keep a 24px target in both layouts in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 1100 })
      const opener = page.locator('#team-overview-live-running [data-slot="team-overview"]').getByRole('button', { name: /^Open / }).filter({ has: page.locator('[data-role="subject"]') }).first()
      await opener.locator('[data-role="subject"]').evaluate(node => { node.textContent = 'A' })
      const box = (await opener.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(24)
      expect(box.height).toBeGreaterThanOrEqual(24)
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Team news: orange waits, blue clears on opening, and unchecked Overview has no count in ${theme}`, async ({page}) => {
    await page.setViewportSize({width:1200,height:900})
    await page.emulateMedia({colorScheme:theme})
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    const sidebar=page.locator('#team-attention-sidebar')
    const orange=sidebar.getByRole('button',{name:'Room Waiting on you',exact:true}).locator('xpath=ancestor::*[@data-left-row][1]')
    const blue=sidebar.getByRole('button',{name:'Room Finished work',exact:true}).locator('xpath=ancestor::*[@data-left-row][1]')
    const quiet=sidebar.getByRole('button',{name:'Room Seen work',exact:true}).locator('xpath=ancestor::*[@data-left-row][1]')
    await expect(orange.locator('[data-left-mark]')).toHaveAttribute('aria-label','Needs you')
    await expect(orange.locator('[data-slot="dot"]')).toHaveAttribute('data-state','limit')
    await expect(blue.locator('[data-left-mark]')).toHaveAttribute('aria-label','New')
    await expect(blue.locator('[data-slot="dot"]')).toHaveAttribute('data-state','new')
    await expect(quiet.locator('[data-left-mark]')).toHaveCount(0)
    await sidebar.screenshot({path:`${process.env.HD_1777_FRAMES ?? 'output/playwright/1777'}/sidebar-${theme}.png`})
    await blue.getByRole('button',{name:'Room Finished work',exact:true}).click({ position: { x: 8, y: 16 } })
    await expect(blue.locator('[data-left-mark]')).toHaveCount(0)
    const frame=page.locator('#team-overview-live-unchecked')
    const overview=frame.locator('[data-slot="team-overview"]')
    await expect(overview.locator('[data-unchecked-done]')).toHaveText('141 cards finished without a checkOpen BoardWrap')
    await expect(overview.locator('[aria-label="Needs you"]')).toHaveCount(0)
    await expect(frame.locator('[data-team-page="overview"] [data-slot="switcher-count"], [data-team-page="overview"] [data-slot="tabs-count"]')).toHaveCount(0)
    await expect(frame.locator('[data-team-page="overview"]')).toHaveText('Overview')
    await expect(overview.getByRole('button',{name:'Wrap',exact:true})).toBeVisible()
    const row = overview.locator('[data-unchecked-done]')
    const textBox = (await row.locator('[data-slot="list-row-title"]').boundingBox())!
    const actions = row.locator('[data-slot="list-row-trail"]')
    for (const label of ['Open Board', 'Wrap']) {
      const actionBox = (await actions.getByRole('button', {name:label, exact:true}).boundingBox())!
      expect(actionBox.x).toBeGreaterThan(textBox.x + textBox.width)
      expect(Math.abs(actionBox.y + actionBox.height / 2 - textBox.y - textBox.height / 2)).toBeLessThanOrEqual(2)
    }
    await frame.screenshot({path:`${process.env.HD_1777_FRAMES ?? 'output/playwright/1777'}/overview-${theme}.png`})
    await overview.getByRole('button',{name:'Open Board',exact:true}).click()
    await expect(frame.locator('[data-team-page="board"]')).toHaveAttribute('data-active','')
  })

  test(`Overview count equals its rendered attention rows in ${theme}`, async ({page}) => {
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    for (const scene of ['needs-you','stalled','unrouted','findings-and-posting']) {
      const frame=page.locator(`#team-overview-live-${scene}`)
      const rows=frame.locator('[data-slot="team-overview"] [aria-label="Needs you"] [data-slot="list-row"]')
      await expect(rows.first()).toBeVisible()
      const count=await rows.count()
      await expect(frame.locator('[data-team-page="overview"]')).toContainText(String(count))
    }
  })
}
