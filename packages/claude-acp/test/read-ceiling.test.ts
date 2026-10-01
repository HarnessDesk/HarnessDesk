import assert from 'node:assert/strict'
import { test } from 'node:test'

import { optionsIn, readCeilingAllowsMode, readCeilingDecision, withOptions } from '../src/index.js'
import { forkedControls } from '../src/bridge.js'

const denied = (toolName: string, toolInput: unknown = {}) => readCeilingDecision(toolName, toolInput)

test('read ceiling denies Claude file and notebook mutation tools', () => {
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookReadWrite']) {
    assert.equal(denied(name)?.permissionDecision, 'deny', name)
  }
})

test('read ceiling denies non-desk MCP tools and desk tools placed above read', () => {
  assert.equal(denied('mcp__other__read_file')?.permissionDecision, 'deny')
  assert.equal(denied('mcp__harnessdesk__pr_create')?.permissionDecision, 'deny')
  for (const name of ['TaskStop', 'WebFetch', 'WebSearch', 'mcp__harnessdesk__pr_review', 'mcp__harnessdesk__pr_comment', 'mcp__harnessdesk__issue_comment', 'mcp__harnessdesk__browser_cdp']) {
    assert.equal(denied(name)?.permissionDecision, 'deny', name)
  }
  for (const name of ['mcp__harnessdesk__agent_message', 'mcp__harnessdesk__notify_person', 'mcp__harnessdesk__browser_click', 'mcp__harnessdesk__browser_open', 'mcp__harnessdesk__ios_tap', 'mcp__harnessdesk__run_check', 'mcp__harnessdesk__fetch_url']) {
    assert.equal(denied(name)?.permissionDecision, 'deny', name)
  }
  for (const name of ['mcp__harnessdesk__todo_write', 'mcp__harnessdesk__claim_work', 'mcp__harnessdesk__record_review', 'mcp__harnessdesk__browser_read_page']) {
    assert.equal(denied(name), undefined, name)
  }
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
  for (const name of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) assert.equal(denied(name), undefined, name)
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
  assert.equal(meta.claudeCode.options['settings'], undefined)
  assert.equal(meta.claudeCode.options['settingSources'], undefined)
  assert.equal(meta.claudeCode.options['strictMcpConfig'], undefined)
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
  assert.deepEqual(options['settingSources'], ['user'], 'only user settings load; repository project/local settings do not')
  assert.equal(options['strictMcpConfig'], true, 'only bridge supplied MCP servers are started')
  assert.deepEqual(options['settings'], { disableAllHooks: true }, 'settings-layer hooks and statusLine commands are disabled')
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

test('read flag settings preserve caller settings while disabling file hooks', () => {
  const meta = withOptions({ claudeCode: { options: { settings: { outputStyle: 'Explanatory', hooks: { SessionStart: [{ hooks: [] }] } } } } }, { ceiling: 'read' }, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  assert.deepEqual(meta.claudeCode.options['settings'], {
    outputStyle: 'Explanatory', hooks: { SessionStart: [{ hooks: [] }] }, disableAllHooks: true,
  })
  const hooks = meta.claudeCode.options['hooks'] as { PreToolUse: unknown[] }
  assert.equal(hooks.PreToolUse.length, 1, 'the bridge SDK callback remains installed')
})

test('read ceiling removes project and local sources without re-enabling excluded sources', () => {
  const filtered = withOptions({ claudeCode: { options: { settingSources: ['user', 'project', 'local'] } } }, { ceiling: 'read' }, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  const isolated = withOptions({ claudeCode: { options: { settingSources: [] } } }, { ceiling: 'read' }, new AbortController()) as {
    claudeCode: { options: Record<string, unknown> }
  }
  assert.deepEqual(filtered.claudeCode.options['settingSources'], ['user'])
  assert.deepEqual(isolated.claudeCode.options['settingSources'], [])
})

test('forked read seats retain the parent ceiling', () => {
  assert.deepEqual(forkedControls({ ceiling: 'read', effort: 'high' }), { ceiling: 'read' })
  assert.deepEqual(forkedControls({ effort: 'high' }), {})
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
