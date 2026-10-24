import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withOptions } from '../src/bridge.js'

test('SDK PreToolUse receives a model-readable steering denial at every ceiling; off adds nothing', async () => {
  for (const ceiling of ['read', 'edit', 'publish', 'merge']) for (const mode of ['ask', 'redirect', 'off']) {
    const result = withOptions({ claudeCode: { options: { env: { HD_GIT_STEER: mode } } } }, { ceiling }, new AbortController())
    const options = (result['claudeCode'] as { options: Record<string, unknown> }).options
    const hooks = (options['hooks'] as { PreToolUse?: { hooks: ((input: unknown) => Promise<unknown>)[] }[] } | undefined)?.PreToolUse ?? []
    if (mode === 'off') { assert.equal(hooks.length, ceiling === 'read' ? 1 : 0); continue }
    const sdkHook = hooks.at(-1)!.hooks[0]!
    const denied = await sdkHook({ tool_name: 'Bash', tool_input: { command: '/usr/bin/git push origin x' } }) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Use git_push/)
    assert.deepEqual(await sdkHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }), {})
  }
})
