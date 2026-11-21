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
    'this week, from Monday 16 November 2026 UTC: delivery 605 xp, practice 0 xp',
    'Ada: level 2, 30 xp this week',
    'badges: Budget keeper, Cheap and right',
  ].join('\n'))
  expect(formatStats('{"version":1,"enabled":false}')).toBe('The game is off; the ledger keeps recording.')
  expect(formatStats('{"version":2,"enabled":true,"level":9,"xp":4300}')).toBe(undefined)
  expect(formatStats('not json')).toBe(undefined)
  expect(formatStats('null')).toBe(undefined)
  expect(formatStats('{"version":1,"level":-1,"xp":5}')).toBe(undefined)
  expect(formatStats('{"version":1,"level":"9","xp":5}')).toBe(undefined)
})

const stats = (extra: object) => formatStats(JSON.stringify({ version: 1, enabled: true, level: 0, xp: 10, ...extra }))!.split('\n')

test('leaves out what the JSON lacks and cleans badge names', async () => {
  expect(stats({ streak: null, week_start: 'nope', week: { delivery: 1, practice: 2 } })).toEqual([
    'level 0, 10 xp (40 more for level 1)', 'this week: delivery 1 xp, practice 2 xp', 'badges: none yet',
  ])
  expect(stats({ badges: [7, null, 'Real one', '\u0007'] })).toContain('badges: Real one')
  const long = stats({ badges: ['\u001b[31mred\u001b[0m' + 'x'.repeat(60), ...Array.from({ length: 11 }, (_, i) => `b${i}`)] })
  const line = long.find(l => l.startsWith('badges: '))!
  expect(line.includes('\u001b')).toBe(false)
  expect(line.startsWith('badges: [31mred[0m' + 'x'.repeat(30) + ', b0')).toBe(true)
  expect(line.endsWith(', +2 more')).toBe(true)
})

const ran = (exitCode: number, stdout: string, isStdoutTruncated = false) =>
  ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated, isStderrTruncated: false } })

test('a failed, truncated or timed out run shows the unavailable line', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('ui.open', { id: 'ada' }, () => ({ value: { isPlaced: true } }))
  const answers: (() => ReturnType<typeof ran>)[] = [
    () => ran(0, sample),
    () => ran(1, sample),
    () => ran(0, sample, true),
    () => { throw new Error('timed out') },
    () => ran(0, sample),
  ]
  let calls = 0
  on('process.run', () => answers[calls++]!())
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  const first = async () => (await ui.drawn() as any).children[0].children.join('')
  const shown: string[] = []
  for (let i = 0; i < answers.length; i++) {
    await $.command.run(ada)
    await clock.settle()
    shown.push(await first())
  }
  expect(calls).toBe(5)
  expect(shown.map(t => t === 'hrn bot stats unavailable')).toEqual([false, true, true, true, false])
  await ui.unmount()
})

test('a refresh already running is not started twice', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('ui.open', { id: 'ada' }, () => ({ value: { isPlaced: true } }))
  let calls = 0
  on('process.run', async () => { calls++; await clock.advance(10); return ran(0, sample) })
  await $.command.run(ada)
  await $.command.run(ada)
  await clock.advance(20)
  expect(calls).toBe(1)
})

// The module keeps its rebuild time between tests, so each starts its clock later than the last.
async function startSession($: any, on: any, now: number, files: Map<string, string>, rebuildExit = 0) {
  const clock = mock.clock(on, { now })
  mock.env(on, { HRN_HOME: '/hrn' })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const key = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(\/hrn\/)/, '$1')
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(key(e.path)) }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (files.get(key(e.path)) === 'unreadable') throw new Error('permission denied')
    return { value: files.get(key(e.path)) ?? '' }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { files.set(key(e.path), e.text); return { value: undefined } })
  const argv: string[] = []
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { timeoutMs?: number } }) => {
    argv.push(`${e.argv.join(' ')} ${e.init?.timeoutMs}`)
    if (e.argv.includes('--json')) return ran(0, sample)
    if (rebuildExit < 0) throw new Error('timed out')
    return ran(rebuildExit, 'text')
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return { clock, argv, rebuilds: () => argv.filter(a => a === 'hrn bot stats 120000').length }
}
const stamp = '/hrn/claude-sessions/.ledger-rebuild'

test('session start rebuilds the ledger in the background, then redraws from the JSON', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, argv, rebuilds } = await startSession($, on, 1e9, files)
  expect(rebuilds()).toBe(1)
  expect(argv.at(-1)).toBe('hrn bot stats --json 30000')
  expect(files.get(stamp)).toBe(String(1e9))
  await clock.advance(60000)
  expect(rebuilds()).toBe(1)
  await clock.advance(15 * 60000)
  expect(rebuilds()).toBe(2)
  expect(argv.at(-1)).toBe('hrn bot stats --json 30000')
})

test('a recent rebuild by another session is not repeated', async ($, on) => {
  const files = new Map([[stamp, String(2e9 - 5 * 60000)]])
  const { clock, rebuilds } = await startSession($, on, 2e9, files)
  expect(rebuilds()).toBe(0)
  await clock.advance(5 * 60000)
  expect(rebuilds()).toBe(0)
  await clock.advance(6 * 60000)
  expect(rebuilds()).toBe(1)
})

test('an unreadable stamp does not stop rebuilds', async ($, on) => {
  const files = new Map([[stamp, 'unreadable']])
  const { rebuilds } = await startSession($, on, 2.5e9, files)
  expect(rebuilds()).toBe(1)
  expect(files.get(stamp)).toBe(String(2.5e9))
})

for (const [name, exit, now] of [['fails', 1, 3e9], ['times out', -1, 4e9]] as const) {
  test(`a rebuild that ${name} still redraws and is tried again later`, async ($, on) => {
    const { clock, argv, rebuilds } = await startSession($, on, now, new Map(), exit)
    expect(rebuilds()).toBe(1)
    expect(argv.at(-1)).toBe('hrn bot stats --json 30000')
    await clock.advance(16 * 60000)
    expect(rebuilds()).toBe(2)
  })
}
