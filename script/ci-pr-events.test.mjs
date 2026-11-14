import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const job = name => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1] ?? ''
const event = (over = {}) => ({ workflow: 'CI', event_name: 'pull_request', ref: 'refs/pull/42/merge', head_ref: 'feature/topic', sha: 'merge-sha', run_id: 10,
  event: { action: 'synchronize', pull_request: { number: 42, head: { sha: 'head-sha' }, labels: [] } }, ...over })
const evaluate = (expression, github) => runInNewContext(expression.replaceAll('labels.*.name', 'labels.map(label => label.name)'), {
  github, contains: (list, value) => list?.includes(value), startsWith: (value, prefix) => value?.startsWith(prefix), always: () => true,
})
const group = github => workflow.match(/^  group: (.+)$/m)?.[1].replace(/\$\{\{(.*?)\}\}/g, (_, expression) => evaluate(expression, github))
const condition = name => job(name).match(/^    if: (.+)$/m)?.[1]?.replace(/^\$\{\{\s*|\s*\}\}$/g, '')

test('full-ci labels run the PR workflow directly without branch dispatch authority', () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled\]/)
  assert.equal(existsSync(new URL('../.github/workflows/full-ci-label.yml', import.meta.url)), false)
  assert.equal(existsSync(new URL('./full-ci-label.mjs', import.meta.url)), false)
})

test('same-head full-ci label and synchronize events use one concurrency group', () => {
  const sync = event()
  sync.event.pull_request.labels = [{ name: 'full-ci' }]
  const label = structuredClone(sync)
  label.event.action = 'labeled'
  label.event.label = { name: 'full-ci' }
  label.run_id++
  assert.equal(group(sync), group(label))
  assert.notEqual(group(sync), group(event()), 'scoped events cannot cancel explicit full proof')
  const moved = structuredClone(sync)
  moved.event.pull_request.head.sha = 'new-head'
  assert.notEqual(group(sync), group(moved))
})

test('unrelated labels neither cancel useful runs nor execute their checks', () => {
  const ignored = event()
  ignored.event.action = 'labeled'
  ignored.event.label = { name: 'documentation' }
  assert.notEqual(group(ignored), group(event()))
  for (const name of ['changes', 'runners', 'ios-native-tests', 'ui-tests', 'verify', 'ui-system-browser-integration', 'ui-system-native-integration']) {
    assert.ok(condition(name), `${name} must have an admission condition`)
    assert.equal(evaluate(condition(name), ignored), false, name)
    assert.equal(evaluate(condition(name), event()), true, name)
  }
  for (const [name, expected] of Object.entries({ changes: 'UI integration inputs', verify: 'Build, typecheck, test',
    'ui-system-browser-integration': 'UI system browser integration', 'ui-system-native-integration': 'UI system native integration',
  })) {
    const template = job(name).match(/^    name: "(.+)"$/m)?.[1]
    assert.ok(template, name)
    const render = github => template.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => evaluate(expression, github))
    assert.equal(render(event()), expected, 'admitted runs keep the required check name')
    assert.match(render(ignored), /^Label ignored:/, 'no-op check names cannot shadow authority')
  }
  assert.match(job('ci-tier'), /'Label ignored' \|\| 'CI tier'/)
})

test('development push ranges and nightly/main groups remain independent', () => {
  const first = event({ event_name: 'push', ref: 'refs/heads/development', event: {}, sha: 'first' })
  const second = { ...first, sha: 'second' }
  assert.notEqual(group(first), group(second))
  assert.notEqual(group(first), group({ ...first, event_name: 'workflow_dispatch' }))
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.ref != 'refs\/heads\/main' \}\}/)
})
