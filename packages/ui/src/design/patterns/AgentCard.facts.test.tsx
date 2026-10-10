import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { AgentCard, AgentCardModeContext, type AgentCardSubject } from './AgentCard'

const subject: AgentCardSubject = {
  kind: 'member', name: 'Scout', also: 'Storefront catalogue review', identity: 'Agent · dev@example.com', tint: 'blue', mark: <span />,
  agent: { name: 'Reviewer', ceiling: <button>Ceiling</button>, ceilingText: 'Read only — asked of the runtime', description: 'Review checkout boundaries.', origin: 'Built in', seat: 'Agent · Model · High', passedOver: ['Agent unavailable'] },
  running: { model: 'Model · High', version: '1.2.3', state: 'Working — 41s into this turn' },
  meter: { label: 'Plan', left: 37, of: 100, reading: '37% left', tone: 'warning' },
  on: { taskId: '#3', title: 'Check <script>checkout</script>', where: 'workspace/storefront · feature/checkout' },
  cautions: [{ tone: 'warning', text: 'Tools are not reachable.' }],
  actions: [{ label: 'Open', onSelect: vi.fn() }],
  choice: { label: 'Messages', value: 'hold', options: [{ value: 'hold', label: 'Hold' }], onChange: vi.fn() },
}
test('facts mode preserves the complete subject without action or choice controls', () => {
  const html = renderToStaticMarkup(<AgentCardModeContext.Provider value="facts"><AgentCard subject={subject} /></AgentCardModeContext.Provider>)
  expect(html).toContain('data-info-facts')
  for (const words of ['Scout', 'Storefront catalogue review', 'dev@example.com', 'Reviewer', 'Read only — asked of the runtime', 'Built in', 'Agent · Model · High', '1.2.3', 'Working — 41s', '37% left', '#3', 'feature/checkout', 'Hold', 'Tools are not reachable.', 'Passed over Agent unavailable']) expect(html).toContain(words)
  expect(html).toContain('&lt;script&gt;checkout&lt;/script&gt;')
  expect(html).not.toMatch(/<(?:button|a|input|select|textarea)\b/)
  expect(html).not.toContain('data-slot="card-shell"')
})
test('the full page card remains the default mode and retains its controls', () => {
  const html = renderToStaticMarkup(<AgentCard subject={subject} />)
  expect(html).toContain('Open')
  expect(html).toContain('<button')
  expect(html).not.toContain('data-info-facts')
})
