/** Scripted, in-memory HTTPS boundary. No endpoint or credential is ever consulted. */
export type FakeReply = { status: number; body: string; processing?: 'not-started' | 'unknown'; retryAfter?: string }
export type FakeStep = FakeReply | ((request: any) => Promise<FakeReply>)
export const message = (content: unknown[] = [{ type: 'text', text: 'Ready' }], patch: Record<string, unknown> = {}): FakeReply => ({
  status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, ...patch }),
})
export const tool = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input })
export const fakeMessages = (steps: FakeStep[]) => {
  const requests: any[] = []
  return { requests, async send(request: any): Promise<FakeReply> {
    requests.push(request)
    const step = steps.shift()
    if (!step) throw new Error('unexpected fake request')
    return typeof step === 'function' ? step(request) : step
  } }
}
