import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from '../../packages/ui/node_modules/jsdom/lib/api.js'
import { TILDIFY } from '../../script/shots/audit.mjs'

test('standard TILDIFY changes only the owned synthetic root presentation, never editable state or aria identity', () => {
  const root='/tmp/hd2065-owned-synthetic', project=`${root}/project`, other='/tmp/hd2065-owned-synthetic-other/project'
  const dom=new JSDOM('<!doctype html><html><body><span id="shown"></span><span id="other"></span><input id="input"><div id="editor" contenteditable="true"></div><button id="button"></button></body></html>',{runScripts:'outside-only'})
  try {
    const d=dom.window.document
    d.querySelector('#shown').textContent=project
    d.querySelector('#other').textContent=other
    d.querySelector('#input').value=project
    d.querySelector('#editor').textContent=project
    d.querySelector('#button').setAttribute('aria-label',project)
    d.querySelector('#button').setAttribute('title',project)
    dom.window.eval(TILDIFY(root,'~/synthetic-stop-proof'))
    assert.equal(d.querySelector('#shown').textContent,'~/synthetic-stop-proof/project')
    assert.equal(d.querySelector('#button').getAttribute('title'),'~/synthetic-stop-proof/project')
    assert.equal(d.querySelector('#other').textContent,other)
    assert.equal(d.querySelector('#input').value,project)
    assert.equal(d.querySelector('#editor').textContent,project)
    assert.equal(d.querySelector('#button').getAttribute('aria-label'),project)
  } finally {dom.window.close()}
})
