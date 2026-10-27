import { type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import { type BtwUsage } from '../shared/protocol.js';
export type BtwOverlayState = {
    readonly status: 'closed';
} | {
    readonly status: 'running';
    readonly question: string;
} | {
    readonly status: 'success';
    readonly question: string;
    readonly response: string;
    readonly usage?: BtwUsage;
} | {
    readonly status: 'error';
    readonly question: string;
    readonly error: string;
};
export declare class BtwController {
    private readonly connection;
    private readonly sessionId;
    private readonly timeoutMs;
    readonly state: SnapshotStore<BtwOverlayState>;
    readonly running: SnapshotStore<boolean>;
    private active;
    private disposed;
    private lastSuccess;
    constructor(connection: ConnectionHandle, sessionId: SessionId, timeoutMs?: number);
    ask(rawQuestion: string): Promise<SubmitOutcome>;
    private run;
    dismiss(): void;
    dispose(): void;
}
