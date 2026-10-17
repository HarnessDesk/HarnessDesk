import { expect, it } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { framePageIds, framePageRoute } from './frame-page-route'
import { previewStore } from './harness'
import { accountKey } from '../lib/accounts'
const ids={agent:'reviewer',plugin:'tools',runtime:runtimeId('alpha'),account:'synthetic-account',project:'/synthetic/project',skill:'review'}
it.each([
  ['frame-wall=settings&frame-detail=runtime',{kind:'settings',route:{kind:'runtime',runtime:ids.runtime}}],
  ['frame-wall=settings&frame-detail=account',{kind:'settings',route:{kind:'account',runtime:ids.runtime,key:ids.account}}],
  ['frame-wall=settings&frame-detail=project',{kind:'settings',route:{kind:'project',root:ids.project}}],
  ['frame-wall=settings&frame-detail=skill',{kind:'settings',route:{kind:'skill',name:ids.skill}}],
  ['frame-wall=settings&frame-section=agents',{kind:'settings',route:{kind:'section',section:'runtimes',focus:null}}],
  ['frame-wall=settings&frame-section=library',{kind:'library',section:'skill'}],
  ['frame-wall=dashboard&frame-view=plans&frame-scope=runtime',{kind:'dashboard',view:'plans',scope:ids.runtime}],
  ['frame-wall=agents&frame-detail=agent',{kind:'agents',id:ids.agent}],
  ['frame-wall=teams&frame-filter=settled',{kind:'teams',filter:'settled'}],
  ['frame-wall=library&frame-kind=changes',{kind:'library',section:'changes'}],
  ['frame-wall=library&frame-kind=mcp',{kind:'library',section:'mcp'}],
  ['frame-wall=plugins&frame-plugin-page=detail',{kind:'plugins',section:'installed',id:ids.plugin}],
] as const)('initializes the typed route %s',(query,expected)=>expect(framePageRoute(new URLSearchParams(query),ids)).toEqual(expected))
it('chooses stable entity keys from the complete fixture before a specialised page filters it',()=>{
  const snapshot=previewStore().getSnapshot(),chosen=framePageIds(snapshot)
  expect(snapshot.accountsByRuntime[chosen.runtime]?.accounts.map(account=>accountKey(chosen.runtime,account))).toContain(chosen.account)
  expect(snapshot.skills.map(skill=>skill.name)).toContain(chosen.skill)
  expect(chosen.project).toBe(snapshot.workspace?.path)
  expect(()=>framePageIds({...snapshot,skills:[]})).toThrow('complete synthetic fixture')
})
