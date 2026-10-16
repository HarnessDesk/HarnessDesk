import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { splitServerSpecs } from './ci-server-split.mjs'
import { REQUIRED_CHECKS } from './land-safe.mjs'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))
  assert.ok(match, `CI must keep the ${name} job`)
  return match[1]
}

test('browser CI sizes its shards to the work, up to sixteen, with time for setup and reports (#1140)', () => {
  const browser = job('ui-system-browser')
  assert.match(browser, /^    name: UI system browser integration shard \$\{\{ matrix.shard \}\}\/\$\{\{ needs.changes.outputs.shard_count \}\}$/m)
  // The matrix is the plan's own list (one to sixteen, never empty), so the deal and the matrix cannot disagree.
  assert.match(browser, /^        shard: \$\{\{ fromJSON\(needs.changes.outputs.shards\) \}\}$/m)
  assert.match(browser, /^    timeout-minutes: 40$/m)
  // Dealt by measured time, not by Playwright's count of tests (script/ci-browser-shards.mjs):
  // every shard of a run reads the same matrix, selection and count, and an empty deal must never run the whole suite.
  assert.match(browser, /^      UI_SYSTEM_MATRIX: \$\{\{ needs.changes.outputs.matrix \}\}$/m)
  assert.match(browser, /^      UI_SYSTEM_SPECS: \$\{\{ needs.changes.outputs.browser_specs \}\}$/m)
  assert.match(browser, /^          mapfile -t specs < <\(node script\/ci-browser-shards\.mjs \$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.changes\.outputs\.shard_count \}\}\)$/m)
  assert.match(browser, /^          test "\$\{#specs\[@\]\}" -gt 0$/m)
  assert.match(browser, /^            node script\/ui-system-run\.mjs "\$\{specs\[@\]\}"$/m)
  assert.doesNotMatch(browser, /--shard=/)
  assert.match(browser, /^      fail-fast: false$/m)
})

test('the plan reaches the shards and metadata selects the tier, with manual dispatch always full', () => {
  const changes = job('changes')
  for (const output of ['browser_specs', 'matrix', 'shard_count', 'shards']) {
    assert.ok(changes.includes(`      ${output}: \${{ steps.paths.outputs.${output} }}`), output)
  }
  assert.match(workflow, /^  workflow_dispatch:$/m)
  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled, unlabeled\]/)
  assert.ok(changes.includes('CI_HEAD_BRANCH: ${{ github.head_ref }}'))
  assert.ok(changes.includes('CI_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}'))
  assert.match(changes, /UI_THEME_TOUCHED="\$theme" node script\/ci-changes\.mjs/)
  // The diff that decides it is the UI's own, between the base parent and the merge.
  assert.match(changes, /git diff --no-renames -U0 HEAD\^1 HEAD -- packages\/ui /)
})

test('the stable browser check requires every shard and keeps reports after failure (#1140)', () => {
  const aggregate = job('ui-system-browser-integration')
  assert.match(aggregate, /^    name: UI system browser integration$/m)
  assert.match(aggregate, /^    needs: \[changes, ui-system-build, ui-system-browser, ui-system-server\]$/m)
  assert.match(aggregate, /^    if: always\(\)$/m)
  assert.match(aggregate, /SHARDS_RESULT: \$\{\{ needs.ui-system-browser.result \}\}/)
  assert.match(job('ui-system-browser'), /- uses: actions\/upload-artifact@\S+\n        if: failure\(\) \|\| cancelled\(\)\n        with:\n          name: ui-system-browser-report-\$\{\{ matrix.shard \}\}/)
})

