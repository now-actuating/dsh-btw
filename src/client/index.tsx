import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BtwController } from './controller.js'
import { BtwControllerPool } from './controller-pool.js'
import { createBtwInputSource } from './input-source.js'
import { BtwOverlay } from './overlay.js'

export const name = 'btw-client'
export const inject = ['connection', 'inputTriggers', 'sessions', 'workspaces', 'remote', 'slots']

interface BtwDockInjected {
  readonly pool: BtwControllerPool
  readonly sessionId: SessionId
}

function BtwDock({ pool, sessionId }: BtwDockInjected) {
  const controllers = useSyncExternalStore(
    listener => pool.state.subscribe(listener),
    () => pool.state.getSnapshot(),
  )
  const controller = controllers.get(sessionId)
  return controller === undefined ? null : <BtwOverlay controller={controller} />
}

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract | undefined
  const sessions = ctx.get('sessions') as ISessions | undefined
  const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
  if (connection === undefined || inputTriggers === undefined || sessions === undefined || workspaces === undefined) {
    throw new Error('dsh-btw/client requires connection, inputTriggers, sessions, and workspaces')
  }

  const removed = new Set<SessionId>()
  const available = (sessionId: SessionId): boolean => {
    if (removed.has(sessionId)) return false
    const workspaceList = workspaces.list.getSnapshot()
    if (workspaceList.phase === 'ready' && workspaceList.archivedSessionIds.includes(sessionId)) return false
    const sessionList = sessions.list.getSnapshot()
    // Addressed children may have no top-level catalog row. Pending/reconnecting
    // lists are not evidence of removal, nor is a view's reference count.
    return sessionList.phase !== 'ready' || sessionList.byId[sessionId] !== undefined
      || sessions.subagentAddress(sessionId) !== undefined
  }
  const pool = new BtwControllerPool(id => new BtwController(connection, id), available)
  ctx.effect(() => inputTriggers.registerSource(createBtwInputSource(id => pool.acquire(id))), 'dsh-btw: slash source')
  ctx.effect(() => {
    let mainViews = new Set<SessionId>()
    const reconcileSessions = (): void => {
      pool.reconcile()
      const current = new Set<SessionId>()
      for (const row of Object.values(sessions.list.getSnapshot().byId)) {
        if (Object.entries(row.retainedBy).some(([source, count]) => source === 'mainView' && (count ?? 0) > 0)) {
          current.add(row.id)
          if (!mainViews.has(row.id)) pool.touch(row.id)
        }
      }
      mainViews = current
    }
    const stopSessions = sessions.list.subscribe(reconcileSessions)
    const stopWorkspaces = workspaces.list.subscribe(() => pool.reconcile())
    // Removal of a durable child can leave a catalog/address fallback behind;
    // the explicit Host removal event must still retire its BTW controller.
    const stopRemoved = ctx.remote.$on('api-session/removed', id => {
      removed.add(id)
      pool.remove(id)
    })
    const stopAdded = ctx.remote.$on('api-session/added', summary => removed.delete(summary.sessionId))
    let generation = connection.generation.getSnapshot()
    const stopGeneration = connection.generation.subscribe(() => {
      const next = connection.generation.getSnapshot()
      // A reconnected Host sends a catalog baseline, not a replay of every
      // added event. Tombstones protect stale child addresses only within the
      // connection generation that observed removal; answers are never revived.
      if (next !== undefined && next !== generation) removed.clear()
      generation = next
    })
    reconcileSessions()
    return () => {
      stopSessions()
      stopWorkspaces()
      stopRemoved()
      stopAdded()
      stopGeneration()
      removed.clear()
      mainViews.clear()
      pool.dispose()
    }
  }, 'dsh-btw: root controller ownership')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'btw-panel',
    order: 2,
    // Injection is a pure render-time projection, not a controller acquisition.
    inject: (scopeId): BtwDockInjected => ({ pool, sessionId: SessionId(scopeId) }),
  }, BtwDock))
}
