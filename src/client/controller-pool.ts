import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BtwController } from './controller.js'

export const BTW_CONTROLLER_LIMIT = 10

/** Page-memory ownership only: never retains a Session scope or its history. */
export class BtwControllerPool {
  private readonly controllers = new Map<SessionId, BtwController>()
  private disposed = false
  readonly state = createSnapshotStore<ReadonlyMap<SessionId, BtwController>>(new Map())

  constructor(
    private readonly create: (id: SessionId) => BtwController,
    private readonly available: (id: SessionId) => boolean,
  ) {}

  acquire(id: SessionId): BtwController | undefined {
    if (this.disposed || !this.available(id)) return undefined
    const existing = this.controllers.get(id)
    if (existing !== undefined) {
      this.touch(id)
      return existing
    }
    if (this.controllers.size >= BTW_CONTROLLER_LIMIT) {
      const oldest = this.controllers.keys().next().value
      if (oldest !== undefined) this.remove(oldest)
    }
    const controller = this.create(id)
    this.controllers.set(id, controller)
    this.publish()
    return controller
  }

  /** An actual revisit promotes an existing entry; merely browsing never allocates. */
  touch(id: SessionId): void {
    const controller = this.controllers.get(id)
    if (controller === undefined || this.disposed) return
    const newest = [...this.controllers.keys()].at(-1)
    if (newest === id) return
    this.controllers.delete(id)
    this.controllers.set(id, controller)
    this.publish()
  }

  remove(id: SessionId): void {
    const controller = this.controllers.get(id)
    if (controller === undefined) return
    this.controllers.delete(id)
    controller.dispose()
    this.publish()
  }

  reconcile(): void {
    for (const id of this.controllers.keys()) {
      if (!this.available(id)) this.remove(id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const controllers = [...this.controllers.values()]
    this.controllers.clear()
    for (const controller of controllers) controller.dispose()
    this.publish()
  }

  private publish(): void {
    this.state.set(new Map(this.controllers))
  }
}
