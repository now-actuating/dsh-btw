import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BtwController } from '../src/client/controller.js'
import { BTW_CONTROLLER_LIMIT, BtwControllerPool } from '../src/client/controller-pool.js'

const id = (value: string) => value as SessionId
const pools: BtwControllerPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose() })

function fixture() {
  const pending: Array<{
    payload: { requestId: string; sessionId: string }
    signal: AbortSignal
    resolve: (value: unknown) => void
  }> = []
  const call = vi.fn((_channel: string, _endpoint: string, payload: { requestId: string; sessionId: string }, signal: AbortSignal) =>
    new Promise(resolve => { pending.push({ payload, signal, resolve }) }))
  const connection = { rpc: { call } } as unknown as ConnectionHandle
  const unavailable = new Set<SessionId>()
  const create = vi.fn((sessionId: SessionId) => new BtwController(connection, sessionId))
  const pool = new BtwControllerPool(create, sessionId => !unavailable.has(sessionId))
  pools.push(pool)
  const succeed = async (index: number, response = 'answer') => {
    const request = pending[index]!
    request.resolve({ ok: true, value: {
      requestId: request.payload.requestId, sidechainId: 'sidechain', response,
      cacheStrategy: 'provider-managed',
    } })
    await Promise.resolve()
  }
  return { pool, create, pending, call, unavailable, succeed }
}

const keys = (pool: BtwControllerPool) => [...pool.state.getSnapshot().keys()]

function fill(pool: BtwControllerPool, start = 1, end = 10) {
  for (let index = start; index <= end; index++) pool.acquire(id(`session-${index}`))
}

