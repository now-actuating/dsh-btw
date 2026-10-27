import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CommandClaim, InputTriggerSource, PickOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BtwControllerPool } from '../src/client/controller-pool.js'
import { apply } from '../src/client/index.js'

// These tests exercise registration/ownership, not rendering. Keep the real
// controller, pool, and store without loading Markdown's optional UI peers.
vi.mock('../src/client/overlay.js', () => ({ BtwOverlay: () => null }))

const id = (value: string) => value as SessionId
type Phase = 'ready' | 'pending' | 'error'
interface SessionRow { id: SessionId; retainedBy: Record<string, number>; running?: boolean }
interface SessionList { phase: Phase; byId: Record<string, SessionRow> }
interface WorkspaceList { phase: Phase; archivedSessionIds: SessionId[] }

function trackedStore<T>(initial: T) {
  const store = createSnapshotStore(initial)
  const stops: ReturnType<typeof vi.fn>[] = []
  const subscribe = vi.fn((listener: () => void) => {
    const unsubscribe = store.subscribe(listener)
    const stop = vi.fn(unsubscribe)
    stops.push(stop)
    return stop
  })
  return { ...store, subscribe, stops }
}

const fixtures: Array<{ teardown: () => void }> = []
afterEach(() => { for (const instance of fixtures.splice(0)) instance.teardown() })

function fixture() {
  const sessionIds = Array.from({ length: 12 }, (_, index) => id(`session-${index + 1}`))
  const rows = (ids: SessionId[], main?: SessionId): Record<string, SessionRow> => Object.fromEntries(
    ids.map(sessionId => [sessionId, { id: sessionId, retainedBy: sessionId === main ? { mainView: 1 } : {} }]),
  )
  const sessionList = trackedStore<SessionList>({ phase: 'ready', byId: rows(sessionIds, sessionIds[0]) })
  const workspaceList = trackedStore<WorkspaceList>({ phase: 'ready', archivedSessionIds: [] })
  const childAddresses = new Map<SessionId, object>()
  const sourceScopeCleanups: Array<() => void> = []
  const scope = vi.fn(() => ({ effect: (setup: () => () => void) => { sourceScopeCleanups.push(setup()) } }))
  const sessions = { list: sessionList, scope, subagentAddress: (sessionId: SessionId) => childAddresses.get(sessionId) }
  const workspaces = { list: workspaceList }
  const pending: Array<{
    payload: { requestId: string; sessionId: string }
    signal: AbortSignal
    resolve: (value: unknown) => void
  }> = []
  const call = vi.fn((_channel: string, _endpoint: string, payload: { requestId: string; sessionId: string }, signal: AbortSignal) =>
    new Promise(resolve => { pending.push({ payload, signal, resolve }) }))
  const generation = trackedStore<number | undefined>(1)
  const connection = { rpc: { call }, generation } as unknown as ConnectionHandle
  let source: InputTriggerSource | undefined
  const stopSource = vi.fn()
  const registerSource = vi.fn((registered: InputTriggerSource) => { source = registered; return stopSource })
  const rootCleanups: Array<() => void> = []
  const handlers = new Map<string, Set<(value: never) => void>>()
  const remoteStops: ReturnType<typeof vi.fn>[] = []
  const remote = {
    $on: vi.fn((event: string, listener: (value: never) => void) => {
      const listeners = handlers.get(event) ?? new Set()
      handlers.set(event, listeners)
      listeners.add(listener)
      const stop = vi.fn(() => { listeners.delete(listener) })
      remoteStops.push(stop)
      return stop
    }),
  }
  let project: ((scopeId: string) => { pool: BtwControllerPool; sessionId: SessionId }) | undefined
  const stopSlot = vi.fn()
  const register = vi.fn((definition: { inject: typeof project }, _component: unknown) => {
    project = definition.inject
    return stopSlot
  })
  const slots = {
    register,
    inject: vi.fn((_name: string, setup: () => () => void) => { rootCleanups.push(setup()); return stopSlot }),
  }
  const services = { connection, inputTriggers: { registerSource }, sessions, workspaces }
  const ctx = {
    get: (name: keyof typeof services) => services[name], remote, slots,
    effect: vi.fn((setup: () => () => void, _label: string) => { rootCleanups.push(setup()) }),
  }
  apply(ctx as never)
  const projection = (sessionId: SessionId) => project!(sessionId)
  const pool = projection(sessionIds[0]!).pool
  const emit = (event: string, value: unknown) => {
    for (const listener of handlers.get(event) ?? []) listener(value as never)
  }
  const claimFor = async (sessionId: SessionId, line = '/btw question'): Promise<CommandClaim> => {
    const result = await source!.matchEnter!({ sessionId }, line, new AbortController().signal, { attachments: 0 })
    return getClaim(result)
  }
  const submit = async (sessionId: SessionId, question = 'question') => {
    const claim = await claimFor(sessionId)
    return claim.submit(question, {} as never)
  }
  const succeed = async (index: number, response = 'answer') => {
    const request = pending[index]!
    request.resolve({ ok: true, value: {
      requestId: request.payload.requestId, sidechainId: 'sidechain', response,
      cacheStrategy: 'provider-managed',
    } })
    await Promise.resolve()
  }
  let tornDown = false
  const teardown = () => {
    if (tornDown) return
    tornDown = true
    for (const cleanup of rootCleanups.splice(0).reverse()) cleanup()
  }
  const result = {
    ctx, source: source!, sessions, sessionList, workspaceList, sessionIds, childAddresses, generation,
    pool, projection, call, pending, succeed, submit, claimFor, emit, scope, registerSource,
    stopSource, stopSlot, remote, remoteStops, handlers,
    setSessions: (ids: SessionId[], main?: SessionId, phase: Phase = 'ready') => sessionList.set({ phase, byId: rows(ids, main) }),
    closeSourceScope: () => { for (const cleanup of sourceScopeCleanups.splice(0)) cleanup() },
    teardown,
  }
  fixtures.push(result)
  return result
}

