// Unit tests for the service key check shared by /api/recommend and
// /api/ideas. No network, no request object.
//
// Run with: npm test

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkServiceKey } from './service-auth.ts'

describe('checkServiceKey', () => {
  it('accepts the right key as a bearer token', () => {
    assert.deepEqual(checkServiceKey('Bearer s3cret-key', 's3cret-key'), { ok: true })
  })

  it('refuses a wrong key of the same length with 401', () => {
    assert.deepEqual(checkServiceKey('Bearer s3cret-kez', 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses a wrong key of a different length with 401', () => {
    assert.deepEqual(checkServiceKey('Bearer short', 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses a missing header with 401', () => {
    assert.deepEqual(checkServiceKey(null, 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses a header that is not a bearer token with 401', () => {
    assert.deepEqual(checkServiceKey('s3cret-key', 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses an empty bearer token with 401', () => {
    assert.deepEqual(checkServiceKey('Bearer ', 's3cret-key'), { ok: false, status: 401 })
  })

  it('answers 503 when the key is unset on the server, whatever was sent', () => {
    assert.deepEqual(checkServiceKey('Bearer anything', undefined), { ok: false, status: 503 })
    assert.deepEqual(checkServiceKey('Bearer anything', ''), { ok: false, status: 503 })
  })
})
