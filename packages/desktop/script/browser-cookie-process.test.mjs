import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = fileURLToPath(new URL('./browser-cookie-persistence.mjs', import.meta.url))
const present = pid => { try { process.kill(-pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

test('an exited phase reaps its surviving owned helper before removing the profile and still fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-cookie-owned-test-'))
  const marker = join(dir, 'owned.json'), shutdown = join(dir, 'shutdown.json')
  const helper = join(dir, 'helper.mjs'), child = join(dir, 'child.mjs'), wrapper = join(dir, 'wrapper.mjs')
  let group
  t.after(async () => {
    if (group && present(group)) { try { process.kill(-group, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') throw e } }
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(helper, `import {existsSync,writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(shutdown)},JSON.stringify({profileExists:existsSync(process.env.HD_COOKIE_PROFILE)}));process.exit(0)});setInterval(()=>{},1000)\n`)
  await writeFile(child, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const h=spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:'ignore',env:process.env});writeFileSync(${JSON.stringify(marker)},JSON.stringify({group:process.pid,helper:h.pid,profile:process.env.HD_COOKIE_PROFILE}));setTimeout(()=>process.exit(0),200)\n`)
  const original = await readFile(source, 'utf8')
  const altered = original.replace("import electron from 'electron'", 'const electron = process.execPath')
    .replace("const fixture = fileURLToPath(new URL('./fixtures/browser-cookie-child.mjs', import.meta.url))", `const fixture = ${JSON.stringify(child)}`)
  assert.notEqual(altered, original)
  await writeFile(wrapper, altered)
  const processUnderTest = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir } })
  let output = ''; processUnderTest.stdout.on('data', chunk => { output += chunk }); processUnderTest.stderr.on('data', chunk => { output += chunk })
  const result = await new Promise((resolve, reject) => { processUnderTest.once('error', reject); processUnderTest.once('close', (code, signal) => resolve({ code, signal })) })
  const observed = JSON.parse(await readFile(marker, 'utf8')); group = observed.group
  assert.notEqual(result.code, 0, 'a surviving helper is still a failing proof')
  assert.match(output, /left an owned process group/)
  assert.equal(present(group), false, 'the owned process group is gone before the wrapper exits')
  const stopped = JSON.parse(await readFile(shutdown, 'utf8'))
  assert.equal(stopped.profileExists, true, 'the profile is retained until the helper stops')
  await assert.rejects(access(observed.profile), { code: 'ENOENT' })
})

test('when owned group retirement cannot be proven, cleanup fails and keeps the profile', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-cookie-fail-closed-'))
  const marker = join(dir, 'owned.json'), helper = join(dir, 'helper.mjs'), child = join(dir, 'child.mjs')
  const preload = join(dir, 'fail-signals.mjs'), wrapper = join(dir, 'wrapper.mjs')
  let group
  t.after(async () => {
    if (group && present(group)) { try { process.kill(-group, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') throw e } }
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(helper, 'setInterval(()=>{},1000)\n')
  await writeFile(child, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const h=spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:'ignore',env:process.env});writeFileSync(${JSON.stringify(marker)},JSON.stringify({group:process.pid,helper:h.pid,profile:process.env.HD_COOKIE_PROFILE}));setTimeout(()=>process.exit(0),200)\n`)
  await writeFile(preload, `const kill=process.kill.bind(process);process.kill=(pid,signal)=>{if(pid<0&&(signal==='SIGTERM'||signal==='SIGKILL')){const e=new Error('synthetic signal denial');e.code='EPERM';throw e}return kill(pid,signal)}\n`)
  const original = await readFile(source, 'utf8')
  const altered = original.replace("import electron from 'electron'", 'const electron = process.execPath')
    .replace("const fixture = fileURLToPath(new URL('./fixtures/browser-cookie-child.mjs', import.meta.url))", `const fixture = ${JSON.stringify(child)}`)
  await writeFile(wrapper, altered)
  const running = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir, NODE_OPTIONS: `--import=${preload}` } })
  let output = ''; running.stdout.on('data', c => { output += c }); running.stderr.on('data', c => { output += c })
  const result = await new Promise((resolve, reject) => { running.once('error', reject); running.once('close', (code, signal) => resolve({ code, signal })) })
  const observed = JSON.parse(await readFile(marker, 'utf8')); group = observed.group
  assert.notEqual(result.code, 0)
  assert.match(output, /synthetic signal denial/)
  assert.equal(present(group), true, 'the injected denial left the owned group alive')
  await access(observed.profile)
})

test('an owned helper ignoring TERM is killed, while the original leak still fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-cookie-kill-'))
  const marker = join(dir, 'owned.json'), helper = join(dir, 'helper.mjs'), child = join(dir, 'child.mjs'), wrapper = join(dir, 'wrapper.mjs')
  let group
  t.after(async () => {
    if (group && present(group)) { try { process.kill(-group, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') throw e } }
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(helper, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\n")
  await writeFile(child, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const h=spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:'ignore',env:process.env});writeFileSync(${JSON.stringify(marker)},JSON.stringify({group:process.pid,helper:h.pid,profile:process.env.HD_COOKIE_PROFILE}));setTimeout(()=>process.exit(0),200)\n`)
  const original = await readFile(source, 'utf8')
  await writeFile(wrapper, original.replace("import electron from 'electron'", 'const electron = process.execPath')
    .replace("const fixture = fileURLToPath(new URL('./fixtures/browser-cookie-child.mjs', import.meta.url))", `const fixture = ${JSON.stringify(child)}`))
  const running = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir } })
  let output = ''; running.stdout.on('data', c => { output += c }); running.stderr.on('data', c => { output += c })
  const result = await new Promise((resolve, reject) => { running.once('error', reject); running.once('close', (code, signal) => resolve({ code, signal })) })
  const observed = JSON.parse(await readFile(marker, 'utf8')); group = observed.group
  assert.notEqual(result.code, 0)
  assert.match(output, /left an owned process group/)
  assert.equal(present(group), false)
  await assert.rejects(access(observed.profile), { code: 'ENOENT' })
})
