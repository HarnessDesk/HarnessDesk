import { afterEach, expect, it, vi } from 'vitest'
import wire from '../../site-demo/demo-wire.json'
import { FakeHostSocket } from '../../site-demo/fake-host'

afterEach(() => vi.useRealTimers())

it('answers with the release version and placeholder accounts', () => {
  vi.useFakeTimers()
  const host = new FakeHostSocket('ws://demo.invalid/ws')
  const replies = new Map<number, { result: unknown }>()
  host.addEventListener('message', event => {
    const message = JSON.parse((event as MessageEvent).data)
    if (message.id) replies.set(message.id, message)
  })
  try {
    host.send(JSON.stringify({ id: 1, method: 'host/hello' }))
    for (const [index, runtime] of ['codex', 'claude-code', 'cursor'].entries()) {
      host.send(JSON.stringify({ id: index + 2, method: 'runtime/account', params: { runtime } }))
    }
    vi.advanceTimersByTime(20)
    expect(replies.get(1)?.result).toMatchObject({ hostVersion: '0.4.0' })
    for (const id of [2, 3, 4]) expect(replies.get(id)?.result).toMatchObject({
      accounts: [{ label: 'dev@example.com', email: 'dev@example.com' }],
    })
    expect(JSON.stringify(wire)).not.toContain('@harnessdesk.app')
  } finally { host.close() }
})

it('offers both release DMGs in follow-up and hand-off answers', () => {
  vi.useFakeTimers()
  const host = new FakeHostSocket('ws://demo.invalid/ws')
  const answers: string[] = []
  host.addEventListener('message', event => {
    const message = JSON.parse((event as MessageEvent).data)
    if (message.params?.event?.type === 'item/completed' && message.params.event.item?.type === 'assistantMessage') {
      answers.push(message.params.event.item.text)
    }
  })
  try {
    host.send(JSON.stringify({ id: 1, method: 'turn/queue', params: { runtime: 'claude-code', input: [{ type: 'text', text: '## Goal\nFinish the retry' }] } }))
    vi.runAllTimers()
    host.send(JSON.stringify({ id: 2, method: 'turn/queue', params: { runtime: 'codex', input: [{ type: 'text', text: 'What comes next?' }] } }))
    vi.runAllTimers()
    expect(answers).toHaveLength(2)
    for (const answer of answers) {
      expect(answer).toContain('Apple silicon')
      expect(answer).toContain('Intel')
      for (const arch of ['arm64', 'x64']) expect(answer).toContain(`https://github.com/HarnessDesk/HarnessDesk/releases/download/v0.4.0/HarnessDesk-0.4.0-${arch}.dmg`)
    }
  } finally { host.close() }
})
