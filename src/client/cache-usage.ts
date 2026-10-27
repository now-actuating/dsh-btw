import type { BtwUsage } from '../shared/protocol.js'

/** A configured strategy is not evidence of a hit: only provider usage is. */
export function cacheUsageLabel(usage: BtwUsage | undefined): string {
  if (usage === undefined || usage.cacheReadTokens === undefined) return 'Cache: not reported by provider'
  const cached = usage.cacheReadTokens
  if (cached <= 0) return 'Cache miss · 0 cached input tokens'
  const totalInput = usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0)
  const percent = totalInput > 0 ? Math.round(cached / totalInput * 1000) / 10 : 0
  return `Cache hit · ${cached.toLocaleString('en-US')} cached input tokens · ${percent}% of input`
}
