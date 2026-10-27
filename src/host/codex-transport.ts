import type { Context } from '@deepseek-ai/cordis'

type Entry = { options?: { id?: string; name?: string }; fiber?: { config?: Record<string, unknown> } }

/** This local integration shares only SSE cache affinity, never WS continuation. */
export function requireSafeCodexTransport(ctx: Context, provider: string): void {
  if (provider !== 'openai-codex') return
  const loader = (ctx as unknown as { loader?: { entries(): Iterable<Entry> } }).loader
  const entry = loader === undefined ? undefined : [...loader.entries()].find(item =>
    item.options?.id === 'codex-subscription' && item.options?.name === 'dsh-codex-subscription')
  if (entry?.fiber?.config === undefined) {
    throw new Error('BTW cannot verify the active Codex subscription transport. No request was sent.')
  }
  const raw = entry.fiber.config.connectionMode
  const mode = typeof (raw as { get?: unknown } | undefined)?.get === 'function'
    ? (raw as { get(): unknown }).get()
    : raw
  // dsh-codex-subscription 3.1.1 defaults an absent mode to SSE.
  if (mode !== undefined && mode !== 'sse') {
    throw new Error('BTW requires Codex Connection mode: SSE. WebSocket mode is not supported because it shares continuation state with the main session. No request was sent.')
  }
}
