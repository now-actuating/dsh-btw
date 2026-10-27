import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BtwController } from '../src/client/controller.js'
import { BtwOverlay } from '../src/client/overlay.js'

const harness = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  root: { focus: vi.fn(), contains: vi.fn(() => false), querySelector: vi.fn() },
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useRef: () => ({ current: harness.root }),
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect()
    if (cleanup !== undefined) harness.cleanups.push(cleanup)
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: () => null }))

function elements(element: ReactElement): ReactElement[] {
  const children = (element.props as { children?: unknown }).children
  return [element, ...[children].flat(Infinity).flatMap(child =>
    child !== null && typeof child === 'object' && 'type' in child ? elements(child as ReactElement) : [])]
}
function render(controller: BtwController) {
  const tree = BtwOverlay({ controller })!
  const all = elements(tree)
  const dialog = all.find(element => (element.props as { role?: string }).role === 'dialog')!
  const button = all.find(element => element.type === 'button')!
  return {
    key: (key: string) => {
      const event = { key, preventDefault: vi.fn() }
      ;(dialog.props as { onKeyDown: (event: unknown) => void }).onKeyDown(event)
      return event
    },
    label: (button.props as { children: string }).children,
    click: () => (button.props as { onClick: () => void }).onClick(),
  }
}
function request() {
  let resolve!: (value: unknown) => void
  let signal!: AbortSignal
  let id!: string
  const connection = { rpc: { call: (_c: string, _e: string, payload: { requestId: string }, s: AbortSignal) => {
    signal = s; id = payload.requestId
    return new Promise(r => { resolve = r })
  } } } as unknown as ConnectionHandle
  const controller = new BtwController(connection, 'one' as SessionId)
  return { controller, aborted: () => signal.aborted, async succeed() {
    resolve({ ok: true, value: { requestId: id, sidechainId: 'side', response: 'answer', cacheStrategy: 'provider-managed' } })
    await new Promise(r => setTimeout(r, 0))
  } }
}

let outside: ((event: unknown) => void) | undefined
beforeEach(() => {
  vi.stubGlobal('Node', class {})
  vi.stubGlobal('document', {
    addEventListener: vi.fn((_type: string, listener: (event: unknown) => void) => { outside = listener }),
    removeEventListener: vi.fn(),
  })
})
afterEach(() => {
  for (const cleanup of harness.cleanups.splice(0)) cleanup()
  outside = undefined
  vi.unstubAllGlobals()
})

describe('BTW overlay user cancellation', () => {
  it('ignores outside clicks and dismissal keys while active; only the button cancels', async () => {
    const rpc = request()
    await rpc.controller.ask('question')
    const ui = render(rpc.controller)
    expect(ui.label).toBe('Cancel')
    outside!({ target: new Node() })
    for (const key of ['Escape', 'Enter', ' ']) expect(ui.key(key).preventDefault).not.toHaveBeenCalled()
    expect(rpc.aborted()).toBe(false)
    expect(rpc.controller.state.getSnapshot()).toMatchObject({ status: 'running' })
    ui.click()
    expect(rpc.aborted()).toBe(true)
    expect(rpc.controller.running.getSnapshot()).toBe(false)
    expect(rpc.controller.state.getSnapshot()).toEqual({ status: 'closed' })
  })

  it('uses real activity rather than recalled success to protect a newer request', async () => {
    const rpc = request()
    await rpc.controller.ask('first'); await rpc.succeed()
    await rpc.controller.ask('next'); await rpc.controller.ask('')
    expect(rpc.controller.state.getSnapshot()).toMatchObject({ status: 'success' })
    const ui = render(rpc.controller)
    expect(ui.label).toBe('Cancel')
    outside!({ target: new Node() })
    ui.key('Escape')
    expect(rpc.aborted()).toBe(false)
    ui.click()
    expect(rpc.aborted()).toBe(true)
  })

  it('keeps outside and keyboard closing after completion without clearing recall', async () => {
    const rpc = request()
    await rpc.controller.ask('question'); await rpc.succeed()
    expect(render(rpc.controller).label).toBe('Close')
    outside!({ target: new Node() })
    expect(rpc.controller.state.getSnapshot()).toEqual({ status: 'closed' })
    await rpc.controller.ask('')
    const ui = render(rpc.controller)
    expect(ui.key('Escape').preventDefault).toHaveBeenCalledOnce()
    expect(rpc.controller.state.getSnapshot()).toEqual({ status: 'closed' })
    await expect(rpc.controller.ask('')).resolves.toMatchObject({ kind: 'success' })
  })

  it('checks live activity in an already attached outside handler', async () => {
    const rpc = request()
    await rpc.controller.ask('question')
    render(rpc.controller)
    await rpc.succeed()
    outside!({ target: new Node() })
    expect(rpc.controller.state.getSnapshot()).toEqual({ status: 'closed' })
  })
})
