import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { requireSafeCodexTransport } from '../src/host/codex-transport.js'

const ctx = (mode?: unknown) => ({ loader: { entries: () => [{ options: { id: 'codex-subscription', name: 'dsh-codex-subscription' }, fiber: { config: { connectionMode: mode } } }] } }) as unknown as Context

describe('Codex transport safety', () => {
  it('accepts the current SSE transport and its documented default', () => {
    expect(() => requireSafeCodexTransport(ctx('sse'), 'openai-codex')).not.toThrow()
    expect(() => requireSafeCodexTransport(ctx(), 'openai-codex')).not.toThrow()
    expect(() => requireSafeCodexTransport(ctx({ get: () => 'sse' }), 'openai-codex')).not.toThrow()
  })
  it('fails closed for WebSocket and unknown transports, including live setting getters', () => {
    for (const mode of ['websocket', 'unknown', { get: () => 'websocket' }]) {
      expect(() => requireSafeCodexTransport(ctx(mode), 'openai-codex')).toThrow('No request was sent')
    }
    expect(() => requireSafeCodexTransport({} as Context, 'openai-codex')).toThrow('cannot verify')
  })
  it('does not gate other provider routes', () => {
    expect(() => requireSafeCodexTransport({} as Context, 'anthropic')).not.toThrow()
  })
})
