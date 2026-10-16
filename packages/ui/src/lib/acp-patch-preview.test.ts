import { describe, expect, it } from 'vitest'
import { itemId, type ToolCallItem } from '@harnessdesk/protocol'
import { projectToolItem } from '../../../adapter-acp/src/tool-items'
import { countChanges, parseDiff } from '../editor'

const patch = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1,2 +1,2 @@\n context\n-return a - b\n+return a + b\n'

describe('input-only ACP patch previews', () => {
  for (const key of ['diff', 'patch', 'content']) {
    it(`draws ${key} as a replacement without patch headers`, () => {
      const call: ToolCallItem = {
        id: itemId('edit'), type: 'toolCall', tool: 'Edit', source: { kind: 'builtin' },
        status: 'completed', args: { file_path: 'app.js', [key]: patch },
      }
      const { item } = projectToolItem(call, { toolCallId: 'edit', kind: 'edit' }, undefined, '/workspace')
      expect(item.type).toBe('fileChange')
      if (item.type !== 'fileChange') throw new Error('expected a file-change preview')
      const change = item.changes[0]!
      expect(change.kind.type).toBe('update')
      expect(countChanges(change.diff)).toEqual({ added: 1, removed: 1 })
      expect(parseDiff(change.diff).map(({ kind, text }) => [kind, text])).toEqual([
        ['context', 'context'], ['remove', 'return a - b'], ['add', 'return a + b'],
      ])
      expect(change.diff).not.toContain('@@')
    })
  }
})
