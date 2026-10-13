import assert from 'node:assert/strict'
import test from 'node:test'
import { coverage, importsOf } from './mapcore.mjs'

/** Small maps isolate dependency ownership from unrelated depth warnings. */
const map = {
  version: 1, repo: 'client', buildings: [
    { id: 'client', name: 'Client', kind: 'app', path: 'src', summary: 'Calls its public API.' },
    { id: 'other', name: 'Other client', kind: 'app', path: 'other', summary: 'A separate caller.' },
  ],
  connections: [{ id: 'client-api', from: 'client', to: 'openapi:createBox', kind: 'request' }],
}
function issues(source, packages, changes = {}) {
  const files = { 'src/client.ts': source, ...(packages === undefined ? {} : {
    'map.dependencies.json': typeof packages === 'string' ? packages : JSON.stringify({ version: 1, packages }),
  }) }
  return coverage({ ...map, ...changes }, { readFile: p => files[p] ?? null, listFiles: () => ['src/client.ts'] }).filter(i => i.rule === 'C-8')
}
test('scoped package subpaths normalize and type imports do not invent packages', () => {
  assert.deepEqual(importsOf('import type { Shape } from "@team/schema/types"\nimport "node:fs"'), ['@team/schema', 'node:fs'])
})
test('comment prose is not a dependency; quoted specifiers stay intact', () => {
  assert.deepEqual(importsOf('/* change from "emitted" to another value */\nimport x from "schema-lib" // from "fake"'), ['schema-lib'])
})
test('an unseen package warns instead of being silently missed by a vendor catalogue', () => {
  assert.match(issues('import client from "new-service-sdk"', undefined)[0].message, /new-service-sdk.*classification/)
})
test('a reasoned local library needs no external building', () => {
  assert.deepEqual(issues('import x from "schema-lib"', { 'schema-lib': { kind: 'library', reason: 'Validates local input.' } }), [])
})
test('a service package maps to an actual connection from its caller', () => {
  assert.deepEqual(issues('import x from "service-sdk"', { 'service-sdk': { kind: 'service', reason: 'Calls the public API.', connections: ['client-api'] } }), [])
})
test('invented and foreign connection ids do not satisfy service ownership', () => {
  assert.ok(issues('import x from "service-sdk"', { 'service-sdk': { kind: 'service', reason: 'Calls API.', connections: ['missing'] } }).some(i => i.level === 'error'))
  const foreign = [{ id: 'client-api', from: 'other', to: 'openapi:createBox', kind: 'request' }]
  assert.ok(issues('import x from "service-sdk"', { 'service-sdk': { kind: 'service', reason: 'Calls API.', connections: ['client-api'] } }, { connections: foreign }).some(i => /no declared connection/.test(i.message)))
})
test('malformed policy and unsupported classification fail validation', () => {
  assert.ok(issues('', '{').some(i => i.level === 'error'))
  assert.ok(issues('', { x: { kind: 'anything', reason: 'Invalid kind.' } }).some(i => i.level === 'error'))
  assert.ok(issues('', { x: { kind: 'library', reason: '', connections: ['client-api'] } }).some(i => i.level === 'error'))
})
test('platform imports are excluded and direct fetch still needs an outgoing connection', () => {
  assert.deepEqual(issues('import fs from "node:fs"', {}), [])
  assert.ok(issues('fetch(url)', {}, { connections: [] }).some(i => /no outgoing connection/.test(i.message)))
})
test('mapped code outside the deployment folder is audited too', () => {
  const files = { 'packages/adapter.ts': 'import x from "service-sdk"' }
  const result = coverage({ ...map, code: [{ id: 'adapter', building: 'client', name: 'Adapter', path: 'packages/adapter.ts', summary: 'Calls a service.' }] }, {
    readFile: p => files[p] ?? null, listFiles: () => Object.keys(files),
  })
  assert.ok(result.some(i => i.rule === 'C-8' && /service-sdk/.test(i.message)))
})
test('Python imports are parsed only for Python source', () => {
  assert.deepEqual(importsOf('from example_sdk import Client', 'app.py'), ['example_sdk'])
  assert.deepEqual(importsOf('import type { Shape } from "schema-lib"', 'app.ts'), ['schema-lib'])
})
