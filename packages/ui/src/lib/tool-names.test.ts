import { describe, expect, it } from 'vitest'

import type { CapabilityContribution } from '@harnessdesk/protocol'

import {
  bareToolName,
  isPlanTool,
  shellCommandOf,
  shortestUniquePathLabels,
  toolSentence,
  toolSentences,
  toolWords,
  wireNameOf,
} from './tool-names'

/**
 * Two agents, one tool, two spellings on the wire — and a UI that has to say
 * the same sentence for both.
 */

const tool = (namespace: string, name: string, description: string): CapabilityContribution =>
  ({ kind: 'tool', namespace, name, description, id: `${namespace}/${name}`, owner: 'p1', revision: 1, scope: 'session', inputSchema: {} }) as unknown as CapabilityContribution

describe('bareToolName', () => {
  it('recovers the registered name from either agent’s spelling', () => {
    expect(bareToolName('mcp__harnessdesk__browser_open')).toBe('browser_open')
    expect(bareToolName('browser_open')).toBe('browser_open')
  })
})

describe('toolWords', () => {
  it('turns an identifier back into words when nothing described it', () => {
    expect(toolWords('mcp__harnessdesk__browser_click')).toBe('Browser click')
    expect(toolWords('Write')).toBe('Write')
    // Claude Code's helper tools arrive as one CamelCase token.
    expect(toolWords('TaskOutput')).toBe('Task output')
    expect(toolWords('WebFetch')).toBe('Web fetch')
    expect(toolWords('MCPServer')).toBe('MCPServer')
  })

  /**
   * Some adapters name a call in words already. Taking one of those apart the
   * way an identifier is taken apart turns a path into a row of nouns.
   */
  it('leaves a name that is already a phrase exactly as it is', () => {
    expect(toolWords('Write /tmp/games/snake.html')).toBe('Write /tmp/games/snake.html')
    expect(bareToolName('Edit /a/b_c/d.ts')).toBe('Edit /a/b_c/d.ts')
  })
})

describe('toolWords', () => {
  /**
   * Adapters wrap a command in backticks for a markdown renderer. The row is
   * not one, so without unwrapping them the transcript shows its own source.
   */
  it('unwraps the backticks an adapter meant for a renderer', () => {
    expect(toolWords('`pnpm verify`')).toBe('pnpm verify')
    expect(toolWords('`cd /w && ls`')).toBe('cd /w && ls')
    // A stray backtick in the middle is part of the command, not a wrapper.
    expect(toolWords('echo `date`')).toBe('echo `date`')
  })
})

describe('toolSentence', () => {
  const sentences = toolSentences([
    tool('browser', 'browser_open', 'Open a URL in the browser and return a screenshot. A screenshot’s pixels are the coordinates a click takes.'),
  ])

  it('says what the plugin said, only the first sentence of it', () => {
    expect(toolSentence('browser_open', sentences)).toBe(
      'Open a URL in the browser and return a screenshot',
    )
  })

  it('says the same thing for the namespaced spelling', () => {
    expect(toolSentence('mcp__harnessdesk__browser_open', sentences)).toBe(
      'Open a URL in the browser and return a screenshot',
    )
  })

  it('falls back to words for a tool nobody described', () => {
    expect(toolSentence('mcp__other__do_a_thing', sentences)).toBe('Do a thing')
  })

  it('names a file that was read', () => {
    expect(toolSentence('Read', sentences, { kind: 'read', target: 'retry.ts' })).toBe(
      'Read retry.ts',
    )
  })

  it('names a pattern and its folder when files were searched', () => {
    expect(
      toolSentence('Grep', sentences, {
        kind: 'search',
        pattern: '50[0-9]',
        folder: 'src/checkout',
      }),
    ).toBe('Searched for 50[0-9] in src/checkout')
    expect(toolSentence('Grep', sentences, { kind: 'search', pattern: '50[0-9]' })).toBe(
      'Searched for 50[0-9]',
    )
  })

  it('names a file that was edited', () => {
    expect(toolSentence('Edit', sentences, { kind: 'fileChange', target: 'retry.ts' })).toBe(
      'Edited retry.ts',
    )
  })

  it('names a file that was created', () => {
    expect(toolSentence('Write', sentences, { kind: 'fileChange', target: 'retry.ts' })).toBe(
      'Created retry.ts',
    )
  })

  it('names the command behind its shell wrapper', () => {
    expect(
      toolSentence('Bash', sentences, {
        kind: 'command',
        command: shellCommandOf(`/bin/zsh -lc 'pnpm test'`),
      }),
    ).toBe('Ran pnpm test')
  })

  it('names a web search and its query', () => {
    expect(
      toolSentence('web_search', sentences, { kind: 'webSearch', query: 'checkout retries' }),
    ).toBe('Searched the web for checkout retries')
  })
})

