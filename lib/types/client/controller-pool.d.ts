import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { BtwController } from './controller.js';
export declare const BTW_CONTROLLER_LIMIT = 10;
/** Page-memory ownership only: never retains a Session scope or its history. */
export declare class BtwControllerPool {
    private readonly create;
    private readonly available;
    private readonly controllers;
    private disposed;
    readonly state: import("@deepseek-ai/dsh-client-store").SnapshotStore<ReadonlyMap<SessionId, BtwController>>;
    constructor(create: (id: SessionId) => BtwController, available: (id: SessionId) => boolean);
    acquire(id: SessionId): BtwController | undefined;
    /** An actual revisit promotes an existing entry; merely browsing never allocates. */
    touch(id: SessionId): void;
    remove(id: SessionId): void;
    reconcile(): void;
    dispose(): void;
    private publish;
}