for (const [name, artifact, path] of [
  ['ui-system-build', 'ui-system-build-report', 'output/playwright/ui-system/'],
  ['ui-system-browser', 'ui-system-browser-report-${{ matrix.shard }}', 'output/playwright/ui-system/'],
  ['ui-system-server', 'ui-system-server-report', 'output/playwright/ui-system/'],
  ['ui-system-native', 'ui-system-native-report', 'output/native-ui-system/'],
]) {
  test(`${name} uploads only failed or cancelled diagnostics for three days`, () => {
    const uploads = [...job(name).matchAll(/      - uses: actions\/upload-artifact@\S+\n([\s\S]*?)(?=^      -|$(?![\s\S]))/gm)]
      .filter(([, body]) => body.includes('-report'))
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
  // Diagnostics of the three heavy jobs, and the two that carry a full run's records to the map.
  assert.equal([...workflow.matchAll(/uses: actions\/upload-artifact@/g)].length, 7)
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
  assert.match(aggregate, /^    needs: \[changes, ui-system-build, ui-system-browser, ui-system-server\]$/m)
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
          BROWSER: browser, SHARDS_RESULT: shards, SERVER_RESULT: server, CHANGES_RESULT: 'success', BUILD_RESULT: browser === 'all' ? 'success' : 'skipped',
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
  for (const [name, flag, mode] of [['ui-system-server', 'browser', 'server'], ['ui-system-native', 'native', 'true']]) {
    assert.match(job(name), /^    needs: changes$/m)
    assert.ok(job(name).includes(`    if: needs.changes.outputs.${flag} == '${mode}'`))
  }
  // The shards and the page build they serve from run together, under the same condition.
  for (const name of ['ui-system-build', 'ui-system-browser']) assert.ok(job(name).includes("    if: needs.changes.outputs.browser == 'all'\n"), name)
  assert.match(job('ui-system-native'), /^    name: UI system native smoke$/m)
  assert.match(job('ui-system-native'), /^    runs-on: macos-14$/m)
  // The gate check is the one that waits for the rest, so it must conclude
  // whatever they do: `always()`, and no other condition that could skip it.
  assert.match(job('verify'), /^    if: always\(\)$/m)
  assert.doesNotMatch(job('verify'), /^    if: (?!always\(\)$)/m)
  for (const name of REQUIRED_CHECKS) {
    assert.equal(workflow.split('\n').filter(line => line === `    name: ${name}`).length, 1, name)
  }
})

const GATE_PARTS = [['node-tests', 'NODE_TESTS_RESULT'], ['node-e2e', 'NODE_E2E_RESULT'], ['ui-tests', 'UI_TESTS_RESULT'], ['gates', 'GATES_RESULT']]

test('the gate check waits for every part of the gate and packaging waits for it', () => {
  const gate = job('verify')
  assert.match(gate, /^    name: Build, typecheck, test$/m)
  assert.match(gate, /^    needs: \[node-tests, node-e2e, ui-tests, gates\]$/m)
  assert.match(gate, /^    runs-on: ubuntu-latest$/m)
  for (const [part, key] of GATE_PARTS) {
    assert.ok(gate.includes(`${key}: \${{ needs.${part}.result }}`), key)
    // Each part builds what it runs against: none of them borrows another's checkout.
    if (part !== 'ui-tests') assert.match(job(part), /^      - name: Build\n        run: pnpm run build$/m, `${part} builds`)
    else assert.match(job(part), /^    needs: \[changes, ui-typecheck, ui-unit-tests\]$/m, 'UI tests aggregates jobs that build their own inputs')
  }
  assert.match(job('package'), /^    needs: verify$/m)
})

test('the gate check passes only when every part succeeded', () => {
  const all = Object.fromEntries(GATE_PARTS.map(([, key]) => [key, 'success']))
  assert.equal(runAggregate('verify', all).status, 0)
  for (const [part, key] of GATE_PARTS) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      const output = runAggregate('verify', { ...all, [key]: result })
      assert.equal(output.status, 1, `${part} ${result || 'missing'}: ${output.stdout} ${output.stderr}`)
      assert.match(output.stdout, new RegExp(`${part} did not succeed`))
    }
  }
})

test('changes compares the merge to its first parent and falls back on failed diff', () => {
  const changes = job('changes')
  assert.match(changes, /fetch-depth: 2/)
  assert.match(changes, /git diff --no-renames --name-only -z HEAD\^1 HEAD/)
  assert.match(changes, /if ! git diff[\s\S]*?rm -f "\$list"/)
  assert.match(changes, /node script\/ci-changes\.mjs "\$list" > "\$RUNNER_TEMP\/ci-plan"\n\s+cat "\$RUNNER_TEMP\/ci-plan" >> "\$GITHUB_OUTPUT"/)
  assert.match(changes, /browser: \$\{\{ steps\.paths\.outputs\.browser \}\}/)
  assert.match(changes, /server_specs: \$\{\{ steps\.paths\.outputs\.server_specs \}\}/)
  assert.match(changes, /native: \$\{\{ steps\.paths\.outputs\.native \}\}/)
})

