import { expect, mock, test } from 'claude-code/testing'
import { formatStats, record } from './register'
import type { EngineInterface } from 'claude-code'

const pane = { plugin: 'ada-pane', component: 'Pane', requestId: 'ada', props: {
  title: 'Ada', isFocused: false, bodyColumns: 40, placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 }, view: {},
} } as const
const ada = { command: 'ada', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

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
  const prompt = await $.prompt.submit({ text: 'secret prompt', wait: false, origin: { kind: 'composer' } })
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
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
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

test('refresh reads the JSON form with a 30 second limit and draws it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const calls: { argv: readonly string[]; timeoutMs?: number }[] = []
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    return { value: { exitCode: 0, stdout: sample, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', { id: 'ada' }, () => ({ value: { isPlaced: true } }))
  await $.command.run(ada)
  await clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  const line = (await ui.find({ type: 'Text', text: /level 9, 4300 xp/ }))?.text
  expect(calls[0]).toEqual({ argv: ['hrn', 'bot', 'stats', '--json'], timeoutMs: 30000 })
  expect(line?.startsWith('level 9, 4300 xp (700 more for level 10)')).toBe(true)
  await ui.unmount()
})

test('/ada answers itself and opens the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let opened = 0
  let placed = true
  on('ui.open', { id: 'ada' }, () => {
    opened++
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'no surface' } }
  })
  const open = await $.command.run(ada)
  expect(open.text).toBe('Ada’s pane is open.')
  expect(opened).toBe(1)
  placed = false
  const waiting = await $.command.run(ada)
  expect(waiting.text).toBe('Ada’s pane is waiting for a place to draw: no surface')
  await clock.settle()
})

const sample = JSON.stringify({
  version: 1, enabled: true, level: 9, xp: 4300, week_start: '2026-11-16', week: { delivery: 605, practice: 0 },
  streak: 2, badges: ['Budget keeper', 'Cheap and right'], ada: { level: 2, xp_this_week: 30, xp: 370 },
})

test('formats the JSON stats like the text form', async () => {
  expect(formatStats(sample)).toBe([
    'level 9, 4300 xp (700 more for level 10)',
    'streak: 2 days',
    'this week: delivery 605 xp, practice 0 xp',
    'Ada: level 2, 30 xp this week',
    'badges: Budget keeper, Cheap and right',
  ].join('\n'))
  expect(formatStats('{"enabled":false}')).toBe('The game is off; the ledger keeps recording.')
  expect(formatStats('not json')).toBe(undefined)
  expect(formatStats('null')).toBe(undefined)
  expect(formatStats('{"level":-1,"xp":5}')).toBe(undefined)
  expect(formatStats('{"level":"9","xp":5}')).toBe(undefined)
})
