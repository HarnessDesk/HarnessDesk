import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { REQUIRED_CHECKS } from './land-safe.mjs'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))
  assert.ok(match, `CI must keep the ${name} job`)
  return match[1]
}

test('browser CI spreads the suite across six shards with time for setup and reports (#1140)', () => {
  const browser = job('ui-system-browser')
  assert.match(browser, /^    name: UI system browser integration shard \$\{\{ matrix.shard \}\}\/6$/m)
  assert.match(browser, /^        shard: \[1, 2, 3, 4, 5, 6\]$/m)
  assert.match(browser, /^    timeout-minutes: 30$/m)
  assert.match(browser, /^      - run: pnpm test:ui-system --shard=\$\{\{ matrix.shard \}\}\/6$/m)
  assert.match(browser, /^      fail-fast: false$/m)
})

test('the stable browser check requires every shard and keeps reports after failure (#1140)', () => {
  const aggregate = job('ui-system-browser-integration')
  assert.match(aggregate, /^    name: UI system browser integration$/m)
  assert.match(aggregate, /^    needs: \[changes, ui-system-browser, ui-system-server\]$/m)
  assert.match(aggregate, /^    if: always\(\)$/m)
  assert.match(aggregate, /SHARDS_RESULT: \$\{\{ needs.ui-system-browser.result \}\}/)
  assert.match(job('ui-system-browser'), /- uses: actions\/upload-artifact@\S+\n        if: failure\(\) \|\| cancelled\(\)\n        with:\n          name: ui-system-browser-report-\$\{\{ matrix.shard \}\}/)
})

for (const [name, artifact, path] of [
  ['ui-system-browser', 'ui-system-browser-report-${{ matrix.shard }}', 'output/playwright/ui-system/'],
  ['ui-system-server', 'ui-system-server-report', 'output/playwright/ui-system/'],
  ['ui-system-native', 'ui-system-native-report', 'output/native-ui-system/'],
]) {
  test(`${name} uploads only failed or cancelled diagnostics for three days`, () => {
    const uploads = [...job(name).matchAll(/      - uses: actions\/upload-artifact@\S+\n([\s\S]*?)(?=^      -|$(?![\s\S]))/gm)]
    assert.equal(uploads.length, 1)
    const upload = uploads[0][1]
    assert.match(upload, /^        if: failure\(\) \|\| cancelled\(\)$/m)
    assert.ok(upload.includes(`          name: ${artifact}\n`))
    assert.ok(upload.includes(`          path: ${path}\n`))
    assert.match(upload, /^          retention-days: 3$/m)
  })
}

test('unsigned packaging proves the app builds without retaining an unused bundle', () => {
  const packaging = job('package')
  assert.match(packaging, /name: Build app bundle/)
  assert.match(packaging, /electron-builder --mac dir/)
  assert.doesNotMatch(packaging, /actions\/upload-artifact@|HarnessDesk-unsigned/)
  assert.equal([...workflow.matchAll(/uses: actions\/upload-artifact@/g)].length, 3)
})

// Execute the workflow's actual shell, so the required checks cannot report
// green for a cancelled job or a skip that the path decision did not request.
const runAggregate = (name, env) => {
  const block = job(name).match(/        run: \|\n([\s\S]*?)(?=^      -|$(?![\s\S]))/m)
  assert.ok(block, `${name} must run a conclusive check`)
  return spawnSync('bash', ['-e', '-c', block[1]], { encoding: 'utf8', env: { ...process.env, ...env } })
}

for (const [name, resultKey, flagKey, heavy] of [
  ['ui-system-native-integration', 'SMOKE_RESULT', 'NATIVE', 'ui-system-native'],
]) {
  test(`${name} always concludes and receives the decision and heavy-job result`, () => {
    const aggregate = job(name)
    assert.match(aggregate, new RegExp(`^    needs: \\[changes, ${heavy}\\]$`, 'm'))
    assert.match(aggregate, /^    if: always\(\)$/m)
    assert.match(aggregate, /^    runs-on: ubuntu-latest$/m)
    assert.ok(aggregate.includes(`${flagKey}: \${{ needs.changes.outputs.${flagKey.toLowerCase()} }}`))
    assert.ok(aggregate.includes(`${resultKey}: \${{ needs.${heavy}.result }}`))
    assert.ok(aggregate.includes('CHANGES_RESULT: ${{ needs.changes.result }}'))
  })
  test(`${name} only accepts success or an intentional skip`, () => {
    for (const requested of ['true', 'false', '']) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const output = runAggregate(name, { [resultKey]: result, [flagKey]: requested, CHANGES_RESULT: 'success' })
        const passes = result === 'success' || (result === 'skipped' && requested === 'false')
        assert.equal(output.status, passes ? 0 : 1, `${requested}/${result}: ${output.stdout} ${output.stderr}`)
      }
    }
  })
  test(`${name} refuses a failed, cancelled or skipped changes job`, () => {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      const output = runAggregate(name, { [resultKey]: 'skipped', [flagKey]: 'false', CHANGES_RESULT: result })
      assert.equal(output.status, 1, output.stdout + output.stderr)
    }
  })
}

