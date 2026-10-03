import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FLOW_BOARD_TOOL_NAMES, type CapabilityContribution } from '../src/index.js'

import {
  BOARD_TOOL_PHRASES,
  bareToolName,
  boardToolPhrase,
  isPlanTool,
  shellCommandOf,
  shortestUniquePathLabels,
  toolSentence,
  toolSentences,
  toolWords,
  wireNameOf,
} from '../src/tool-names.js'

/**
 * Two agents, one tool, two spellings on the wire — and a UI that has to say
 * the same sentence for both.
 */

const tool = (namespace: string, name: string, description: string): CapabilityContribution =>
  ({ kind: 'tool', namespace, name, description, id: `${namespace}/${name}`, owner: 'p1', revision: 1, scope: 'session', inputSchema: {} }) as unknown as CapabilityContribution

describe('bareToolName', () => {
  it('recovers the registered name from either agent’s spelling', () => {
    assert.equal(bareToolName('mcp__harnessdesk__browser_open'), 'browser_open')
    assert.equal(bareToolName('browser_open'), 'browser_open')
  })
})

describe('toolWords', () => {
  it('turns an identifier back into words when nothing described it', () => {
    assert.equal(toolWords('mcp__harnessdesk__browser_click'), 'Browser click')
    assert.equal(toolWords('Write'), 'Write')
    // Claude Code's helper tools arrive as one CamelCase token.
    assert.equal(toolWords('TaskOutput'), 'Task output')
    assert.equal(toolWords('WebFetch'), 'Web fetch')
    assert.equal(toolWords('MCPServer'), 'MCPServer')
  })

  /**
   * Some adapters name a call in words already. Taking one of those apart the
   * way an identifier is taken apart turns a path into a row of nouns.
   */
  it('leaves a name that is already a phrase exactly as it is', () => {
    assert.equal(toolWords('Write /tmp/games/snake.html'), 'Write /tmp/games/snake.html')
    assert.equal(bareToolName('Edit /a/b_c/d.ts'), 'Edit /a/b_c/d.ts')
  })
})

describe('toolWords', () => {
  /**
   * Adapters wrap a command in backticks for a markdown renderer. The row is
   * not one, so without unwrapping them the transcript shows its own source.
   */
  it('unwraps the backticks an adapter meant for a renderer', () => {
    assert.equal(toolWords('`pnpm verify`'), 'pnpm verify')
    assert.equal(toolWords('`cd /w && ls`'), 'cd /w && ls')
    // A stray backtick in the middle is part of the command, not a wrapper.
    assert.equal(toolWords('echo `date`'), 'echo `date`')
  })
})

describe('toolSentence', () => {
  const sentences = toolSentences([
    tool('browser', 'browser_open', 'Open a URL in the browser and return a screenshot. A screenshot’s pixels are the coordinates a click takes.'),
  ])

  it('says what the plugin said, only the first sentence of it', () => {
    assert.equal(toolSentence('browser_open', sentences),
      'Open a URL in the browser and return a screenshot',
    )
  })

  it('says the same thing for the namespaced spelling', () => {
    assert.equal(toolSentence('mcp__harnessdesk__browser_open', sentences),
      'Open a URL in the browser and return a screenshot',
    )
  })

  it('falls back to words for a tool nobody described', () => {
    assert.equal(toolSentence('mcp__other__do_a_thing', sentences), 'Do a thing')
  })

  it('names a file that was read', () => {
    assert.equal(toolSentence('Read', sentences, { kind: 'read', target: 'retry.ts' }),
      'Read retry.ts',
    )
  })

  it('names a pattern and its folder when files were searched', () => {
    assert.equal(
      toolSentence('Grep', sentences, {
        kind: 'search',
        pattern: '50[0-9]',
        folder: 'src/checkout',
      }), 'Searched for 50[0-9] in src/checkout')
    assert.equal(toolSentence('Grep', sentences, { kind: 'search', pattern: '50[0-9]' }),
      'Searched for 50[0-9]',
    )
  })

  it('names a file that was edited', () => {
    assert.equal(toolSentence('Edit', sentences, { kind: 'fileChange', target: 'retry.ts' }),
      'Edited retry.ts',
    )
  })

  it('names a file that was created', () => {
    assert.equal(toolSentence('Write', sentences, { kind: 'fileChange', target: 'retry.ts' }),
      'Created retry.ts',
    )
  })

  it('names the command behind its shell wrapper', () => {
    assert.equal(
      toolSentence('Bash', sentences, {
        kind: 'command',
        command: shellCommandOf(`/bin/zsh -lc 'pnpm test'`),
      }), 'Ran pnpm test')
  })

  it('names a web search and its query', () => {
    assert.equal(
      toolSentence('web_search', sentences, { kind: 'webSearch', query: 'checkout retries' }), 'Searched the web for checkout retries')
  })
})

