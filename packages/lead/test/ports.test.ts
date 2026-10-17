import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LeadPorts } from '../src/index.js'

type Ports = LeadPorts<{ prompt: string }, { text: string }, { version: 1; revision: number }>
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false

test('portable ports retain typed provider/persistence data and only public client operations', () => {
  const ports: Equal<keyof Ports, 'messages' | 'desk' | 'persistence' | 'cancellation'> = true
  const desk: Equal<keyof Ports['desk'], 'call' | 'events' | 'synced' | 'snapshot'> = true
  const request: Equal<Parameters<Ports['messages']['request']>[0], { prompt: string }> = true
  const response: Equal<Awaited<ReturnType<Ports['messages']['request']>>, { text: string }> = true
  const journal: Equal<Parameters<Ports['persistence']['append']>[0], { version: 1; revision: number }> = true
  const cancellation: Equal<keyof Ports['cancellation'], 'aborted' | 'onCancel'> = true
  assert.deepEqual([ports, desk, request, response, journal, cancellation], Array(6).fill(true))
})