test('browser aggregate receives both results and the three-way decision', () => {
  const aggregate = job('ui-system-browser-integration')
  assert.match(aggregate, /^    needs: \[changes, ui-system-browser, ui-system-server\]$/m)
  assert.match(aggregate, /^    if: always\(\)$/m)
  for (const line of [
    'BROWSER: ${{ needs.changes.outputs.browser }}',
    'SERVER_RESULT: ${{ needs.ui-system-server.result }}',
    'SHARDS_RESULT: ${{ needs.ui-system-browser.result }}',
    'CHANGES_RESULT: ${{ needs.changes.result }}',
  ]) assert.ok(aggregate.includes(line), line)
})

test('browser aggregate accepts only the exact result pair requested', () => {
  for (const browser of ['all', 'server', 'none', '', 'true']) {
    for (const shards of ['success', 'failure', 'cancelled', 'skipped', '']) {
      for (const server of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const passes = (browser === 'all' && shards === 'success' && server === 'skipped')
          || (browser === 'server' && shards === 'skipped' && server === 'success')
          || (browser === 'none' && shards === 'skipped' && server === 'skipped')
        const output = runAggregate('ui-system-browser-integration', {
          BROWSER: browser, SHARDS_RESULT: shards, SERVER_RESULT: server, CHANGES_RESULT: 'success',
        })
        assert.equal(output.status, passes ? 0 : 1, `${browser}/${shards}/${server}: ${output.stdout} ${output.stderr}`)
      }
    }
  }
})

test('browser aggregate refuses failed input selection even with successful tests', () => {
  for (const changes of ['failure', 'cancelled', 'skipped', '']) {
    const output = runAggregate('ui-system-browser-integration', {
      BROWSER: 'server', SHARDS_RESULT: 'skipped', SERVER_RESULT: 'success', CHANGES_RESULT: changes,
    })
    assert.equal(output.status, 1, output.stdout + output.stderr)
  }
})

test('server specs run in one Ubuntu job using the discovered paths', () => {
  const server = job('ui-system-server')
  assert.match(server, /^    runs-on: ubuntu-latest$/m)
  assert.doesNotMatch(server, /matrix:|--shard=/)
  assert.match(server, /pnpm install --frozen-lockfile/)
  assert.match(server, /pnpm run build:node/)
  assert.match(server, /pnpm exec playwright install --with-deps chromium/)
  assert.ok(server.includes('SERVER_SPECS: ${{ needs.changes.outputs.server_specs }}'))
  assert.match(server, /pnpm test:ui-system "\$\{specs\[@\]\}"/)
  assert.match(server, /JSON\.parse\(process\.env\.SERVER_SPECS\)/)
  assert.match(server, /actions\/upload-artifact@/)
})

test('only heavy UI jobs are conditional; required check names stay conclusive', () => {
  for (const [name, flag, mode] of [['ui-system-browser', 'browser', 'all'], ['ui-system-server', 'browser', 'server'], ['ui-system-native', 'native', 'true']]) {
    assert.match(job(name), /^    needs: changes$/m)
    assert.ok(job(name).includes(`    if: needs.changes.outputs.${flag} == '${mode}'`))
  }
  assert.match(job('ui-system-native'), /^    name: UI system native smoke$/m)
  assert.match(job('ui-system-native'), /^    runs-on: macos-14$/m)
  assert.doesNotMatch(job('verify'), /^    (?:if|needs):/m)
  for (const name of REQUIRED_CHECKS) {
    assert.equal(workflow.split('\n').filter(line => line === `    name: ${name}`).length, 1, name)
  }
})

test('changes compares the merge to its first parent and falls back on failed diff', () => {
  const changes = job('changes')
  assert.match(changes, /fetch-depth: 2/)
  assert.match(changes, /git diff --no-renames --name-only -z HEAD\^1 HEAD/)
  assert.match(changes, /if ! git diff[\s\S]*?rm -f "\$list"/)
  assert.match(changes, /node script\/ci-changes\.mjs "\$list" >> "\$GITHUB_OUTPUT"/)
  assert.match(changes, /browser: \$\{\{ steps\.paths\.outputs\.browser \}\}/)
  assert.match(changes, /server_specs: \$\{\{ steps\.paths\.outputs\.server_specs \}\}/)
  assert.match(changes, /native: \$\{\{ steps\.paths\.outputs\.native \}\}/)
})

test('only main pushes trigger CI; tags keep their original release path', () => {
  assert.match(workflow, /^    branches: \[main\]$/m)
  assert.doesNotMatch(workflow, /^    tags:/m)
})
