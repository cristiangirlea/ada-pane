import { expect, mock, test } from 'claude-code/testing'
import { age, dayGrid, levelSpan, macaw, parseStats, record } from './register'
import type { EngineInterface } from 'claude-code'

const pane = { plugin: 'ada-pane', component: 'Pane', requestId: 'ada', props: {
  title: 'Ada', isFocused: false, bodyColumns: 40, placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 }, view: {},
} } as const

const wire = {
  version: 1, enabled: true, level: 9, xp: 4240, week_start: '2026-11-16',
  week: { delivery: 545, practice: 30 }, streak: 2,
  days: [...Array(33).fill(false), true, true],
  badges: ['Budget keeper', 'Cheap and right'],
  exercise: { kind: 'cold read', source: 'a pull request', answered: false },
  ada: { level: 2, xp_this_week: 30, xp: 250 },
}

const ran = (stdout: string, exitCode = 0) =>
  ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

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

test('draws the session on every surface, with a picture only where one can be drawn', async ($, on) => {
  mock.env(on, { HRN_HOME: '/hrn' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 'pane-session' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {}, isError: true }))
  await $.prompt.submit({ text: 'hello' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect((await ui.find({ type: 'Text', text: /That one failed/ }))?.text).toBe('That one failed; worth a look.')
    expect((await ui.find({ type: 'Text', text: /No stats yet/ }))?.text).toBe('No stats yet')
    expect((await ui.find({ type: 'Text', text: /^prompt$/ }))?.text).toBe('prompt')
    expect(await ui.find({ type: 'Text', text: /Last tool/ })).toBeDefined()
    expect(await ui.find({ key: 'ask-why' })).toBeDefined()
    expect((await ui.find({ type: 'Svg' })) !== undefined).toBe(surface !== 'terminal')
    await ui.unmount()
  }
})

test('a failed tool call offers a prompt about it, and pressing it fills the prompt box', async ($, on) => {
  mock.env(on, { HRN_HOME: '/hrn' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 'ask' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {}, isError: true }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => { filled.push(e.text); return { isFilled: true, text: e.text, cursor: e.text.length } })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'ask-why' })
  expect(filled).toEqual(['Look at the last tool call that failed and tell me why it failed and what to change.'])
  await ui.unmount()
})

test('no failed tool call, no such offer', async ($, on) => {
  mock.env(on, { HRN_HOME: '/hrn' })
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 'fine' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'true' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ key: 'ask-why' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /What’s next/ }))?.text).toBe('Done. What’s next?')
  await ui.unmount()
})

