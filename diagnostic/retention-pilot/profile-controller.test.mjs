import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const controller=fileURLToPath(new URL('./automatic-profile.mjs',import.meta.url))
test('profile refuses to launch outside hosted macOS', () => {
 if(process.platform==='darwin'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')return
 const result=spawnSync(process.execPath,[controller],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000})
 assert.notEqual(result.status,0)
 assert.match(result.stderr,/hosted macOS runner required/)
})
test('profile preserves automatic policy and single-chat workflow default', () => {
 const source=readFileSync(controller,'utf8')
 assert.doesNotMatch(source,/\.unloadTranscript\s*\(|\.disableTranscriptCache\s*\(|\.prepareTranscriptPressure\s*\(/)
 assert.match(source,/\[0,128,200,400\]/)
 const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8')
 assert.match(workflow,/default: one-chat/)
 assert.match(workflow,/inputs\.profile == 'automatic-profile'/)
})
