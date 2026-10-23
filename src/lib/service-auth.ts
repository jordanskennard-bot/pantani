// The service key check, shared by the routes a Passo service calls rather
// than a signed-in operator: /api/recommend and /api/ideas.
//
// It lived in src/lib/recommend.ts while there was one such route. Both now
// read it from here, so there is one answer to "is this caller allowed" and
// one place to change it.
//
// Kept out of the route handlers so it can be tested without a request.

import { createHash, timingSafeEqual } from 'node:crypto'

export type AuthOutcome = { ok: true } | { ok: false; status: 401 | 503 }

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/**
 * 503 when the key is unset on the server, because that is our
 * misconfiguration rather than a bad caller. 401 for anything else, with no
 * detail about which part was wrong.
 *
 * Both sides are hashed before the comparison so timingSafeEqual gets two
 * buffers of the same length whatever was sent, and a wrong key of the wrong
 * length is refused on the same path as a wrong key of the right length.
 */
export function checkServiceKey(authorization: string | null, expected: string | undefined): AuthOutcome {
  if (!expected) return { ok: false, status: 503 }
  const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!provided) return { ok: false, status: 401 }
  return timingSafeEqual(sha256(provided), sha256(expected)) ? { ok: true } : { ok: false, status: 401 }
}
