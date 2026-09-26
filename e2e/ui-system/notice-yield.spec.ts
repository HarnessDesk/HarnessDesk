/**
 * A floating notice makes room below a pane's header, never by moving it
 * (#968).
 *
 * `Panes.tsx` marks the pane riding the notice stack `data-notice-yield`, and
 * `App.tsx` sets `--hd-notice-inset` to the stack's height plus its floor and
 * gap. The stack is placed below the pane's bars, so what must make room is
 * the screen's body, not the screen: the first version moved the whole
 * screen, and the conversation's header slid down under the very card it
 * was meant to sit above. Measured here on the real conversation, in the
 * real cascade, with only the two things the app would add supplied.
 */
import { expect, test } from '@playwright/test'

const INSET = 96

test('the conversation header stays put and its first message clears the notice', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.locator('h2', { hasText: 'Conversation — the transcript and its composer' })
  await expect(frame).toBeVisible()

  const measured = await frame.evaluate((heading, inset) => {
    const bar = heading.nextElementSibling!.querySelector<HTMLElement>('[data-slot="bar"]')!
    const screen = bar.parentElement!
    const body = bar.nextElementSibling as HTMLElement
    const firstMessage = () => body.querySelector<HTMLElement>('[data-slot="turn-item"], [class*="bubble"], p')!
    const before = { header: bar.getBoundingClientRect().top, body: body.getBoundingClientRect().top }

    // What Panes.tsx and App.tsx add around a pane riding a showing stack.
    const yielding = document.createElement('div')
    yielding.setAttribute('data-notice-yield', '')
    screen.parentElement!.insertBefore(yielding, screen)
    yielding.appendChild(screen)
    yielding.parentElement!.style.setProperty('--hd-notice-inset', `${inset}px`)

    const header = bar.getBoundingClientRect()
    return {
      headerBefore: before.header,
      headerAfter: header.top,
      bodyMoved: body.getBoundingClientRect().top - before.body,
      messageTop: firstMessage().getBoundingClientRect().top,
      noticeBottom: header.bottom + inset,
    }
  }, INSET)

  expect(measured.headerAfter).toBe(measured.headerBefore)
  expect(measured.bodyMoved).toBe(INSET)
  expect(measured.messageTop).toBeGreaterThanOrEqual(measured.noticeBottom)
})

test('a screen with no header of its own still yields whole', async ({ page }) => {
  await page.goto('/preview.html')
  const moved = await page.evaluate((inset) => {
    const host = document.createElement('div')
    host.style.setProperty('--hd-notice-inset', `${inset}px`)
    // A pane is its own formatting context; without one the margin would
    // collapse into the host and move both.
    host.style.display = 'flow-root'
    const yielding = document.createElement('div')
    yielding.setAttribute('data-notice-yield', '')
    const screen = document.createElement('div')
    screen.textContent = 'A screen with no bar'
    yielding.appendChild(screen)
    host.appendChild(yielding)
    document.body.prepend(host)
    return yielding.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, INSET)
  expect(moved).toBe(INSET)
})