describe('shortestUniquePathLabels', () => {
  it('uses only as much of duplicate base names as tells them apart', () => {
    const labels = shortestUniquePathLabels([
      'src/checkout/retry.ts',
      'src/billing/retry.ts',
      'src/checkout/client.ts',
    ])

    expect(labels.get('src/checkout/retry.ts')).toBe('checkout/retry.ts')
    expect(labels.get('src/billing/retry.ts')).toBe('billing/retry.ts')
    expect(labels.get('src/checkout/client.ts')).toBe('client.ts')
  })

  it('does not make repeated mentions of the same path look ambiguous', () => {
    const labels = shortestUniquePathLabels(['src/checkout/retry.ts', 'src/checkout/retry.ts'])
    expect(labels.get('src/checkout/retry.ts')).toBe('retry.ts')
  })
})

describe('wireNameOf', () => {
  it('offers the identifier a permission rule would name', () => {
    expect(wireNameOf('mcp__harnessdesk__browser_open')).toBe('mcp__harnessdesk__browser_open')
    expect(wireNameOf('browser_open')).toBe('browser_open')
  })

  /**
   * Claude Code names a shell call with the command itself. Printing that
   * under a row that already shows it is the same sentence twice, in a box
   * whose whole reason to exist is telling you something the row could not.
   */
  it('offers nothing when the name was already the sentence', () => {
    expect(wireNameOf('`cd /w/app && grep -m2 "dev" package.json`')).toBeNull()
    expect(wireNameOf('Write /w/app/index.ts')).toBeNull()
    expect(wireNameOf('   ')).toBeNull()
  })
})

describe('shellCommandOf', () => {
  /**
   * Codex sends `/bin/zsh -lc 'echo hi'` and its own transcript says
   * `echo hi`. The login shell is how the agent runs a command, not the
   * command, and it is the same eleven characters on every single row.
   */
  it('drops the login shell the agent ran the command through', () => {
    expect(shellCommandOf(`/bin/zsh -lc 'echo hi'`)).toBe('echo hi')
    expect(shellCommandOf(`/bin/bash -lc "pnpm verify"`)).toBe('pnpm verify')
    expect(shellCommandOf('sh -c ls')).toBe('ls')
  })

  it('keeps a command that is not a shell wrapper', () => {
    expect(shellCommandOf('git log --oneline -3')).toBe('git log --oneline -3')
    expect(shellCommandOf('rg -n "shell" packages')).toBe('rg -n "shell" packages')
  })

  /** Unwrapping here would leave a command that no longer parses. */
  it('leaves the quotes when they are not the outermost pair', () => {
    expect(shellCommandOf(`/bin/zsh -lc 'echo 'hi' there'`)).toBe(`'echo 'hi' there'`)
  })
})

describe('toolWords on a camel-case identifier', () => {
  it('reads AskUserQuestion as words, the way web_fetch already is', () => {
    expect(toolWords('AskUserQuestion')).toBe('Ask user question')
    expect(toolWords('mcp__harnessdesk__web_fetch')).toBe('Web fetch')
    expect(toolWords('NotebookEdit')).toBe('Notebook edit')
  })
})

describe('a plan tool', () => {
  // DeepSeek Harness's own todo tool is called `todo_write` — the name
  // HarnessDesk's own todo plugin registers — so the lookup answered with the
  // plugin's description, a sentence about a tool that was never called.
  const sentences = toolSentences([
    tool('todo', 'todo_write', 'Write the task list for this conversation. Send the whole list every time.'),
  ])

  it('is recognised by every agent’s spelling, and nothing else', () => {
    for (const name of ['todo_write', 'TodoWrite', 'update_plan', 'create_plan', 'mcp__harnessdesk__todo_write']) {
      expect(isPlanTool(name)).toBe(true)
    }
    for (const name of ['todos_read', 'planner_status', 'Read README.md', 'bash']) {
      expect(isPlanTool(name)).toBe(false)
    }
  })

  it('reads as the plan it set, never as a plugin’s description of a namesake', () => {
    expect(toolSentence('todo_write', sentences, { kind: 'plan' })).toBe('Updated the plan')
  })
})