test('only main pushes trigger CI; tags keep their original release path', () => {
  assert.match(workflow, /^    branches: \[main\]$/m)
  assert.doesNotMatch(workflow, /^    tags:/m)
})

test('a full run records what each spec ran, and only a pull request that runs part of the suite does not', () => {
  const changes = job('changes')
  assert.ok(changes.includes('      record: ${{ steps.paths.outputs.record }}'))
  const browser = job('ui-system-browser')
  assert.ok(browser.includes('RECORD: ${{ needs.changes.outputs.record }}'))
  assert.match(browser, /^          if \[ "\$RECORD" = "true" \]; then\n            mkdir -p output\/ui-impact\n            UI_IMPACT_DIR="\$PWD\/output\/ui-impact" pnpm test:ui-system --tsconfig script\/ui-impact\/tsconfig\.json "\$\{specs\[@\]\}"$/m)
  // The tests each spec has are listed beside the records, so a partial record is told from a complete one.
  assert.match(browser, /pnpm --silent test:ui-system --list --reporter=json "\$\{specs\[@\]\}" > "output\/ui-impact\/expected-\$UI_IMPACT_SHARD\.json"/)
  assert.match(browser, /- uses: actions\/upload-artifact@\S+\n        if: success\(\) && needs\.changes\.outputs\.record == 'true'\n        with:\n          name: ui-impact-\$\{\{ matrix\.shard \}\}\n          path: output\/ui-impact\//)
})

test('the map is made from a clean full run, kept only by main, and read by a pull request from the newest one', () => {
  const map = job('ui-impact-map')
  assert.match(map, /^    needs: \[changes, ui-system-browser\]$/m)
  assert.match(map, /^    if: needs\.changes\.outputs\.record == 'true' && needs\.ui-system-browser\.result == 'success'$/m)
  assert.match(map, /pattern: ui-impact-\*\n          path: impact-records\n          merge-multiple: true/)
  assert.match(map, /node script\/ui-impact\.mjs merge impact-records --commit "\$GITHUB_SHA" --out ui-impact-map\.json/)
  // A run whose records cannot make a map fails the job in the open: a green job that saved no map hid a broken scan.
  assert.doesNotMatch(map, /continue-on-error/)
  assert.doesNotMatch(map, /steps\.map\./)
  assert.match(map, /test -s ui-impact-map\.json/)
  assert.match(map, /actions\/upload-artifact@\S+\n        with:\n          name: ui-impact-map\n/)
  assert.match(map, /actions\/cache\/save@\S+\n        if: github\.ref == 'refs\/heads\/main'\n        with:\n          path: ui-impact-map\.json\n          key: ui-impact-map-\$\{\{ github\.sha \}\}/)
  const changes = job('changes')
  assert.match(changes, /if: github\.event_name == 'pull_request'\n        uses: actions\/cache\/restore@\S+\n        with:\n          path: ui-impact-map\.json\n          key: ui-impact-map-none\n          restore-keys: ui-impact-map-\n/)
  assert.ok(changes.includes('UI_IMPACT_MAP: ui-impact-map.json'))
  // The map job concludes nothing the merge depends on: neither aggregate waits for it.
  assert.doesNotMatch(job('ui-system-browser-integration'), /ui-impact-map/)
  assert.doesNotMatch(job('verify'), /ui-impact-map/)
})

test('a pull request runs the unit tests that depend on its change, and every other run runs them all', () => {
  const changes = job('changes'), tests = job('ui-unit-tests')
  assert.match(changes, /node script\/ci-unit-tests\.mjs "\$list"/)
  assert.match(changes, /git diff --no-renames --name-only -z HEAD\^1 HEAD > "\$list"/)
  assert.match(tests, /if: needs\.changes\.outputs\.unit_mode == 'all'/)
  assert.match(tests, /id: deal\n        if: needs.changes.outputs.unit_mode == 'all'\n        run: \|/)
  assert.match(tests, /test -s "\$deal"/)
  assert.match(tests, /UNIT_DEAL: \$\{\{ steps.deal.outputs.files \}\}\n        run: pnpm --filter @harnessdesk\/ui run test \$UNIT_DEAL\n/)
  assert.match(tests, /UNIT_FILES: \$\{\{ needs\.changes\.outputs\.unit_files \}\}/)
  assert.match(tests, /if: needs\.changes\.outputs\.unit_mode == 'related'\n        run: pnpm --filter @harnessdesk\/ui exec vitest related --run \$UNIT_FILES\n/)
})


test('one shared browser build runs for every full run; only a non-recording run serves from it', () => {
  const build = job('ui-system-build')
  assert.match(build, /^    needs: changes$/m)
  assert.ok(build.includes("    if: needs.changes.outputs.browser == 'all'\n"), 'a recording run builds too, so a broken build fails the run that broke it')
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm run build:node', 'pnpm run build:e2e']) assert.ok(build.includes(`run: ${command}`))
  assert.match(build, /actions\/upload-artifact@\S+[\s\S]*name: ui-system-pages\n          path: packages\/ui\/dist-e2e\/\n          retention-days: 1\n          if-no-files-found: error/)
  const browser = job('ui-system-browser')
  // Plain success() on both needs: a failed or cancelled build starts no shards, and nothing falls back to the dev server.
  assert.match(browser, /^    needs: \[changes, ui-system-build\]$/m)
  assert.match(browser, /^    if: needs\.changes\.outputs\.browser == 'all'$/m)
  assert.doesNotMatch(browser, /!cancelled\(\)|always\(\)/)
  assert.match(browser, /actions\/download-artifact@\S+\n        if: needs.changes.outputs.record != 'true'\n        with:\n          name: ui-system-pages\n          path: packages\/ui\/dist-e2e\//)
  assert.match(browser, /UI_SYSTEM_SERVER: dev/)
  assert.match(browser, /UI_SYSTEM_PAGES: prebuilt/)
})

test('a recording run still tries the build, with specs that the static server runs, from every built page', () => {
  const build = job('ui-system-build')
  assert.match(build, /- name: Install the browser to try the build\n        if: needs\.changes\.outputs\.record == 'true'\n        run: pnpm exec playwright install --with-deps chromium\n/)
  assert.match(build, /- name: Try the build\n        if: needs\.changes\.outputs\.record == 'true'\n        env:\n(?:          #[^\n]*\n)?          UI_SYSTEM_PAGES: prebuilt\n        run: \|\n/)
  // The pages stay the build's own: the runner does not rebuild them, and the matrix stays the small one.
  assert.match(build, /^      UI_SYSTEM_MATRIX: pr$/m)
  const root = fileURLToPath(new URL('../', import.meta.url))
  const specs = [...new Set([...build.matchAll(/e2e\/ui-system\/[\w-]+\.spec\.ts/g)].map(match => match[0]))]
  // A spec that moved to the dev server would make this a dev run that proves nothing about the build.
  assert.deepEqual(splitServerSpecs(root, specs), { static: specs, dev: [] })
  const text = specs.map(spec => readFileSync(join(root, spec), 'utf8')).join('\n')
  for (const page of ['design.html', 'narrow-overlay.html', 'preview.html']) assert.ok(text.includes(page), `no spec tries ${page}`)
  // The embedded tile page is reached through the side-by-side fixture, and its test is the one the grep picks.
  assert.ok(build.includes('e2e/ui-system/side-by-side.spec.ts --grep "two Seat browsers stay live"'))
  assert.ok(readFileSync(join(root, 'packages/ui/src/preview/side-by-side-fixture.ts'), 'utf8').includes('/src/preview/tile-page.html'))
  assert.ok(text.includes('two Seat browsers stay live'))
})

test('the aggregate requires a successful build exactly when the browser suite runs', () => {
  const aggregate = job('ui-system-browser-integration')
  assert.ok(aggregate.includes('BUILD_RESULT: ${{ needs.ui-system-build.result }}'))
  for (const browser of ['all', 'server', 'none']) {
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const output = runAggregate('ui-system-browser-integration', {
        CHANGES_RESULT: 'success', BROWSER: browser, SHARDS_RESULT: browser === 'all' ? 'success' : 'skipped',
        SERVER_RESULT: browser === 'server' ? 'success' : 'skipped', BUILD_RESULT: result,
      })
      const passes = result === (browser === 'all' ? 'success' : 'skipped')
      assert.equal(output.status, passes ? 0 : 1, `${browser}/${result}: ${output.stdout} ${output.stderr}`)
    }
  }
})
