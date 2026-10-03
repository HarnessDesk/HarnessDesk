import { expect, it } from 'vitest'
import { bareToolName, shellCommandLineOf, toolSentence } from '@harnessdesk/protocol'
import * as names from './tool-names'

it('re-exports the shared lookup and preserves the string shell helper API', () => {
  expect(names.bareToolName).toBe(bareToolName)
  expect(names.toolSentence).toBe(toolSentence)
  expect(names.shellCommandOf).toBe(shellCommandLineOf)
  expect(names.shellCommandOf("sh -c 'echo hi'")).toBe('echo hi')
})
