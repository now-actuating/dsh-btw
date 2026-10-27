import { ToolCallId, LlmAdapter, LlmRuntime, createSystemMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { runBtwOneShot } from '../src/host/one-shot.js'
import type { BtwContextSnapshot } from '../src/host/context-snapshot.js'

async function* chunks(): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'side ' }
  yield { type: 'text-delta', index: 0, text: 'answer' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'side answer' } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('runBtwOneShot', () => {
  it('uses the real official prepared-call runtime once, without writing to a main session', async () => {
    const ctx = new Context()
    const runtime = new LlmRuntime(ctx)
    const requests: GenerateOptions[] = []
    class Adapter extends LlmAdapter {
      stream(options: GenerateOptions) { requests.push(options); return chunks() }
    }
    const dispose = runtime.registerAdapter(['local-test'], new Adapter())
    const messages = [createSystemMessage('official history system', 'test')]
    try {
      const result = await runBtwOneShot(runtime, {
        parentSessionId: 'main', config: { provider: 'local-test', model: 'mock' },
        sharedMessages: messages, messages,
      }, 'side', new AbortController().signal)
      expect(result.response).toBe('side answer')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.sessionId).toBe('side')
      expect(requests[0]?.messages).toEqual(messages)
      expect(requests[0]).not.toHaveProperty('system')
    } finally { dispose(); await ctx.fiber.dispose() }
  })
  it('dispatches one request with the exact header and tool catalog', async () => {
    let seen: GenerateOptions | undefined
    const llm = {
      prepareCall: async (config: BtwContextSnapshot['config']) => ({
        config,
        stream: (options: GenerateOptions) => {
          seen = options
          return chunks()
        },
      }),
    } as unknown as LlmRuntime
    const snapshot: BtwContextSnapshot = {
      parentSessionId: 'parent',
      config: { provider: 'mock', model: 'same', reasoningEffort: 'max' as never, temperature: 0.2 },
      system: 'byte-identical system',
      tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }],
      sharedMessages: [],
      messages: [],
    }
    const result = await runBtwOneShot(llm, snapshot, 'sidechain', new AbortController().signal)
    expect(result.response).toBe('side answer')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
    expect(seen).toMatchObject({
      provider: 'mock',
      model: 'same',
      system: 'byte-identical system',
      tools: snapshot.tools,
      temperature: 0.2,
    })
  })

  it('uses the registered Codex adapter with parent cache identity, without cloning or replacing it', async () => {
    const seen: GenerateOptions[] = []
    const usage = { inputTokens: 100, outputTokens: 2, cacheReadTokens: 12000 }
    const llm = {
      prepareCall: async (config: BtwContextSnapshot['config']) => ({
        config,
        stream: (options: GenerateOptions) => {
          seen.push(options)
          return (async function* () { yield* chunks(); yield { type: 'usage' as const, usage } })()
        },
      }),
    } as unknown as LlmRuntime
    const snapshot = { parentSessionId: 'parent', config: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
      tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }],
      sharedMessages: [], messages: [], toolHistory: [] } as unknown as BtwContextSnapshot
    const result = await runBtwOneShot(llm, snapshot, 'private-sidechain', new AbortController().signal)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe('parent')
    expect(seen[0]?.tools).toEqual(snapshot.tools)
    expect(result.cacheStrategy).toBe('parent-session-prefix')
    expect(result.usage?.cacheReadTokens).toBe(12000)
  })

  it('surfaces a tool attempt instead of executing it', async () => {
    async function* toolChunks(): AsyncGenerator<StreamChunk> {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'read_file', arguments: '{}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    const llm = {
      prepareCall: async (config: BtwContextSnapshot['config']) => ({
        config,
        stream: () => toolChunks(),
      }),
    } as unknown as LlmRuntime
    const snapshot: BtwContextSnapshot = {
      parentSessionId: 'parent',
      config: { provider: 'mock', model: 'same' },
      sharedMessages: [],
      messages: [],
    }
    const result = await runBtwOneShot(llm, snapshot, 'sidechain', new AbortController().signal)
    expect(result.response).toContain('tried to call read_file')
  })
})
