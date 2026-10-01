import assert from 'node:assert/strict'
import { test } from 'node:test'

import { optionsIn, readCeilingAllowsMode, readCeilingDecision, withOptions } from '../src/index.js'

const denied = (toolName: string, toolInput: unknown = {}) => readCeilingDecision(toolName, toolInput)

test('read ceiling denies Claude file and notebook mutation tools', () => {
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookReadWrite']) {
    assert.equal(denied(name)?.permissionDecision, 'deny', name)
  }
})

test('read ceiling denies non-desk MCP tools and desk tools placed above read', () => {
  assert.equal(denied('mcp__other__read_file')?.permissionDecision, 'deny')
  assert.equal(denied('mcp__harnessdesk__pr_create')?.permissionDecision, 'deny')
})

test('read ceiling shell allowlist rejects writes, evasions and shell syntax', () => {
  for (const command of [
    'touch marker', 'rm -rf .', 'git add file', 'git commit -m x', 'git push',
    'python -c x', 'npm test', 'tee marker', 'git status; touch marker',
    'cat file > marker', 'cat $(touch marker)', 'git diff | sh', 'find . -exec touch marker \\;',
    'find . -delete', 'git -c pager.diff=!touch marker diff',
  ]) {
    assert.equal(denied('Bash', { command })?.permissionDecision, 'deny', command)
  }
})

test('read ceiling passes native reads and the narrow shell allowlist', () => {
  for (const name of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']) assert.equal(denied(name), undefined, name)
  for (const command of ['git status --short', 'git diff --stat', 'git log -1', 'git show HEAD', 'git rev-parse --show-toplevel', 'git ls-files', 'ls -la', 'cat README.md', 'head -20 README.md', 'tail -n 10 README.md', 'wc -l README.md', 'rg TODO packages', 'grep TODO README.md', 'find packages -type f']) {
    assert.equal(denied('Bash', { command }), undefined, command)
  }
})

test('a session without read ceiling gets no hook and no forced permission changes', () => {
  const meta = withOptions({ keep: true }, {}, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  assert.equal(meta.claudeCode.options['hooks'], undefined)
  assert.equal(meta.claudeCode.options['permissionMode'], undefined)
  assert.equal(meta.claudeCode.options['allowDangerouslySkipPermissions'], undefined)
  assert.deepEqual(optionsIn({ harnessdesk: { options: { effort: 'high' } } }), { effort: 'high' })
})

test('read ceiling options force a non-bypass mode and install a pre-tool hook', async () => {
  const meta = withOptions({ harnessdesk: { ceiling: 'read' } }, { ceiling: 'read' }, new AbortController()) as {
    harnessdesk: { ceiling: string }
    claudeCode: { options: Record<string, unknown> }
  }
  const options = meta.claudeCode.options
  assert.equal(options['permissionMode'], 'default')
  assert.equal(options['allowDangerouslySkipPermissions'], false)
  assert.deepEqual(options['disallowedTools'], ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  const hooks = options['hooks'] as { PreToolUse: { hooks: ((input: { tool_name: string; tool_input: unknown }) => unknown)[] }[] }
  const deniedHook = await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'Edit', tool_input: {} }) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string }
  }
  assert.equal(deniedHook.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(deniedHook.hookSpecificOutput.permissionDecision, 'deny')
  const allowedHook = await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }) as {
    hookSpecificOutput: { permissionDecision?: string; updatedInput: { command: string } }
  }
  assert.equal(allowedHook.hookSpecificOutput.permissionDecision, undefined)
  assert.match(allowedHook.hookSpecificOutput.updatedInput.command, /^git --no-optional-locks --no-pager -c core\.fsmonitor=false status --short$/)
  assert.equal(meta.harnessdesk.ceiling, 'read')
})

test('read ceiling keeps the mode picker at default or plan', () => {
  assert.equal(readCeilingAllowsMode('read', 'default'), true)
  assert.equal(readCeilingAllowsMode('read', 'plan'), true)
  for (const mode of ['acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']) {
    assert.equal(readCeilingAllowsMode('read', mode), false, mode)
  }
  assert.equal(readCeilingAllowsMode(undefined, 'bypassPermissions'), true)
})

test('the read ceiling survives a load and resume through persisted controls', () => {
  const loaded = optionsIn({ harnessdesk: { options: { ceiling: 'read' } } })
  assert.equal(loaded.ceiling, 'read')
  const resumed = withOptions({ claudeCode: { options: { resume: 'session-one' } } }, loaded, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  assert.equal(resumed.claudeCode.options['resume'], 'session-one')
  assert.equal(resumed.claudeCode.options['permissionMode'], 'default')
  assert.ok(resumed.claudeCode.options['hooks'])
})
