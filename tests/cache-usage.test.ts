import { describe, expect, it } from 'vitest'
import { cacheUsageLabel } from '../src/client/cache-usage.js'
import { readAskResponse } from '../src/shared/protocol.js'

describe('provider cache evidence', () => {
  it('does not label configuration or absent telemetry as a hit', () => {
    expect(cacheUsageLabel(undefined)).toContain('not reported')
    expect(cacheUsageLabel({ inputTokens: 100, outputTokens: 2 })).toContain('not reported')
    expect(cacheUsageLabel({ inputTokens: 100, outputTokens: 2, cacheReadTokens: 0 })).toContain('Cache miss')
  })
  it('uses noncached input plus cached input, excluding generated output', () => {
    expect(cacheUsageLabel({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000 }))
      .toBe('Cache hit · 9,000 cached input tokens · 90% of input')
  })
  it('validates the parent-prefix strategy and rejects malformed usage', () => {
    const response = { requestId: 'q', sidechainId: 'side', response: 'answer', cacheStrategy: 'parent-session-prefix',
      usage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 9000 } }
    expect(readAskResponse(response)).toEqual(response)
    expect(readAskResponse({ ...response, usage: { ...response.usage, cacheReadTokens: -1 } })).toBeUndefined()
  })
})
