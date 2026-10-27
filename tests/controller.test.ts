import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { BtwController } from '../src/client/controller.js'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T>(initial: T) => {
    let value = initial
    return {
      getSnapshot: () => value,
      subscribe: () => () => {},
      update: (mutator: (draft: T) => void) => mutator(value),
      set: (next: T) => { value = next },
    }
  },
}))

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function mockRpc() {
  const pending: Array<{ payload: { requestId: string }; signal: AbortSignal; resolve: (value: unknown) => void }> = []
  const call = vi.fn((_channel: string, _endpoint: string, payload: { requestId: string }, signal: AbortSignal) =>
    new Promise(resolve => { pending.push({ payload, signal, resolve }) }))
  const connection = { rpc: { call } } as unknown as ConnectionHandle
  const succeed = async (index: number, answer = 'answer') => {
    const request = pending[index]!
    request.resolve({ ok: true, value: { requestId: request.payload.requestId,
      sidechainId: 'sidechain', response: answer, cacheStrategy: 'provider-managed',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, cacheWriteTokens: 0 },
    } })
    await flush()
  }
  return { connection, call, pending, succeed }
}

describe('BtwController recall', () => {
  it('recalls the latest successful answer and cache usage repeatedly without an RPC', async () => {
    const rpc = mockRpc()
    const controller = new BtwController(rpc.connection, 'session' as SessionId)
    await controller.ask('first'); await rpc.succeed(0)
    await controller.ask('second'); await rpc.succeed(1, 'new answer')
    const success = controller.state.getSnapshot()
    expect(success).toMatchObject({ status: 'success', question: 'second', response: 'new answer', usage: { cacheReadTokens: 8 } })
    for (let i = 0; i < 3; i++) {
      controller.dismiss()
      await expect(controller.ask(' \n ')).resolves.toEqual({ kind: 'success' })
      expect(controller.state.getSnapshot()).toEqual(success)
    }
    expect(rpc.call).toHaveBeenCalledTimes(2)
  })

  it('shows guidance without a request or state change when no success exists', async () => {
    const rpc = mockRpc()
    const controller = new BtwController(rpc.connection, 'session' as SessionId)
    await expect(controller.ask('')).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('No previous BTW answer') })
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('does not replace success with an error or a cancelled late response', async () => {
    const rpc = mockRpc()
    const controller = new BtwController(rpc.connection, 'session' as SessionId)
    await controller.ask('good'); await rpc.succeed(0)
    const success = controller.state.getSnapshot()
    await controller.ask('fails')
    rpc.pending[1]!.resolve({ ok: false, error: { message: 'failed' } }); await flush()
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'error' })
    controller.dismiss(); await controller.ask('')
    expect(controller.state.getSnapshot()).toEqual(success)
    await controller.ask('cancelled'); controller.dismiss()
    expect(rpc.pending[2]!.signal.aborted).toBe(true)
    await rpc.succeed(2, 'must not be remembered')
    await controller.ask('')
    expect(controller.state.getSnapshot()).toEqual(success)
    expect(rpc.call).toHaveBeenCalledTimes(3)
  })

  it('isolates sessions and loses recall when the controller is recreated or disposed', async () => {
    const rpc = mockRpc()
    const first = new BtwController(rpc.connection, 'one' as SessionId)
    await first.ask('private'); await rpc.succeed(0)
    const other = new BtwController(rpc.connection, 'two' as SessionId)
    const recreated = new BtwController(rpc.connection, 'one' as SessionId)
    for (const controller of [other, recreated]) {
      await expect(controller.ask('')).resolves.toMatchObject({ kind: 'error' })
      expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
    }
    first.dispose()
    await expect(first.ask('')).resolves.toMatchObject({ kind: 'error' })
    await expect(first.ask('new')).resolves.toMatchObject({ kind: 'error' })
    expect(first.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(rpc.call).toHaveBeenCalledTimes(1)
  })

  it('recall does not restart or abort an in-flight request', async () => {
    const rpc = mockRpc()
    const controller = new BtwController(rpc.connection, 'session' as SessionId)
    await controller.ask('first'); await rpc.succeed(0)
    const success = controller.state.getSnapshot()
    await controller.ask('next')
    await controller.ask('')
    expect(controller.state.getSnapshot()).toEqual(success)
    expect(rpc.pending[1]!.signal.aborted).toBe(false)
    expect(controller.running.getSnapshot()).toBe(true)
    expect(rpc.call).toHaveBeenCalledTimes(2)
    await rpc.succeed(1, 'next answer')
    expect(controller.state.getSnapshot()).toMatchObject({ question: 'next', response: 'next answer' })
    expect(controller.running.getSnapshot()).toBe(false)
  })
})

