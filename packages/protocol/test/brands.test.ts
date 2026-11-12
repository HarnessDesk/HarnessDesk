import assert from 'node:assert/strict'
import test from 'node:test'
import { BRANDS, RUNTIME_BRAND_KEY, brandForRuntime, brandKeyField } from '../src/index.js'

test('every mark key the desktop draws has the shape a phone accepts, so no mark is lost on the wire (#2150)', () => {
  for (const brand of BRANDS) assert.match(brand, RUNTIME_BRAND_KEY, brand)
})

test('the wire field carries a key and drops anything shaped otherwise (#2150)', () => {
  assert.deepEqual(brandKeyField('claudecode'), { brand: 'claudecode' })
  for (const bad of [null, undefined, '', 'Claude Code', 'claude-code', 'x'.repeat(33)]) assert.deepEqual(brandKeyField(bad), {}, String(bad))
  // The desktop's choice and the desk's are one function: a declared key wins, and a name is read when none is declared.
  assert.equal(brandForRuntime({ id: 'agent-a', presentation: { name: 'Agent', brand: 'cursor' } }), 'cursor')
  assert.equal(brandForRuntime({ id: 'fake-agent', presentation: { name: 'Fake Agent' } }), null)
})

test('a short agent name marks only a whole word, so an unrelated agent never wears it on the phone (#2150)', () => {
  const of = (id: string, name: string) => brandForRuntime({ id, presentation: { name } })
  for (const [id, name] of [['traefik-agent', 'Traefik Agent'], ['kilogram', 'Kilogram'], ['incline', 'Incline'], ['devinity', 'Devinity'], ['mongoose-cli', 'Mongoose'], ['kirov', 'Kirov']] as const)
    assert.equal(of(id, name), null, id)
  for (const [id, name, brand] of [['trae-agent', 'Trae Agent', 'trae'], ['kilo', 'Kilo', 'kilocode'], ['kilocode', 'Kilo Code', 'kilocode'], ['cline', 'Cline', 'cline'],
    ['devin', 'Devin', 'devin'], ['goose', 'goose', 'goose'], ['kiro-cli', 'Kiro CLI', 'kiro']] as const)
    assert.equal(of(id, name), brand, id)
})
