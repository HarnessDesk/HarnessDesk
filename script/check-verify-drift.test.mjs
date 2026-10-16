import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { ciCommands, missingFromCI } from './check-verify-drift.mjs'

const unit = { command: 'pnpm', args: ['--filter', '@harnessdesk/ui', 'run', 'test'] }
const command = 'pnpm --filter @harnessdesk/ui run test'

// Dealt filenames stand for the whole suite only in the unconditional,
// single-line command. Comments and unevaluated shell text cannot supply it.
test('only the exact UI unit command with UNIT_DEAL stands for the local whole suite', () => {
  assert.deepEqual(missingFromCI([unit], ciCommands(`steps:\n  - run: ${command} $UNIT_DEAL\n`)), [])
  for (const suffix of ['src/a.test.ts', '--passWithNoTests', '$UNIT_FILES', '$OTHER', '${files[@]}', '$UNIT_DEAL --passWithNoTests']) {
    assert.deepEqual(missingFromCI([unit], ciCommands(`steps:\n  - run: ${command} ${suffix}\n`)), [command], suffix)
  }
  assert.deepEqual(missingFromCI([{ command: 'pnpm', args: ['run'] }], ciCommands('steps:\n  - run: pnpm run build\n')), ['pnpm run'])
  assert.deepEqual(missingFromCI([unit], ciCommands(`steps:\n  # run: ${command} $UNIT_DEAL\n  - run: echo done\n`)), [command])
})

for (const suffix of ['', ' $UNIT_DEAL']) {
  for (const [name, shell] of [
    ['literal block', `${command}${suffix}\necho done`],
    ['heredoc', `cat <<'END'\n${command}${suffix}\nEND`],
    ['if false block', `if false; then\n${command}${suffix}\nfi`],
    ...(suffix ? [['single-line literal block', `${command}${suffix}`]] : []),
  ]) {
    test(`${name} cannot satisfy unit parity${suffix}`, () => {
      const workflow = `steps:\n  - run: |\n${shell.split('\n').map(line => `      ${line}`).join('\n')}\n`
      assert.deepEqual(missingFromCI([unit], ciCommands(workflow)), [command])
    })
  }
}

test('a folded block cannot receive the single-line UNIT_DEAL allowance', () => {
  assert.deepEqual(missingFromCI([unit], ciCommands(`steps:\n  - run: >\n      ${command} $UNIT_DEAL\n`)), [command])
})

test('CI keeps the tier selection, label trigger and visible landing proof wired together', async () => {
  const { readFileSync } = await import('node:fs')
  const { tierProblems } = await import('./check-verify-drift.mjs')
  assert.equal(typeof tierProblems, 'function')
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.deepEqual(tierProblems(workflow), [])
  for (const token of [
    'types: [opened, synchronize, reopened]',
    'CI_HEAD_BRANCH: ${{ github.head_ref }}',
    'CI_REF_NAME: ${{ github.ref_name }}',
    'branches: [main, development]',
    'CI_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}',
    'tier: ${{ steps.paths.outputs.tier }}',
    'name: UI integration inputs',
    'name: "CI tier: ${{ needs.changes.outputs.tier }}"',
    'UI_SYSTEM_MATRIX: ${{ needs.changes.outputs.matrix }}',
  ]) {
    assert.ok(workflow.includes(token), token)
    assert.ok(tierProblems(workflow.replaceAll(token, '# removed')).length > 0, token)
  }
})

test('nightly development dispatches full CI only when the branch exists', () => {
  const workflow = readFileSync(new URL('../.github/workflows/nightly-development.yml', import.meta.url), 'utf8')
  assert.match(workflow, /cron: ['"]0 11 \* \* \*['"]/)
  for (const token of ['workflow_dispatch:', 'actions: write', 'contents: read', 'GH_TOKEN: ${{ github.token }}', 'GH_REPO: ${{ github.repository }}']) {
    assert.ok(workflow.includes(token), token)
  }
  const shell = workflow.split('        run: |\n')[1]?.split('\n').filter(Boolean).map(line => line.slice(10)).join('\n')
  assert.ok(shell, 'nightly dispatch shell')
  const directory = mkdtempSync(join(tmpdir(), 'nightly-development-'))
  try {
    const fake = join(directory, 'gh')
    const calls = join(directory, 'calls')
    writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'api') {
  if (args[1] !== 'repos/acme/widgets/git/matching-refs/heads/development' || args[2] !== '--jq' || args[3] !== 'any(.[]; .ref == "refs/heads/development")') process.exit(9)
  if (process.env.BRANCH_EXISTS === 'error') process.exit(7)
  process.stdout.write(process.env.BRANCH_EXISTS)
} else {
  require('node:fs').writeFileSync(process.env.CALLS, JSON.stringify(args))
}
`)
    chmodSync(fake, 0o755)
    for (const exists of ['false', 'true', 'error']) {
      rmSync(calls, { force: true })
      const result = spawnSync('bash', ['-e', '-c', shell], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, GH_REPO: 'acme/widgets', BRANCH_EXISTS: exists, CALLS: calls } })
      assert.equal(result.status, exists === 'error' ? 7 : 0, result.stderr)
      if (exists === 'true') assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), ['workflow', 'run', 'ci.yml', '--ref', 'development'])
      else assert.throws(() => readFileSync(calls), { code: 'ENOENT' })
      if (exists === 'false') assert.equal(result.stdout, '')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
