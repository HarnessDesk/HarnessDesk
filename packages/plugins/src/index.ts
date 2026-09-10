/**
 * `@harnessdesk/plugins` — the built-in plugins.
 *
 * These use the same context, the same manifest, and the same permission gate as
 * any third-party plugin. Keeping HarnessDesk's own features on that path is what
 * stops the extension API from quietly rotting.
 *
 * Several are ports of DeepSeek Harness plugins onto HarnessDesk capabilities.
 * The ones deliberately *not* ported are those where the runtime already does the
 * job better: Codex has its own sandboxed shell, its own patch application, and
 * its own background terminals, and a plugin reimplementation would be a worse
 * duplicate competing with the real thing.
 */

import type { HarnessPlugin } from '@harnessdesk/cordis-host'

import { checkpointPlugin } from './checkpoint.js'
import { filesPlugin } from './files.js'
import { gitPlugin } from './git.js'
import { guardrailsPlugin } from './guardrails.js'
import { searchPlugin } from './search.js'
import { teamPlugin } from './team.js'
import { todoPlugin } from './todo.js'
import { webPlugin } from './web.js'
import { simulatorPlugin } from './simulator.js'
import { androidPlugin } from './android.js'
import { browserPlugin } from './browser.js'
import { testsPlugin } from './tests.js'

export { checkpointPlugin, recoveryHint, type Checkpoint } from './checkpoint.js'
export { filesPlugin } from './files.js'
export { DEFAULT_REVIEW_SIGNATURE, DEFAULT_SIGNATURE, gitPlugin, renderSignature, signBody, signatureMatcher } from './git.js'
export { callSignature, guardrailsPlugin } from './guardrails.js'
export { searchPlugin } from './search.js'
export { renderTodos, todoPlugin, type TodoItem, type TodoStatus } from './todo.js'
export { teamPlugin } from './team.js'
export { htmlToText, webPlugin } from './web.js'
export { simulatorPlugin } from './simulator.js'
export { androidPlugin } from './android.js'
export { browserPlugin } from './browser.js'
export { detectFramework, extractFailures, testsPlugin } from './tests.js'

export const builtinPlugins: readonly HarnessPlugin[] = [
  gitPlugin,
  filesPlugin,
  searchPlugin,
  todoPlugin,
  teamPlugin,
  checkpointPlugin,
  guardrailsPlugin,
  webPlugin,
  browserPlugin,
  simulatorPlugin,
  androidPlugin,
  testsPlugin,
]
