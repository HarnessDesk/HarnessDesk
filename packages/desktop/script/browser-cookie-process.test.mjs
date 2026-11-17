import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = fileURLToPath(new URL('./browser-cookie-persistence.mjs', import.meta.url))
const present = pid => { try { process.kill(-pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const nodeFixture = (original, child) => {
  // The synthetic executable is Node, not Electron: only Electron accepts
  // --no-sandbox. Production still passes its normal Linux argument.
  const args = "...(process.platform === 'linux' ? ['--no-sandbox'] : []), fixture"
  assert.ok(original.includes(args), 'the Electron argument site must still match')
  return original.replace("import electron from 'electron'", 'const electron = process.execPath')
    .replace("const fixture = fileURLToPath(new URL('./fixtures/browser-cookie-child.mjs', import.meta.url))", `const fixture = ${JSON.stringify(child)}`)
    .replace(args, 'fixture')
}

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
  const altered = nodeFixture(original, child)
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
  const altered = nodeFixture(original, child)
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
  await writeFile(wrapper, nodeFixture(original, child))
  const running = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir } })
  let output = ''; running.stdout.on('data', c => { output += c }); running.stderr.on('data', c => { output += c })
  const result = await new Promise((resolve, reject) => { running.once('error', reject); running.once('close', (code, signal) => resolve({ code, signal })) })
  const observed = JSON.parse(await readFile(marker, 'utf8')); group = observed.group
  assert.notEqual(result.code, 0)
  assert.match(output, /left an owned process group/)
  assert.equal(present(group), false)
  await assert.rejects(access(observed.profile), { code: 'ENOENT' })
})

test('a naturally exiting owned helper settles without a signal before profile removal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-cookie-natural-'))
  const exits = join(dir, 'exits.ndjson'), probes = join(dir, 'probes.ndjson'), signals = join(dir, 'signals.ndjson')
  const helper = join(dir, 'helper.mjs'), child = join(dir, 'child.mjs'), wrapper = join(dir, 'wrapper.mjs'), preload = join(dir, 'probe.mjs')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(helper, `import {appendFileSync,existsSync} from 'node:fs';const gate=${JSON.stringify(dir)}+'/gate-'+process.env.HD_COOKIE_PHASE;const timer=setInterval(()=>{if(!existsSync(gate))return;clearInterval(timer);appendFileSync(${JSON.stringify(exits)},JSON.stringify({phase:process.env.HD_COOKIE_PHASE,profileExists:existsSync(process.env.HD_COOKIE_PROFILE),profile:process.env.HD_COOKIE_PROFILE})+'\\n');process.exit(0)},5);process.send('ready')\n`)
  await writeFile(child, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(dir)}+'/group-'+process.pid+'.json',JSON.stringify({phase:process.env.HD_COOKIE_PHASE}));const h=spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:['ignore','ignore','ignore','ipc'],env:process.env});h.once('message',()=>process.exit(0))\n`)
  await writeFile(preload, `import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';const original=process.kill.bind(process);process.kill=(pid,signal)=>{if(pid<0&&(signal==='SIGTERM'||signal==='SIGKILL'))appendFileSync(${JSON.stringify(signals)},JSON.stringify({pid,signal})+'\\n');const result=original(pid,signal);if(pid<0&&signal===0){let absent=false;try{original(-pid,0)}catch(error){if(error.code==='ESRCH')absent=true;else throw error}const path=${JSON.stringify(dir)}+'/group-'+(-pid)+'.json';if(absent&&existsSync(path)){const {phase}=JSON.parse(readFileSync(path,'utf8'));const gate=${JSON.stringify(dir)}+'/gate-'+phase;if(!existsSync(gate)){appendFileSync(${JSON.stringify(probes)},JSON.stringify({phase,groupPresent:true,leaderAbsent:true})+'\\n');writeFileSync(gate,'release')}}}return result}\n`)
  await writeFile(wrapper, nodeFixture(await readFile(source, 'utf8'), child))
  const running = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir, NODE_OPTIONS: `--import=${preload}` } })
  let output = ''; running.stdout.on('data', c => { output += c }); running.stderr.on('data', c => { output += c })
  const result = await new Promise((resolve, reject) => { running.once('error', reject); running.once('close', (code, signal) => resolve({ code, signal })) })
  const observed = (await readFile(probes, 'utf8')).trim().split('\n').map(JSON.parse)
  console.log('Natural-helper real probe evidence:', JSON.stringify(observed))
  assert.equal(result.code, 0, output)
  await assert.rejects(access(signals), { code: 'ENOENT' }, 'the natural helper must not be signalled')
  assert.deepEqual(observed, [
    { phase: 'write', groupPresent: true, leaderAbsent: true },
    { phase: 'read', groupPresent: true, leaderAbsent: true },
  ])
  const records = (await readFile(exits, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(one => one.phase), ['write', 'read'])
  assert.ok(records.every(one => one.profileExists), 'the profile remains until each helper exits')
  await assert.rejects(access(records[0].profile), { code: 'ENOENT' })
})