test('stats from hrn are kept and drawn, and the views switch on a press', async ($, on) => {
  mock.clock(on, { now: 120000 })
  let asked: string[] = []
  let timeout = 0
  on('process.run', (_, e) => { asked = [...e.argv]; timeout = e.init?.timeoutMs ?? 0; return ran(JSON.stringify(wire)) })
  let kept: unknown
  on('store.get', () => ({ value: null }))
  on('store.set', (_, e) => { kept = e.value; return { value: undefined } })
  on('ui.open', { id: 'ada' }, () => ({ value: { isPlaced: true } }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => { filled.push(e.text); return { isFilled: true, text: e.text, cursor: e.text.length } })
  await $.command.run({ command: 'ada' })

  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(asked).toEqual(['hrn', 'bot', 'stats', '--json'])
  expect(timeout >= 120000).toBe(true)
  expect((kept as { stats: { level: number } }).stats.level).toBe(9)
  expect((await ui.find({ type: 'Text', text: /to level 10/ }))?.text).toBe('4,240 XP, 760 to level 10')
  expect((await ui.find({ type: 'Text', text: /^Read / }))?.text).toBe('Read just now')

  await ui.press({ key: 'view-progress' })
  expect((await ui.find({ type: 'Text', text: /to level 10/ }))?.text).toBe('4,240 XP, 760 to level 10 (20%)')
  expect((await ui.find({ type: 'Text', text: /^545$/ }))?.text).toBe('545')
  expect((await ui.find({ type: 'Text', text: /delivery XP/ }))?.text).toBe('delivery XP')
  expect((await ui.find({ type: 'Text', text: /days streak/ }))?.text).toBe('days streak')
  expect((await ui.find({ type: 'Text', text: /Ada, level 2/ }))?.text).toBe('Ada, level 2')
  await ui.press({ key: 'exercise' })
  expect(filled).toEqual(['Run `hrn bot practice` and show me today’s exercise.'])

  await ui.press({ key: 'view-badges' })
  expect((await ui.find({ type: 'Text', text: /Budget keeper/ }))?.text).toBe('★ Budget keeper')
  expect(await ui.find({ type: 'Text', text: /delivery XP/ })).toBeUndefined()

  await ui.press({ key: 'view-now' })
  expect(await ui.find({ type: 'Text', text: /Budget keeper/ })).toBeUndefined()
  await ui.unmount()
})

test('an earlier session’s stats show at once, beside why there are no new ones', async ($, on) => {
  mock.clock(on, { now: 7200000 })
  on('store.get', () => ({ value: { at: 3600000, stats: parseStats(JSON.stringify(wire)).stats } }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', () => ran('', 1))
  on('command.register', () => ({ value: { command: 'ada' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /to level 10/ }))?.text).toBe('4,240 XP, 760 to level 10')
  expect((await ui.find({ type: 'Text', text: /hrn did not answer/ }))?.text).toBe('hrn did not answer')
  await ui.unmount()
})

test('Refresh asks hrn again', async ($, on) => {
  mock.clock(on, { now: 0 })
  let calls = 0
  on('process.run', () => { calls++; return ran(JSON.stringify(wire)) })
  on('store.get', () => ({ value: null }))
  on('store.set', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  expect(calls).toBe(2)
  await ui.press({ key: 'view-progress' })
  expect((await ui.find({ type: 'Text', text: /■/ }))?.text).toBe('□'.repeat(33) + '■■')
  await ui.unmount()
})

test('what hrn answers is read with care', () => {
  expect(parseStats('not json')).toEqual({ stats: null, note: 'hrn gave no stats' })
  expect(parseStats('{"version":1,"enabled":false}')).toEqual({ stats: null, note: 'The experience game is off in hrn' })
  expect(parseStats('{"enabled":true}').stats).toBe(null)
  const { stats } = parseStats(JSON.stringify({ ...wire, streak: null, exercise: null, ada: undefined, days: Array(50).fill(true), badges: [1, 'One'] }))
  expect(stats?.streak).toBe(null)
  expect(stats?.exercise).toBe(null)
  expect(stats?.ada).toBe(null)
  expect(stats?.days.length).toBe(35)
  expect(stats?.badges).toEqual(['One'])
})

test('the level bar follows hrn’s rule, and ages read plainly', () => {
  expect(levelSpan(9, 4240)).toEqual({ toGo: 760, percent: 20 })
  expect(levelSpan(0, 0)).toEqual({ toGo: 50, percent: 0 })
  expect(levelSpan(9, 99999)).toEqual({ toGo: 0, percent: 100 })
  expect(age(0, 0)).toBe('')
  expect(age(30000, 1)).toBe('just now')
  expect(age(1 + 5 * 60000, 1)).toBe('5 min ago')
  expect(age(1 + 3 * 3600000, 1)).toBe('3 h ago')
  expect(age(1 + 49 * 3600000, 1)).toBe('2 d ago')
})

test('the pictures are plain markup with no script', () => {
  for (const mood of ['idle', 'busy', 'glad', 'worried'] as const) {
    const svg = macaw(mood)
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(/<script|on\w+=|href=/i.test(svg)).toBe(false)
  }
  const grid = dayGrid([...Array(33).fill(false), true, true])
  expect((grid.match(/<rect /g) ?? []).length).toBe(35)
  expect((grid.match(/fill-opacity="1"/g) ?? []).length).toBe(2)
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
    record(engine, { kind: 'tool', tool: 'é', status: 'ok' }, 120),
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
  on('process.run', () => ran('', 1))
  on('store.get', () => ({ value: null }))
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