describe('BtwController activity', () => {
  it('does not let an old request settlement clear replacement activity', async () => {
    const rpc = mockRpc()
    const controller = new BtwController(rpc.connection, 'session' as SessionId)
    expect(controller.running.getSnapshot()).toBe(false)
    await controller.ask('first')
    await controller.ask('second')
    expect(rpc.pending[0]!.signal.aborted).toBe(true)
    await rpc.succeed(0, 'stale')
    expect(controller.running.getSnapshot()).toBe(true)
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'running', question: 'second' })
    await rpc.succeed(1)
    expect(controller.running.getSnapshot()).toBe(false)
    await controller.ask('third')
    controller.dispose()
    expect(controller.running.getSnapshot()).toBe(false)
    await rpc.succeed(2)
    expect(controller.running.getSnapshot()).toBe(false)
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
  })

  it('clears activity on business failure and invalid responses', async () => {
    const rpc = mockRpc()
    const controller = new BtwController(rpc.connection, 'session' as SessionId)
    await controller.ask('fails')
    rpc.pending[0]!.resolve({ ok: false, error: { message: 'failed' } })
    await flush()
    expect(controller.running.getSnapshot()).toBe(false)
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'error' })
    await controller.ask('invalid')
    rpc.pending[1]!.resolve({ ok: true, value: {} })
    await flush()
    expect(controller.running.getSnapshot()).toBe(false)
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'error' })
  })

  it('clears activity on timeout and preserves a previous success', async () => {
    let calls = 0
    const connection = { rpc: { call: (_c: string, _e: string, payload: { requestId: string }, signal: AbortSignal) => {
      if (calls++ === 0) return Promise.resolve({ ok: true, value: {
        requestId: payload.requestId, sidechainId: 'side', response: 'old', cacheStrategy: 'provider-managed',
      } })
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } } } as unknown as ConnectionHandle
    const controller = new BtwController(connection, 'session' as SessionId, 10)
    await controller.ask('good'); await flush()
    await controller.ask('slow')
    await vi.waitFor(() => expect(controller.running.getSnapshot()).toBe(false))
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'error', error: 'The BTW request timed out.' })
    await controller.ask('')
    expect(controller.state.getSnapshot()).toMatchObject({ status: 'success', response: 'old' })
  })
})

describe('BtwController', () => {
  it('releases the composer before the background RPC completes', async () => {
    let complete: ((value: unknown) => void) | undefined
    let actualRequestId: string | undefined
    const connection = {
      rpc: {
        call: (_channel: string, _endpoint: string, payload: unknown) => {
          actualRequestId = (payload as { requestId: string }).requestId
          return new Promise(resolve => { complete = resolve })
        },
      },
    } as unknown as ConnectionHandle
    const controller = new BtwController(connection, 'session' as SessionId, 1_000)

    await expect(controller.ask('side question')).resolves.toEqual({ kind: 'success' })
    expect(controller.state.getSnapshot()).toEqual({ status: 'running', question: 'side question' })

    complete?.({
      ok: true,
      value: {
        requestId: actualRequestId,
        sidechainId: 'sidechain',
        response: 'answer',
        cacheStrategy: 'provider-managed',
      },
    })
    await flush()
    expect(controller.state.getSnapshot()).toEqual({
      status: 'success',
      question: 'side question',
      response: 'answer',
    })
  })

  it('aborts the background RPC when the overlay is dismissed', async () => {
    let capturedSignal: AbortSignal | undefined
    const connection = {
      rpc: {
        call: (_channel: string, _endpoint: string, _payload: unknown, signal: AbortSignal) => {
          capturedSignal = signal
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      },
    } as unknown as ConnectionHandle
    const controller = new BtwController(connection, 'session' as SessionId, 1_000)

    await controller.ask('side question')
    controller.dismiss()
    await flush()

    expect(capturedSignal?.aborted).toBe(true)
    expect(controller.state.getSnapshot()).toEqual({ status: 'closed' })
  })
})
