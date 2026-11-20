import { expect, mock, test } from 'claude-code/testing'
import { record } from './register'
import type { EngineInterface } from 'claude-code'

const pane = { plugin: 'ada-pane', component: 'Pane', requestId: 'ada', props: {
  title: 'Ada', isFocused: false, bodyColumns: 40, placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 }, view: {},
} } as const

test('records only event metadata and passes results through', async ($, on) => {
  mock.env(on, { HRN_HOME: '/hrn' })
  mock.clock(on, { now: 0 })
  let content = ''
  let path = ''
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.exists', (_, e) => ({ value: e.path === path && content !== '' }))
  on('fs.read', () => ({ value: content }))
  on('fs.write', (_, e) => { path = e.path; content = e.text; return { value: undefined } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {}, isError: true }))
  const prompt = await $.prompt.submit({ text: 'secret prompt' })
  const tool = await $.tool.call({ tool: 'Bash', command: 'secret command' })
  expect(prompt.text).toBe('secret prompt')
  expect(tool.isError).toBe(true)
  expect(path.replace(/\\/g, '/').endsWith('/hrn/claude-sessions/session-1.jsonl')).toBe(true)
  const rows = content.trim().split('\n').map(line => JSON.parse(line))
  expect(rows).toEqual([
    { time: '1970-01-01T00:00:00.000Z', session: 'session-1', kind: 'prompt' },
    { time: '1970-01-01T00:00:00.000Z', session: 'session-1', kind: 'tool', tool: 'Bash', status: 'error' },
  ])
})

test('draws Ada state on both surfaces and updates after events', async ($, on) => {
  mock.env(on, { HRN_HOME: '/hrn' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 'pane-session' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {}, isError: true }))
  await $.prompt.submit({ text: 'hello' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect((await ui.find({ type: 'Text', text: /hrn bot stats unavailable/ }))?.text).toBe('hrn bot stats unavailable')
    expect((await ui.find({ type: 'Text', text: /Prompts: 1/ }))?.text).toBe('Prompts: 1 | Tools started: 1 | finished: 1')
    expect((await ui.find({ type: 'Text', text: /Last tool: Bash/ }))?.text).toBe('Last tool: Bash (error)')
    expect((await ui.find({ type: 'Text', text: /That one failed/ }))?.text).toBe('That one failed; worth a look.')
    await ui.unmount()
  }
})

test('serializes records and rotates before exceeding the byte limit', async () => {
  const files = new Map<string, string>()
  const engine = {
    env: { get: async () => '/hrn' },
    clock: { now: async () => 0 },
    session: { id: async () => 'rotation' },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path) ?? '',
      write: async (path: string, value: string) => { files.set(path, value) },
    },
  } as unknown as EngineInterface
  await Promise.all([
    record(engine, { kind: 'tool', tool: '\u00e9', status: 'ok' }, 120),
    record(engine, { kind: 'prompt' }, 120),
    record(engine, { kind: 'prompt' }, 120),
  ])
  expect([...files.keys()]).toEqual([
    '/hrn/claude-sessions/rotation.jsonl', '/hrn/claude-sessions/rotation.2.jsonl', '/hrn/claude-sessions/rotation.3.jsonl',
  ])
  expect([...files.values()].every(value => new TextEncoder().encode(value).length <= 120)).toBe(true)
  expect([...files.values()].flatMap(value => value.trim().split('\n').map(line => JSON.parse(line).kind))).toEqual(['tool', 'prompt', 'prompt'])
})

test('/ada answers itself and opens the pane', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let opened = 0
  let placed = true
  on('ui.open', { id: 'ada' }, () => {
    opened++
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'no surface' } }
  })
  const open = await $.command.run({ command: 'ada' })
  expect(open.text).toBe('Ada’s pane is open.')
  expect(opened).toBe(1)
  placed = false
  const waiting = await $.command.run({ command: 'ada' })
  expect(waiting.text).toBe('Ada’s pane is waiting for a place to draw: no surface')
})
