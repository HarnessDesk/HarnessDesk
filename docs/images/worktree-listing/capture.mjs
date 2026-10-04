import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const repo = process.cwd()
const require = createRequire(join(repo, 'package.json'))
const { chromium } = require('@playwright/test')
const ts = require('@typescript/typescript6')
const scratch = realpathSync('/tmp/review-1373')
const output = join(scratch, 'frames')
mkdirSync(output, {recursive:true})
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding:'utf8', env:{...process.env,GIT_AUTHOR_NAME:'Jane Doe',GIT_COMMITTER_NAME:'Jane Doe',GIT_AUTHOR_EMAIL:'dev@example.com',GIT_COMMITTER_EMAIL:'dev@example.com'}})
for (const file of ['worktree','git-worktree']) {
  const source = git(repo,'show',`c23ea8cb:packages/server/src/${file}.ts`)
  const js = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${file === 'git-worktree' && p === './worktree.js' ? pathToFileURL(join(scratch,'before-worktree.mjs')) : pathToFileURL(resolve(repo,'packages/server/dist/src',p))}'`)
  writeFileSync(join(scratch,`before-${file}.mjs`),js.replaceAll("'@harnessdesk/protocol'",JSON.stringify(pathToFileURL(join(repo,'packages/protocol/dist/src/index.js')).href)))
}
const fixture = join(scratch,'fixture')
rmSync(fixture,{recursive:true,force:true});mkdirSync(fixture,{recursive:true})
const origin = join(fixture,'origin')
const superproject = join(fixture,'super')
for(const dir of [origin,superproject]) {
 mkdirSync(dir,{recursive:true});git(dir,'init','-q','-b','main');git(dir,'commit','-q','--allow-empty','-m','root')
}
git(superproject,'-c','protocol.file.allow=always','submodule','add','-q','--name','widgets-module',origin,'widgets')
git(superproject,'commit','-qm','Add widgets')
git(join(superproject,'widgets'),'checkout','-q','main')
const sub = join(superproject,'widgets')
const state = join(fixture,'state')
const afterSession = await import(pathToFileURL(join(repo,'packages/server/dist/src/worktree.js')))
const home = await afterSession.worktreeHome(sub,state)
mkdirSync(home,{recursive:true})
const side = join(home,'parser')
git(sub,'worktree','add','-q','-b','harnessdesk/parser',side)
const rename = text => text.replaceAll(origin,'/work/library').replaceAll(home,'/state/worktrees/widgets-demo').replaceAll(superproject,'/work/super')
const versions = {}
for(const version of ['before','after']) {
 const session = version==='before' ? await import(pathToFileURL(join(scratch,'before-worktree.mjs'))) : afterSession
 const history = await import(pathToFileURL(version==='before' ? join(scratch,'before-git-worktree.mjs') : join(repo,'packages/server/dist/src/git-worktree.js')))
 versions[version] = JSON.parse(rename(JSON.stringify({worktrees:await session.list(side,state),history:await history.list(sub,state)})))
}
assert.equal(versions.before.history[0].path,'/work/super/.git/modules/widgets-module')
assert.equal(versions.after.history[0].path,'/work/super/widgets')
assert.equal(versions.before.history[1].managed,false)
assert.equal(versions.after.history[1].managed,true)
const repairBase = '136f08c9617e086c9378848f525ed6ff29ad1e5b'
for (const file of ['worktree','git-worktree']) {
 const source = git(repo,'show',`${repairBase}:packages/server/src/${file}.ts`)
 const js = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${file === 'git-worktree' && p === './worktree.js' ? pathToFileURL(join(scratch,'repair-before-worktree.mjs')) : pathToFileURL(resolve(repo,'packages/server/dist/src',p))}'`)
 writeFileSync(join(scratch,`repair-before-${file}.mjs`),js.replaceAll("'@harnessdesk/protocol'",JSON.stringify(pathToFileURL(join(repo,'packages/protocol/dist/src/index.js')).href)))
}
const repairBefore = await import(pathToFileURL(join(scratch,'repair-before-git-worktree.mjs')))
const afterHistory = await import(pathToFileURL(join(repo,'packages/server/dist/src/git-worktree.js')))
const config = join(superproject,'.git/modules/widgets-module/config')
const originalConfig = readFileSync(config)
const refusals = {}
try {
 git(fixture,'config','--file',config,'core.worktree',origin)
 refusals.before = {...versions.after,history:JSON.parse(rename(JSON.stringify(await repairBefore.list(side,state))))}
 refusals.after = {...versions.after,history:[]}
 try { await afterHistory.list(side,state);assert.fail('Expected an unrelated main folder to be refused') }
 catch(error) { assert.match(error.message,/no valid main checkout/);refusals.after.refusal = error.message }
} finally {writeFileSync(config,originalConfig)}
const sourceHashes = Object.fromEntries(['worktree','git-worktree','shell-project'].map(file=>[file,createHash('sha256').update(readFileSync(join(repo,`packages/server/src/${file}.ts`))).digest('hex')]))
writeFileSync(join(output,'listing-evidence.json'),JSON.stringify({base:'c23ea8cbc87135b2f52ee2a5c8f7c65d6f224ffa',head:git(repo,'rev-parse','HEAD').trim(),repairBase,sourceHashes,git:git(repo,'--version').trim(),versions,refusals},null,2))
if(process.argv.includes('--fixtures-only'))process.exit(0)
const uiRequire=createRequire(join(repo,'packages/ui/package.json'));
const viteCli=join(uiRequire.resolve('vite/package.json'),'../bin/vite.js');
const server = spawn(process.execPath,[viteCli,'--host','127.0.0.1','--port','6574','--strictPort'],{cwd:join(repo,'packages/ui'),stdio:['ignore','pipe','pipe'],detached:true})
const serverReady = new Promise((resolveReady,rejectReady)=>{
 let logs=''
 const timer=setTimeout(()=>rejectReady(new Error('Preview server did not become ready')),30000)
 const receive=chunk=>{logs+=chunk.toString();if(logs.includes('http://127.0.0.1:6574/')){clearTimeout(timer);resolveReady()}}
 server.stdout.on('data',receive);server.stderr.on('data',receive)
 server.once('exit',code=>{clearTimeout(timer);rejectReady(new Error(`Preview server exited (${code}): ${logs}`))})
})
let browser = null
try {
 await serverReady
 browser = process.argv.includes('--preflight') ? null : await chromium.launch({headless:true})
 for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:6574/preview.html');break}catch{await new Promise(r=>setTimeout(r,100))}}
 if(!browser){const transformed=await (await fetch('http://127.0.0.1:6574/src/preview/main.tsx')).text();assert.ok(transformed.includes('createRoot(container).render('));assert.ok(/from "([^"\n]*\/react\.js[^"\n]*)"/.test(transformed));writeFileSync(join(scratch,'transformed-main.mjs'),transformed);console.log('preview module transforms and capture anchors resolve')}
 for(const version of browser ? ['before','after'] : []) for(const theme of ['light','dark']) for(const scene of ['manager','composer','bring-home','manager-refusal']) {
  const refusedScene = scene==='manager-refusal'
  const data = refusedScene ? refusals[version] : versions[version]
  const page = await browser.newPage({viewport:{width:960,height:720},colorScheme:theme,reducedMotion:'reduce'})
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log('browser console error:',m.text())});page.on('requestfailed',r=>console.log('browser request failed:',r.url(),r.failure()?.errorText))
  await page.route('**/src/preview/main.tsx*',async route=>{
   const response=await route.fetch();const source=await response.text()
   const reactUrl=/from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
   assert.ok(reactUrl)
   const custom = `
import shotReact from ${JSON.stringify(reactUrl)};
import { WorktreeDialog as ShotManager } from '/src/components/GitWorktrees.tsx';
const el = shotReact.createElement;
const shotTrees=${JSON.stringify(data.worktrees)};
const shotHistory=${JSON.stringify(data.history)};
const ws=${JSON.stringify(scene==='manager' ? {path:'/work/super/widgets',name:'widgets',lastOpenedAt:1,git:{branch:'main',dirty:false},repo:{root:'/work/super/widgets',worktree:false}} : {path:'/state/worktrees/widgets-demo/parser',name:'parser',lastOpenedAt:1,git:{branch:'harnessdesk/parser',dirty:false},repo:{root:'/work/super/widgets',worktree:true}})};
const shotStore=previewStore({workspace:ws,workspaces:[ws],worktrees:shotTrees,activeSessionKey:null,sessions:new Map(),history:[],agentNotices:[],usage:[],approvals:[],draftPlace:null,theme:${JSON.stringify(theme)}});
shotStore.startDraftIn=(place)=>{window.__shotSelection=place};
shotStore.transport.request=async (method)=>{
 if(method==='git/worktrees'){if(${JSON.stringify(data.refusal ?? null)})throw new Error(${JSON.stringify(data.refusal ?? null)});return shotHistory;}
 if(method==='worktree/changes')return {modified:0,untracked:0,unpushedCommits:0,files:[],ignored:[],ignoredCount:0,ignoredTruncated:false};
 return null;
};
const Shot=()=>{useTheme();return el('div',{className:'flex h-screen min-h-0 flex-col'},el(Conversation,{onChooseProject:()=>{},onSignIn:()=>{},onOpenUsage:()=>{},onOpenRuntimes:()=>{}}),${scene.startsWith('manager') ? `el(ShotManager,{root:${JSON.stringify(refusedScene ? '/state/worktrees/widgets-demo/parser' : '/work/super/widgets')},onAdd:()=>{},onDone:()=>{}})` : scene==='bring-home' ? "el(BringHome,{worktree:shotTrees[1],onClose:()=>{}})" : 'null'})};
createRoot(container).render(el(StoreProvider,{store:shotStore},el(AppWindowMode.Provider,{value:'embedded'},el(PaneProvider,{scope:{paneId:'shot',view:{kind:'conversation',session:null},sessionKey:null}},el(Shot)))));
`
   const refreshStart=source.search(/\nvar _c(?:,|;)/);assert.ok(refreshStart>0);
   await route.fulfill({response,body:source.slice(0,source.indexOf('createRoot(container).render('))+custom+source.slice(refreshStart)})
  })
  await page.goto('http://127.0.0.1:6574/preview.html')
  await page.waitForLoadState('networkidle')
  console.log('page diagnostic',version,theme,scene,JSON.stringify(errors),await page.locator('body').innerText());
  assert.deepEqual(errors,[],`${version}/${theme}/${scene}`);
  if(scene==='composer') {
   const trigger=page.locator('button[title*="Starts in this worktree"]')
   await trigger.click()
   await page.getByRole('menuitemradio',{name:/Main checkout/}).waitFor()
   await page.getByRole('menuitemradio',{name:/Main checkout/}).hover()
  } else await page.getByRole(scene.startsWith('manager')?'dialog':'alertdialog').waitFor()
  await page.evaluate(async()=>await document.fonts.ready)
  assert.deepEqual(errors,[],`${version}/${theme}/${scene}`)
  assert.equal(await page.locator('body').getAttribute('data-hd-dark-theme')!==null,theme==='dark')
  const text = await page.locator('body').innerText()
  if(refusedScene && version==='after')assert.ok(text.includes(data.refusal))
  assert.doesNotMatch(text,/\/Users\//)
  await page.screenshot({animations:'disabled',path:join(output,`${scene}-${version}-${theme}.png`)})
  if(scene==='composer'){await page.getByRole('menuitemradio',{name:/Main checkout/}).click();assert.equal((await page.evaluate(()=>window.__shotSelection)).path,data.worktrees[0].path)}
  console.log(`${scene}-${version}-${theme}: captured`)
  await page.close()
 }
}finally{await browser?.close();try{process.kill(-server.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}}
