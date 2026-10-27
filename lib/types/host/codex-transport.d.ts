import type { Context } from '@deepseek-ai/cordis';
/** This local integration shares only SSE cache affinity, never WS continuation. */
export declare function requireSafeCodexTransport(ctx: Context, provider: string): void;
