import type { ConfigOption } from '@harnessdesk/protocol'

const permissionMode: ConfigOption = {
  id: 'mode', type: 'select', category: '_permissions', label: 'Mode', description: 'Session permission mode',
  currentValue: 'acceptEdits', collaboration: { planValue: 'plan', actValue: 'acceptEdits' },
  choices: [{ value: 'default', label: 'Manual' }, { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'plan', label: 'Plan' }, { value: 'auto', label: 'Auto' }, { value: 'bypassPermissions', label: 'Bypass permissions' }],
}
export const permissionVariants = [
  { name: 'Codex', model: 'GPT-6.1 Sol', options: [
    { id: 'permissions', type: 'select', category: '_permissions', label: 'Permissions', currentValue: 'workspace',
      choices: [{ value: 'workspace', label: 'Workspace write' }, { value: 'full', label: 'Full access', risk: 'high' }] },
    { id: 'mode', type: 'select', category: 'mode', label: 'Mode', currentValue: 'default',
      choices: [{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }] },
  ] as ConfigOption[] },
  { name: 'Claude Code', model: 'Opus 5', options: [permissionMode] },
  { name: 'Cursor', model: 'Composer 2', options: [
    { id: 'auto_approve', type: 'boolean', category: '_permissions', label: 'Auto-approve', currentValue: false },
  ] as ConfigOption[] },
]