function getClaim(result: PickOutcome): CommandClaim {
  if (result === undefined || result === 'handled' || !('claim' in result)) throw new Error('expected BTW command claim')
  return result.claim
}

const keys = (pool: BtwControllerPool) => [...pool.state.getSnapshot().keys()]

describe('BTW client root lifecycle integration', () => {
  it('registers and projects lazily; completion, matching, and picking do not allocate controllers', async () => {
    const f = fixture()
    expect(f.registerSource).toHaveBeenCalledTimes(1)
    expect(f.ctx.slots.inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    for (const sessionId of f.sessionIds) {
      expect(f.projection(sessionId)).toEqual({ pool: f.pool, sessionId })
      expect(f.projection(sessionId)).not.toHaveProperty('controller')
    }
    const session = { sessionId: id('session-1') }
    const candidates = await f.source.candidates(session, {
      query: 'bt', position: 'leading', drilled: false, signal: new AbortController().signal,
    })
    expect(candidates).toHaveLength(1)
    getClaim(f.source.onPick({ session, candidate: candidates[0]!, position: 'leading', via: 'enter', action: 'pick', span: {} } as never))
    getClaim(f.source.matchSpace!(session, '/btw'))
    const claim = await f.claimFor(session.sessionId)
    expect(keys(f.pool)).toEqual([])
    expect(f.call).not.toHaveBeenCalled()
    await claim.submit('actually submitted', {} as never)
    expect(keys(f.pool)).toEqual([session.sessionId])
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.scope).not.toHaveBeenCalled()
  })

  it('keeps requests and recall alive across a source view cleanup and returning to the session', async () => {
    const f = fixture()
    const first = id('session-1')
    await f.submit(first, 'background question')
    const controller = f.pool.state.getSnapshot().get(first)!
    f.setSessions(f.sessionIds, id('session-2'))
    f.closeSourceScope()
    expect(f.scope).not.toHaveBeenCalled()
    expect(f.pending[0]!.signal.aborted).toBe(false)
    await f.succeed(0, 'arrived while away')
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'success', response: 'arrived while away' })
    f.setSessions(f.sessionIds, first)
    expect(f.projection(first).pool.state.getSnapshot().get(first)).toBe(controller)
    controller.dismiss()
    await expect(f.submit(first, '')).resolves.toEqual({ kind: 'success' })
    expect(controller.state.getSnapshot()).toMatchObject({ response: 'arrived while away' })
    expect(f.call).toHaveBeenCalledTimes(1)
  })

  it('touches existing controllers only on actual mainView transitions, never on catalog churn or completion', async () => {
    const f = fixture()
    const [one, two, three] = f.sessionIds as [SessionId, SessionId, SessionId, ...SessionId[]]
    await f.submit(one)
    await f.submit(two)
    await f.submit(three)
    expect(keys(f.pool)).toEqual([one, two, three])
    f.setSessions(f.sessionIds, one)
    expect(keys(f.pool)).toEqual([one, two, three])
    f.sessionList.set({ ...f.sessionList.getSnapshot(), byId: {
      ...f.sessionList.getSnapshot().byId,
      [one]: { id: one, retainedBy: { mainView: 1 }, running: true },
    } })
    expect(keys(f.pool)).toEqual([one, two, three])
    f.setSessions(f.sessionIds, two)
    expect(keys(f.pool)).toEqual([one, three, two])
    f.setSessions(f.sessionIds, id('session-12'))
    expect(keys(f.pool)).toEqual([one, three, two])
    f.setSessions(f.sessionIds, one)
    expect(keys(f.pool)).toEqual([three, two, one])
    await f.succeed(2)
    expect(keys(f.pool)).toEqual([three, two, one])
    expect(f.pool.state.getSnapshot().size).toBe(3)
    expect(f.call).toHaveBeenCalledTimes(3)
  })

  it('removes a ready archived session, clears recall, and rejects a stale pre-archive claim', async () => {
    const f = fixture()
    const sessionId = id('session-1')
    const staleClaim = await f.claimFor(sessionId)
    await f.submit(sessionId)
    await f.succeed(0, 'remembered answer')
    const controller = f.pool.state.getSnapshot().get(sessionId)!
    await f.submit(sessionId, 'pending at archive')
    f.workspaceList.set({ phase: 'ready', archivedSessionIds: [sessionId] })
    expect(f.pool.state.getSnapshot().has(sessionId)).toBe(false)
    expect(f.pending[1]!.signal.aborted).toBe(true)
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    await expect(staleClaim.submit('stale question', {} as never)).resolves.toMatchObject({ kind: 'error' })
    await f.succeed(1, 'late answer')
    expect(keys(f.pool)).toEqual([])
    expect(f.call).toHaveBeenCalledTimes(2)
    f.workspaceList.set({ phase: 'ready', archivedSessionIds: [] })
    await expect(f.submit(sessionId, '')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('No previous BTW answer') })
    expect(f.pool.state.getSnapshot().get(sessionId)).not.toBe(controller)
  })

  it('does not treat an archive failure without an archived-state change as removal', async () => {
    const f = fixture()
    const sessionId = id('session-1')
    await f.submit(sessionId)
    const controller = f.pool.state.getSnapshot().get(sessionId)!
    // A rejected archive action never commits this id to archivedSessionIds.
    const archiveAttempt = vi.fn(async () => { throw new Error('archive failed') })
    await expect(archiveAttempt()).rejects.toThrow('archive failed')
    f.workspaceList.set({ phase: 'ready', archivedSessionIds: [] })
    expect(f.pool.state.getSnapshot().get(sessionId)).toBe(controller)
    expect(f.pending[0]!.signal.aborted).toBe(false)
    await f.succeed(0)
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'success' })
  })

  it.each(['pending', 'error'] as const)('keeps controllers through %s catalogs and workspace lists', async phase => {
    const f = fixture()
    const sessionId = id('session-1')
    await f.submit(sessionId)
    const controller = f.pool.state.getSnapshot().get(sessionId)!
    f.setSessions([], undefined, phase)
    f.workspaceList.set({ phase, archivedSessionIds: [sessionId] })
    expect(f.pool.state.getSnapshot().get(sessionId)).toBe(controller)
    expect(f.pending[0]!.signal.aborted).toBe(false)
    await f.succeed(0)
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'success' })
    f.workspaceList.set({ phase: 'ready', archivedSessionIds: [] })
    f.setSessions([])
    expect(keys(f.pool)).toEqual([])
  })

  it('removes missing ready catalog entries and cannot resurrect them via a stale command or late success', async () => {
    const f = fixture()
    const sessionId = id('session-1')
    const staleClaim = await f.claimFor(sessionId)
    await staleClaim.submit('pending', {} as never)
    const controller = f.pool.state.getSnapshot().get(sessionId)!
    f.setSessions(f.sessionIds.filter(value => value !== sessionId), id('session-2'))
    expect(f.pending[0]!.signal.aborted).toBe(true)
    await expect(staleClaim.submit('stale', {} as never)).resolves.toMatchObject({ kind: 'error' })
    await f.succeed(0)
    expect(keys(f.pool)).toEqual([])
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(f.call).toHaveBeenCalledTimes(1)
  })

  it('honors explicit durable-child removal despite a remaining address, with re-add permitting a fresh controller', async () => {
    const f = fixture()
    const child = id('durable-child')
    f.childAddresses.set(child, { parentSessionId: id('session-1') })
    const staleClaim = await f.claimFor(child)
    await staleClaim.submit('child question', {} as never)
    const controller = f.pool.state.getSnapshot().get(child)!
    f.setSessions(f.sessionIds, id('session-2'))
    expect(f.pool.state.getSnapshot().get(child)).toBe(controller)
    f.emit('api-session/removed', child)
    expect(f.pending[0]!.signal.aborted).toBe(true)
    expect(f.pool.state.getSnapshot().has(child)).toBe(false)
    expect(f.childAddresses.has(child)).toBe(true)
    await expect(staleClaim.submit('must not resurrect', {} as never)).resolves.toMatchObject({ kind: 'error' })
    await f.succeed(0, 'late child response')
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(f.call).toHaveBeenCalledTimes(1)
    f.emit('api-session/added', { sessionId: child })
    await expect(f.submit(child, '')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('No previous BTW answer') })
    expect(f.pool.state.getSnapshot().get(child)).not.toBe(controller)
  })

  it('clears removal tombstones on reconnect baseline without reviving any previous answer', async () => {
    const f = fixture()
    const sessionId = id('session-1')
    const staleClaim = await f.claimFor(sessionId)
    await staleClaim.submit('remembered before removal', {} as never)
    await f.succeed(0, 'old generation answer')
    const old = f.pool.state.getSnapshot().get(sessionId)!
    f.emit('api-session/removed', sessionId)
    expect(old.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(keys(f.pool)).toEqual([])
    await expect(staleClaim.submit('same generation stale command', {} as never)).resolves.toMatchObject({ kind: 'error' })

    f.generation.set(undefined)
    f.setSessions([], undefined, 'pending')
    await expect(staleClaim.submit('disconnected stale command', {} as never)).resolves.toMatchObject({ kind: 'error' })
    expect(keys(f.pool)).toEqual([])
    f.generation.set(2)
    // Reconnection supplies a fresh catalog, not a live api-session/added replay.
    f.setSessions(f.sessionIds, sessionId)
    expect(keys(f.pool)).toEqual([])
    await expect(staleClaim.submit('', {} as never)).resolves.toMatchObject({
      kind: 'error', text: expect.stringContaining('No previous BTW answer'),
    })
    const fresh = f.pool.state.getSnapshot().get(sessionId)!
    expect(fresh).not.toBe(old)
    expect(fresh.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(old.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(f.call).toHaveBeenCalledTimes(1)
    await expect(staleClaim.submit('fresh generation question', {} as never)).resolves.toEqual({ kind: 'success' })
    await f.succeed(1, 'new generation answer')
    expect(fresh.state.getSnapshot()).toMatchObject({ status: 'success', response: 'new generation answer' })
    expect(old.state.getSnapshot()).toEqual({ status: 'closed' })
  })

  it('re-acquires at submission rather than retaining an evicted controller in an earlier command claim', async () => {
    const f = fixture()
    const first = id('session-1')
    const staleClaim = await f.claimFor(first)
    await staleClaim.submit('old answer', {} as never)
    await f.succeed(0)
    const old = f.pool.state.getSnapshot().get(first)!
    for (let index = 2; index <= 11; index++) f.pool.acquire(id(`session-${index}`))
    expect(f.pool.state.getSnapshot().has(first)).toBe(false)
    await expect(staleClaim.submit('', {} as never)).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('No previous BTW answer') })
    expect(f.pool.state.getSnapshot().get(first)).not.toBe(old)
    expect(f.pool.state.getSnapshot().size).toBe(10)
    expect(f.call).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes all root listeners, aborts requests, and rejects stale commands after teardown', async () => {
    const f = fixture()
    const first = id('session-1')
    const staleClaim = await f.claimFor(first)
    await staleClaim.submit('pending', {} as never)
    const controller = f.pool.state.getSnapshot().get(first)!
    expect(f.sessionList.subscribe).toHaveBeenCalledTimes(1)
    expect(f.workspaceList.subscribe).toHaveBeenCalledTimes(1)
    expect(f.generation.subscribe).toHaveBeenCalledTimes(1)
    expect([...f.handlers.values()].some(listeners => listeners.size > 0)).toBe(true)
    f.teardown()
    f.teardown()
    expect(f.stopSource).toHaveBeenCalledTimes(1)
    expect(f.stopSlot).toHaveBeenCalledTimes(1)
    for (const stop of [...f.sessionList.stops, ...f.workspaceList.stops, ...f.generation.stops, ...f.remoteStops]) {
      expect(stop).toHaveBeenCalledTimes(1)
    }
    expect([...f.handlers.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(f.pending[0]!.signal.aborted).toBe(true)
    expect(keys(f.pool)).toEqual([])
    await expect(staleClaim.submit('stale', {} as never)).resolves.toMatchObject({ kind: 'error' })
    await f.succeed(0)
    f.setSessions(f.sessionIds, id('session-2'))
    f.emit('api-session/added', { sessionId: first })
    expect(keys(f.pool)).toEqual([])
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(f.call).toHaveBeenCalledTimes(1)
  })
})
