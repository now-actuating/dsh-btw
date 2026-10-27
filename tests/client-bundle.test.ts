import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import * as ReactJsx from 'react/jsx-runtime'
import * as Store from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BtwControllerPool } from '../src/client/controller-pool.js'

describe('prebuilt client artifact', () => {
  it('loads against the platform table, stays lazy, and disposes root-owned controllers', async () => {
    const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    let plugin: { apply(ctx: unknown): void } | undefined
    const modules: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': ReactJsx,
      '@deepseek-ai/dsh-client-store': Store,
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    runInNewContext(code, { AbortController, AbortSignal, window: { __ModuleLoader__: { load(entry: { id: string; factory(require: (id: string) => unknown): typeof plugin }) {
      expect(entry.id).toBe('dsh-btw')
      plugin = entry.factory(id => { expect(modules).toHaveProperty(id); return modules[id] })
    } } } })
    const cleanup: Array<() => void> = []
    const effect = (callback: () => (() => void)) => { cleanup.push(callback()) }
    let registration: { inject(id: string): { pool: BtwControllerPool; sessionId: SessionId } } | undefined
    let signal: AbortSignal | undefined
    const services = {
      connection: { generation: Store.createSnapshotStore<number | undefined>(1), rpc: { call: (_c: string, _e: string, _p: unknown, s: AbortSignal) => {
        signal = s
        return new Promise(() => {})
      } } },
      inputTriggers: { registerSource: () => () => {} },
      sessions: {
        list: Store.createSnapshotStore({ phase: 'ready', byId: { one: { id: 'one', retainedBy: { mainView: 1 } } } }),
        subagentAddress: () => undefined,
      },
      workspaces: { list: Store.createSnapshotStore({ phase: 'ready', archivedSessionIds: [] }) },
    }
    const ctx = { effect, get: (key: keyof typeof services) => services[key],
      remote: { $on: () => () => {} }, slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (options: typeof registration) => { registration = options; return () => {} },
      },
    }
    expect(plugin).toBeDefined()
    plugin!.apply(ctx)
    const { pool, sessionId } = registration!.inject('one')
    expect(pool.state.getSnapshot().size).toBe(0)
    const first = pool.acquire(sessionId)!
    expect(registration!.inject('one').pool).toBe(pool)
    expect(pool.acquire(sessionId)).toBe(first)
    await first.ask('test')
    expect(signal!.aborted).toBe(false)
    for (const dispose of cleanup.reverse()) dispose()
    expect(signal!.aborted).toBe(true)
    expect(first.state.getSnapshot()).toEqual({ status: 'closed' })
    expect(pool.state.getSnapshot().size).toBe(0)
    expect(pool.acquire(sessionId)).toBeUndefined()
    expect(code).not.toContain('dsh-client-runtime')
  })
})
