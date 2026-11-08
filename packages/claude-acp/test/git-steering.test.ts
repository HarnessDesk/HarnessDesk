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

test('final Claude steering hook passes ordinary local git commands', async () => {
  const result = withOptions({ claudeCode: { options: { env: { HD_GIT_STEER: 'ask' } } } }, { ceiling: 'edit' }, new AbortController())
  const hooks = (result['claudeCode'] as { options: { hooks: { PreToolUse: { hooks: ((input: unknown) => Promise<unknown>)[] }[] } } }).options.hooks.PreToolUse
  const hook = hooks.at(-1)!.hooks[0]!
  for (const command of ['git rm f', 'git mv f g', 'git merge-base HEAD HEAD', 'git show-ref', 'git -c color.ui=never status']) assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command } }), {}, command)
})
