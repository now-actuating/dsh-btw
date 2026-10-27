import type { BtwUsage } from '../shared/protocol.js';
/** A configured strategy is not evidence of a hit: only provider usage is. */
export declare function cacheUsageLabel(usage: BtwUsage | undefined): string;
