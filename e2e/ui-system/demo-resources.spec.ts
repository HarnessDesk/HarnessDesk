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