describe('shortestUniquePathLabels', () => {
  it('uses only as much of duplicate base names as tells them apart', () => {
    const labels = shortestUniquePathLabels([
      'src/checkout/retry.ts',
      'src/billing/retry.ts',
      'src/checkout/client.ts',
    ])

    assert.equal(labels.get('src/checkout/retry.ts'), 'checkout/retry.ts')
    assert.equal(labels.get('src/billing/retry.ts'), 'billing/retry.ts')
    assert.equal(labels.get('src/checkout/client.ts'), 'client.ts')
  })

  it('does not make repeated mentions of the same path look ambiguous', () => {
    const labels = shortestUniquePathLabels(['src/checkout/retry.ts', 'src/checkout/retry.ts'])
    assert.equal(labels.get('src/checkout/retry.ts'), 'retry.ts')
  })
})

describe('wireNameOf', () => {
  it('offers the identifier a permission rule would name', () => {
    assert.equal(wireNameOf('mcp__harnessdesk__browser_open'), 'mcp__harnessdesk__browser_open')
    assert.equal(wireNameOf('browser_open'), 'browser_open')
  })

  /**
   * Claude Code names a shell call with the command itself. Printing that
   * under a row that already shows it is the same sentence twice, in a box
   * whose whole reason to exist is telling you something the row could not.
   */
  it('offers nothing when the name was already the sentence', () => {
    assert.equal(wireNameOf('`cd /w/app && grep -m2 "dev" package.json`'), null)
    assert.equal(wireNameOf('Write /w/app/index.ts'), null)
    assert.equal(wireNameOf('   '), null)
  })
})

describe('shellCommandOf', () => {
  /**
   * Codex sends `/bin/zsh -lc 'echo hi'` and its own transcript says
   * `echo hi`. The login shell is how the agent runs a command, not the
   * command, and it is the same eleven characters on every single row.
   */
  it('drops the login shell the agent ran the command through', () => {
    assert.equal(shellCommandOf(`/bin/zsh -lc 'echo hi'`), 'echo hi')
    assert.equal(shellCommandOf(`/bin/bash -lc "pnpm verify"`), 'pnpm verify')
    assert.equal(shellCommandOf('sh -c ls'), 'ls')
  })

  it('keeps a command that is not a shell wrapper', () => {
    assert.equal(shellCommandOf('git log --oneline -3'), 'git log --oneline -3')
    assert.equal(shellCommandOf('rg -n "shell" packages'), 'rg -n "shell" packages')
  })

  /** Unwrapping here would leave a command that no longer parses. */
  it('leaves the quotes when they are not the outermost pair', () => {
    assert.equal(shellCommandOf(`/bin/zsh -lc 'echo 'hi' there'`), `'echo 'hi' there'`)
  })
})

describe('toolWords on a camel-case identifier', () => {
  it('reads AskUserQuestion as words, the way web_fetch already is', () => {
    assert.equal(toolWords('AskUserQuestion'), 'Ask user question')
    assert.equal(toolWords('mcp__harnessdesk__web_fetch'), 'Web fetch')
    assert.equal(toolWords('NotebookEdit'), 'Notebook edit')
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
      assert.equal(isPlanTool(name), true)
    }
    for (const name of ['todos_read', 'planner_status', 'Read README.md', 'bash']) {
      assert.equal(isPlanTool(name), false)
    }
  })

  it('reads as the plan it set, never as a plugin’s description of a namesake', () => {
    assert.equal(toolSentence('todo_write', sentences, { kind: 'plan' }), 'Updated the plan')
  })
})

describe('what a permission card says a board tool wants to do', () => {
  it('has a plain verb phrase for every board tool, and never the wire name', () => {
    for (const tool of FLOW_BOARD_TOOL_NAMES) {
      const phrase = boardToolPhrase(tool)
      assert.equal(phrase, BOARD_TOOL_PHRASES[tool], tool)
      assert.doesNotMatch(phrase, /[_`]/, tool)
      assert.doesNotMatch(phrase, /[.!?]$/, tool)
      assert.equal(phrase, phrase.trim(), tool)
      assert.equal(phrase.charAt(0), phrase.charAt(0).toLowerCase(), tool)
    }
  })

  it('reads the way the owner approved for the board listing, whatever namespace the agent used', () => {
    assert.equal(boardToolPhrase('list_intents'), "list the board's work items")
    assert.equal(boardToolPhrase('mcp__harnessdesk__list_intents'), "list the board's work items")
  })

  it('falls back to the identifier as lower-case words for a tool it has no phrase for, never the wire name', () => {
    assert.equal(boardToolPhrase('archive_everything'), 'archive everything')
  })
})
