import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ClientEventDefinitionRegistry, GatewayEventRouter } from '../src/client/client-event-router.mjs'
import { SessionJournalRegistry } from '../src/session/session-journal-registry.mjs'

test('business receipt survives concurrent retries without repeating side effects', async () => {
  let calls = 0
  const router = new GatewayEventRouter({ registry: new ClientEventDefinitionRegistry({ definitions: [{
    name: 'showroom.activate', schema: z.object({}),
    async handle() { calls++; await new Promise(resolve => setTimeout(resolve, 10)) },
    receipt() { return { renderer_authorization: { token: 'server-issued' } } },
  }] }) })
  const message = { event_id: 'one', name: 'showroom.activate', data: {} }
  const options = { source: { ownerId: 'one', sessionId: 'visit' } }
  const [first, retry] = await Promise.all([router.publish(message, options), router.publish(message, options)])
  assert.equal(calls, 1)
  assert.equal(retry.duplicate, true)
  assert.deepEqual(retry.receipt, first.receipt)
  first.receipt.renderer_authorization.token = 'mutated'
  assert.equal((await router.publish(message, options)).receipt.renderer_authorization.token, 'server-issued')
  await router.publish(message, { source: { ownerId: 'two', sessionId: 'visit' } })
  assert.equal(calls, 2)
})

test('retirement purges visitor text durably and fences late text for only that visitor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fork-retirement-'))
  try {
    let registry = new SessionJournalRegistry({ directory })
    for (const sessionId of ['old', 'new']) await registry.append({ ownerId: 'owner', sessionId, event: { type: 'user/message', text: 'private' } })
    assert.equal((await registry.retireSession('owner', 'old')).retired, true)
    registry = new SessionJournalRegistry({ directory })
    assert.equal(await registry.append({ ownerId: 'owner', sessionId: 'old', event: { type: 'user/message', text: 'late' } }), null)
    assert.equal((await registry.read('owner', 'old')).length, 1)
    assert.equal((await registry.read('owner', 'new')).length, 2)
    assert.equal((await registry.retireSession('owner', 'old')).retainedTasks, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('retirement retains unresolved work until its terminal delivery is recorded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fork-tasks-'))
  try {
    const registry = new SessionJournalRegistry({ directory })
    const append = task => registry.append({ ownerId: 'owner', sessionId: 'visit', event: { type: 'qwaudio/task/event', payload: { task } } })
    await append({ id: 'task', status: 'running' })
    assert.equal((await registry.retireSession('owner', 'visit')).retainedTasks, 1)
    await append({ id: 'task', status: 'completed', notificationStatus: 'pending' })
    assert.equal((await registry.read('owner', 'visit')).length, 2)
    await append({ id: 'task', status: 'completed', notificationStatus: 'delivered' })
    assert.equal((await registry.read('owner', 'visit')).length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
