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
import { ClientActionPort, ClientActionName } from '../src/client/client-action-port.mjs'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'
import { normalizeGatewayClientProtocolMessage, gatewayClientProtocolCapabilityFor } from '../../shared/protocol/gateway-client-protocol.mjs'

test('explicit commit is capability gated and does not start an audio input', () => {
  assert.equal(normalizeGatewayClientProtocolMessage({ type: 'input_audio_buffer.commit', event_id: 'commit' }).type, 'audio.commit')
  assert.equal(gatewayClientProtocolCapabilityFor('input_audio_buffer.commit'), 'input.audio')
  const sent = []
  const frontend = new RealtimeFrontend({ provider: REALTIME_PROVIDERS.dashscope })
  frontend.protocol = { audioCommit: () => ({ type: 'commit' }), playbackReceipt: (...args) => ({ args }) }
  frontend.send = event => sent.push(event)
  frontend.ready = true
  assert.equal(frontend.commitAudio(), false)
  frontend.audioInputStarted = true
  assert.equal(frontend.commitAudio(), true)
  assert.equal(frontend.observePlaybackReceipt('playback.ended', 'response', 'done'), true)
  assert.deepEqual(sent[1].args, ['playback.ended', 'response', 'done'])
  frontend.ready = false
  assert.equal(frontend.commitAudio(), false)
  assert.equal(frontend.observePlaybackReceipt('playback.ended', 'stale'), false)
})

test('trusted delivery carries origin and a distinct provider generation', async () => {
  const first = new RealtimeFrontend({ provider: REALTIME_PROVIDERS.dashscope })
  const next = new RealtimeFrontend({ provider: REALTIME_PROVIDERS.dashscope })
  assert.ok(next.providerGeneration > first.providerGeneration)
  let received
  first.provider = { buildResultInjection(_text, options) { received = options; return { item: {} } } }
  first.createConversationItem = async () => {}
  const outcome = await first.injectDelivery('trusted context', 'client-event', { visit: 'one' }, { route: 'context', contextTiming: 'immediate' })
  assert.equal(received.origin, 'client-event')
  assert.deepEqual(received.correlation, { visit: 'one' })
  assert.equal(outcome.contextInjected, true)
  assert.equal(outcome.providerGeneration, first.providerGeneration)
})

test('cancelled actions reconcile a late terminal once and close clears observers', async () => {
  let request
  const port = new ClientActionPort({ send: event => { request = event }, getCapabilities: () => ['client.actions.desktop.presence.enter_sleep'] })
  const controller = new AbortController()
  let observed = 0
  const pending = port.request(ClientActionName.ENTER_SLEEP, {}, { signal: controller.signal, onLateResult: () => { observed++ } })
  controller.abort()
  await assert.rejects(pending)
  const result = { type: 'client.action.result', event_id: 'terminal', request_event_id: request.event_id, status: 'completed', output: {} }
  assert.equal(port.receive(result), true)
  assert.equal(port.receive(result), false)
  assert.equal(observed, 1)
  port.close()
  assert.equal(port.retiredById.size, 0)
})

test('registered delivery confirmation is server-owned and not repeated for duplicates', async () => {
  let confirmations = 0
  const router = new GatewayEventRouter({ registry: new ClientEventDefinitionRegistry({ definitions: [{ name: 'showroom.confirm', schema: z.object({}), confirm(outcome) { assert.ok(outcome); confirmations++ } }] }) })
  const message = { event_id: 'confirm', name: 'showroom.confirm', data: {} }
  const result = await router.publish(message)
  result.confirm({ contextInjected: true })
  assert.equal(confirmations, 1)
  assert.equal((await router.publish(message)).confirm, undefined)
})
