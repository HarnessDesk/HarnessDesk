import { expect, test } from '@playwright/test'

/** The demo recording must answer the poll used by Settings' Process cost. */
test('the demo host has an empty process-cost answer', async ({ page }) => {
  await page.goto('/site-demo/index.html?view=hero')
  const answer = await page.evaluate(async () => {
    const { FakeHostSocket } = await import('/site-demo/fake-host.ts')
    const socket = new FakeHostSocket('ws://demo.invalid/ws')
    try {
      return await new Promise(resolve => {
        socket.addEventListener('message', (event: MessageEvent<string>) => {
          const reply = JSON.parse(event.data)
          if (reply.id === 1001) resolve(reply)
        })
        socket.send(JSON.stringify({ id: 1001, method: 'runtime/resources', params: {} }))
      })
    } finally { socket.close() }
  })
  expect(answer).toEqual({ id: 1001, ok: true, result: [] })
})

test('website fake Host advertises and answers its clock', async ({ page }) => {
  await page.goto('/site-demo/index.html?view=usage')
  const replies = await page.evaluate(async () => {
    const { FakeHostSocket } = await import('/site-demo/fake-host.ts')
    const socket = new FakeHostSocket('ws://demo.invalid/ws')
    try {
      const request = (id: number, method: string) => new Promise<any>(resolve => {
        socket.addEventListener('message', (event: MessageEvent<string>) => { const reply = JSON.parse(event.data); if (reply.id === id) resolve(reply) })
        socket.send(JSON.stringify({ id, method, params: {} }))
      })
      return [await request(1002, 'host/hello'), await request(1003, 'host/clock'), await request(1004, 'host/clock')]
    } finally { socket.close() }
  })
  expect(replies[0].result.capabilities.hostClock).toBe(true)
  expect(replies[1].result.hostNowMs).toBeGreaterThan(Date.now() - 10_000)
  expect(typeof replies[1].result.clockEpoch).toBe('string')
  expect(replies[2].result.clockEpoch).toBe(replies[1].result.clockEpoch)
})

test('website usage view shows current shifted reports', async ({ page }) => {
  await page.goto('/site-demo/index.html?view=usage&pace=fast')
  // The existing staged turn can wait up to 25 seconds before opening the dashboard.
  await expect(page.getByText('What is left')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Unverified', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Codex', { exact: true }).first()).toBeVisible()
  const state = await page.evaluate(() => {
    const store = (window as any).__hdStore
    return { hostTime: store.hostTime(), reports: store.getSnapshot().usage }
  })
  expect(Number.isFinite(state.hostTime?.lowerMs)).toBe(true)
  expect(state.reports.some((report: any) => report.runtime === 'codex' && Number.isFinite(report.fetchedAt) && report.lanes.length > 0)).toBe(true)

})