describe('BtwControllerPool root ownership and fixed LRU', () => {
  it('is lazy, never creates on touch, and refuses unavailable sessions', () => {
    const { pool, create, unavailable } = fixture()
    expect(BTW_CONTROLLER_LIMIT).toBe(10)
    expect(keys(pool)).toEqual([])
    pool.touch(id('unvisited'))
    pool.reconcile()
    expect(create).not.toHaveBeenCalled()
    unavailable.add(id('removed'))
    expect(pool.acquire(id('removed'))).toBeUndefined()
    expect(create).not.toHaveBeenCalled()

    const first = pool.acquire(id('first'))
    expect(first).toBeInstanceOf(BtwController)
    expect(pool.acquire(id('first'))).toBe(first)
    expect(create).toHaveBeenCalledExactlyOnceWith(id('first'))
    expect(keys(pool)).toEqual([id('first')])
  })

  it('evicts only the oldest on the eleventh acquisition, aborting its pending request and clearing recall', async () => {
    const { pool, pending, succeed, call } = fixture()
    const oldest = pool.acquire(id('session-1'))!
    await oldest.ask('remembered')
    await succeed(0, 'old answer')
    await oldest.ask('still pending')
    fill(pool, 2)
    expect(keys(pool)).toHaveLength(10)
    expect(pending[1]!.signal.aborted).toBe(false)

    pool.acquire(id('session-11'))
    expect(keys(pool)).toEqual(Array.from({ length: 10 }, (_, index) => id(`session-${index + 2}`)))
    expect(pending[1]!.signal.aborted).toBe(true)
    expect(oldest.state.getSnapshot()).toEqual({ status: 'closed' })
    await expect(oldest.ask('')).resolves.toMatchObject({ kind: 'error' })
    await expect(oldest.ask('stale question')).resolves.toMatchObject({ kind: 'error' })
    await succeed(1, 'late answer must not return')
    expect(oldest.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(pool.state.getSnapshot().has(id('session-1'))).toBe(false)

    const recreated = pool.acquire(id('session-1'))!
    expect(recreated).not.toBe(oldest)
    await expect(recreated.ask('')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('No previous BTW answer') })
    expect(call).toHaveBeenCalledTimes(2)
    expect(keys(pool)).toHaveLength(10)
  })

  it('promotes used entries through touch or acquisition without allocating on visits', () => {
    const { pool, create } = fixture()
    fill(pool)
    const original = pool.state.getSnapshot().get(id('session-1'))
    pool.touch(id('never used'))
    pool.touch(id('session-1'))
    expect(keys(pool).at(-1)).toBe(id('session-1'))
    expect(create).toHaveBeenCalledTimes(10)
    const snapshot = pool.state.getSnapshot()
    pool.touch(id('session-1'))
    expect(pool.state.getSnapshot()).toBe(snapshot)
    expect(pool.acquire(id('session-1'))).toBe(original)
    pool.acquire(id('session-11'))
    expect(pool.state.getSnapshot().has(id('session-1'))).toBe(true)
    expect(pool.state.getSnapshot().has(id('session-2'))).toBe(false)
    expect(create).toHaveBeenCalledTimes(11)
  })

  it('does not promote a controller when its background response completes', async () => {
    const { pool, succeed } = fixture()
    const first = pool.acquire(id('session-1'))!
    await first.ask('slow question')
    fill(pool, 2)
    const order = keys(pool)
    await succeed(0)
    expect(first.state.getSnapshot()).toMatchObject({ status: 'success' })
    expect(keys(pool)).toEqual(order)
    pool.acquire(id('session-11'))
    expect(pool.state.getSnapshot().has(id('session-1'))).toBe(false)
  })

  it('publishes independent snapshots and removes only unavailable controllers on reconciliation', async () => {
    const { pool, unavailable, pending } = fixture()
    const listener = vi.fn()
    const stop = pool.state.subscribe(listener)
    const empty = pool.state.getSnapshot()
    const one = pool.acquire(id('one'))!
    const oneSnapshot = pool.state.getSnapshot()
    const two = pool.acquire(id('two'))!
    await one.ask('pending one')
    await two.ask('pending two')
    expect(empty.size).toBe(0)
    expect([...oneSnapshot.keys()]).toEqual([id('one')])

    unavailable.add(id('one'))
    pool.reconcile()
    expect(keys(pool)).toEqual([id('two')])
    expect(pending[0]!.signal.aborted).toBe(true)
    expect(pending[1]!.signal.aborted).toBe(false)
    pool.remove(id('unknown'))
    pool.remove(id('two'))
    pool.remove(id('two'))
    expect(keys(pool)).toEqual([])
    expect(pending[1]!.signal.aborted).toBe(true)
    expect(listener).toHaveBeenCalledTimes(4)
    stop()
  })

  it.each(['remove', 'reconcile', 'dispose'] as const)('%s cannot be undone by late success or a stale controller reference', async action => {
    const { pool, pending, unavailable, succeed, call } = fixture()
    const controller = pool.acquire(id('one'))!
    await controller.ask('pending')
    if (action === 'reconcile') unavailable.add(id('one'))
    if (action === 'remove') pool.remove(id('one'))
    else pool[action]()
    expect(pending[0]!.signal.aborted).toBe(true)
    await succeed(0, 'late success')
    expect(keys(pool)).toEqual([])
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    await expect(controller.ask('')).resolves.toMatchObject({ kind: 'error' })
    await expect(controller.ask('again')).resolves.toMatchObject({ kind: 'error' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('disposes all owned controllers once and permanently rejects further acquisitions', async () => {
    const { pool, pending, create } = fixture()
    const first = pool.acquire(id('one'))!
    const second = pool.acquire(id('two'))!
    const firstDispose = vi.spyOn(first, 'dispose')
    const secondDispose = vi.spyOn(second, 'dispose')
    await first.ask('one')
    await second.ask('two')
    pool.dispose()
    pool.dispose()
    pool.touch(id('one'))
    pool.reconcile()
    expect(pool.acquire(id('one'))).toBeUndefined()
    expect(pool.acquire(id('new'))).toBeUndefined()
    expect(keys(pool)).toEqual([])
    expect(pending.every(request => request.signal.aborted)).toBe(true)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
