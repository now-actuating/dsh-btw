import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { createBtwInputSource } from '../src/client/input-source.js'
import type { BtwController } from '../src/client/controller.js'

describe('BTW input source', () => {
  it('does not acquire on candidate selection or space matching and reacquires for every submit', async () => {
    const ask = vi.fn(async () => ({ kind: 'success' as const }))
    const controllerFor = vi.fn(() => ({ ask } as unknown as BtwController))
    const source = createBtwInputSource(controllerFor)
    const session = { sessionId: 'session' as SessionId }
    source.onPick?.({ session } as never)
    const outcome = source.matchSpace?.(session, '/btw')
    expect(controllerFor).not.toHaveBeenCalled()
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    await outcome.claim.submit('first', {} as never)
    await outcome.claim.submit('second', {} as never)
    expect(controllerFor).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls).toEqual([['first'], ['second']])
  })

  it('returns an error without dispatch when the session is no longer available', async () => {
    const source = createBtwInputSource(() => undefined)
    const outcome = await source.matchEnter?.({ sessionId: 'gone' as SessionId }, '/btw q', new AbortController().signal)
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    await expect(outcome.claim.submit('q', {} as never)).resolves.toMatchObject({ kind: 'error' })
  })

  it.each(['/btw', '/btw ', '/BTW'])('claims bare %s and submits an empty question for recall', async line => {
    const ask = vi.fn(async () => ({ kind: 'success' as const }))
    const session = { sessionId: 'session' as SessionId }
    const controllerFor = vi.fn(() => ({ ask } as unknown as BtwController))
    const source = createBtwInputSource(controllerFor)
    const outcome = await source.matchEnter?.(session, line, new AbortController().signal)
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    expect(controllerFor).not.toHaveBeenCalled()
    await outcome.claim.submit('', {} as never)
    expect(controllerFor).toHaveBeenCalledWith(session.sessionId)
    expect(ask).toHaveBeenCalledWith('')
  })

  it('claims an argued /btw line directly instead of sending it to the main agent', async () => {
    const ask = vi.fn(async () => ({ kind: 'success' as const }))
    const source = createBtwInputSource(() => ({ ask } as unknown as BtwController))
    const outcome = await source.matchEnter?.(
      { sessionId: 'session' as SessionId },
      '/btw current secret?',
      new AbortController().signal,
    )
    expect(outcome).toBeDefined()
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    await outcome.claim.submit('current secret?', {} as never)
    expect(ask).toHaveBeenCalledWith('current secret?')
  })
})
