import { describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { runBtwOneShot } from '../src/host/one-shot.js'
import { btwPiAiAdapter } from '../src/host/btw-pi-ai-adapter.js'
import type { BtwContextSnapshot } from '../src/host/context-snapshot.js'

vi.mock('../src/host/btw-pi-ai-adapter.js', () => ({
  btwPiAiAdapter: vi.fn(() => { throw new Error('must not clone the Codex adapter') }),
}))

describe('registered Codex route', () => {
  it('never enters the isolated PiAi delegate, even when a registered adapter could look like PiAiAdapter', async () => {
    const stream = vi.fn(async function* () {
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'OK' } }
      yield { type: 'usage' as const, usage: { inputTokens: 300, outputTokens: 2, cacheReadTokens: 12000 } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const runtime = { prepareCall: async (config: unknown) => ({ config, stream }) } as unknown as LlmRuntime
    const snapshot = { parentSessionId: 'parent', config: { provider: 'openai-codex', model: 'gpt-6.1-sol' }, sharedMessages: [], messages: [] } as unknown as BtwContextSnapshot
    const result = await runBtwOneShot(runtime, snapshot, 'separate-side', new AbortController().signal)
    expect(btwPiAiAdapter).not.toHaveBeenCalled()
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'parent' })
    expect(result.usage?.cacheReadTokens).toBe(12000)
  })
})
