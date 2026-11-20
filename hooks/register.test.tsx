import { expect, mock, test } from 'claude-code/testing'
import {
  age, barHeights, blockRuns, checkState, chooseAction, contextPercent, dayGrid, duration, githubRepo, levelSpan, macaw,
  parseGitStatus, parsePullRequest, parseStats, percentText, planFigure, pushCall, readPullRequest, readPullRequestFailure,
  record, repoLinks, resetsIn, ring, stopwatch, strip, testRunner, tokenCount,
} from './register'
import type { EngineInterface, On, SessionUsage } from 'claude-code'
import type { ToolBar } from '../types'

const pane = { plugin: 'ada-pane', component: 'Pane', requestId: 'ada', props: {
  title: 'Ada', isFocused: false, bodyColumns: 40, placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 }, view: {},
} } as const

const SURFACES = ['terminal', 'desktop'] as const

const wire = {
  version: 1, enabled: true, level: 9, xp: 4240, week_start: '2026-11-16',
  week: { delivery: 545, practice: 30 }, streak: 2,
  days: [...Array(33).fill(false), true, true],
  badges: ['Budget keeper', 'Cheap and right'],
  exercise: { kind: 'cold read', source: 'a pull request', answered: false },
  ada: { level: 2, xp_this_week: 30, xp: 250 },
}

const ran = (stdout: string, exitCode = 0, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

const usage = (over: Partial<SessionUsage> = {}): SessionUsage =>
  ({ startedAt: 0, context: { tokens: 86000, window: 200000, percent: 43 }, rateLimits: [], ...over })

const REPO = { root: '/main/ada-pane', remote: 'https://github.com/cristiangirlea/ada-pane.git', internal: false, name: 'ada-pane' }

const GIT_CLEAN = '# branch.oid 0123456789abcdef\n# branch.head pane-look\n# branch.upstream origin/pane-look\n# branch.ab +0 -0\n'
const GIT_CHANGED = '# branch.oid 0123456789abcdef\n# branch.head pane-look\n# branch.upstream origin/pane-look\n# branch.ab +2 -1\n'
  + '1 .M N... 100644 100644 100644 a b hooks/register.tsx\n2 R. N... 100644 100644 100644 a b R100 new\told\n? docs/pane-design.md\n'

const PR = {
  number: 12, title: 'Pane look', state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', url: 'https://example.com/not-a-link',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'c', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'd', state: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'e', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ],
  closingIssuesReferences: [
    { number: 1, repository: { name: 'ada-pane', owner: { login: 'cristiangirlea' } } },
    { number: 7, repository: { name: 'other', owner: { login: 'someone' } } },
  ],
}

/** A run's result, or a refusal that rejects the caller as a program that cannot start does. */
type Answer = { value: ReturnType<typeof ran>['value'] } | { deny: string }

const cannotStart = (program: string): Answer => ({ deny: `spawn ${program} ENOENT` })

type World = {
  now?: number
  usage?: SessionUsage | null
  repo?: typeof REPO | { root: string; remote: string | null; internal: boolean; name: string | null } | null
  git?: () => Answer
  gh?: () => Answer
  hrn?: () => Answer
  store?: Record<string, unknown>
  /** Whether the pane is the one its surface shows (true when not given). */
  shown?: boolean
}

/** The engine beneath the plugin, with each outside program answered by the test. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: w.now ?? 1_000_000 })
  mock.env(on, { HRN_HOME: '/hrn' })
  const store = new Map<string, unknown>(Object.entries(w.store ?? {}))
  on('store.get', (_, e) => ({ value: store.has(e.key) ? store.get(e.key) : null }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  const files = new Map<string, string>()
  const runs: { argv: string[]; cwd?: string; timeoutMs?: number }[] = []
  const filled: string[] = []
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => {
    if (w.usage === null) throw new Error('not known yet')
    return { value: w.usage ?? usage() }
  })
  on('session.repo', () => ({ value: w.repo === undefined ? REPO : w.repo }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    if (e.argv[0] === 'git') return w.git ? w.git() : ran(GIT_CLEAN)
    if (e.argv[0] === 'gh') return w.gh ? w.gh() : ran('', 1, 'no pull requests found for branch "pane-look"')
    return w.hrn ? w.hrn() : ran('', 1)
  })
  on('prompt.fill', (_, e) => { filled.push(e.text); return { isFilled: true, text: e.text, cursor: e.text.length } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'ada' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'ada', title: 'Ada', isShown: w.shown !== false, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, files, runs, filled, store }
}

/** A prompt typed at the composer, as the engine hands it on. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

/** A slash command as the engine runs it. */
const slash = (command: string) => ({ command, args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

const turnBegins = (extra: { agentId?: string } = {}) => ({ text: 'go', turnId: 't1', ...extra })

const turnDone = (durationMs: number, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({ answer: '', durationMs, isAborted: false, turnId: 't1', reason: 'answer' as const, ...extra })

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

// ---- Formatters ----

test('percentages, token counts, durations and reset times read plainly', () => {
  expect(percentText(43.4)).toBe('43%')
  expect(percentText(140)).toBe('100%')
  expect(percentText(-3)).toBe('0%')
  expect(tokenCount(950)).toBe('950')
  expect(tokenCount(86000)).toBe('86k')
  expect(tokenCount(200000)).toBe('200k')
  expect(tokenCount(999999)).toBe('1M')
  expect(tokenCount(1250000)).toBe('1.3M')
  expect(duration(45000)).toBe('45 s')
  expect(duration(192000)).toBe('3 m 12 s')
  expect(duration(180000)).toBe('3 m')
  expect(duration(3900000)).toBe('1 h 5 m')
  expect(stopwatch(134000)).toBe('2:14')
  expect(stopwatch(3723000)).toBe('1:02:03')
  expect(stopwatch(-5)).toBe('0:00')
  const now = Date.parse('2026-11-20T12:00:00Z')
  expect(resetsIn(now, '2026-11-23T13:00:00Z')).toBe('resets 3 d')
  expect(resetsIn(now, '2026-11-20T17:30:00Z')).toBe('resets 5 h')
  expect(resetsIn(now, '2026-11-20T12:11:30Z')).toBe('resets 12 min')
  expect(resetsIn(now, '2026-11-20T11:00:00Z')).toBe('resets now')
  expect(resetsIn(now, 'not a time')).toBe('')
  expect(resetsIn(now, undefined)).toBe('')
})

test('the strip scales by square root and keeps the last 40 calls', () => {
  expect(barHeights([0, 100, 400], 23, 3)).toEqual([3, 13, 23])
  expect(barHeights([], 28)).toEqual([])
  let calls: ToolBar[] = []
  for (let i = 0; i < 45; i++) calls = pushCall(calls, { tool: `T${i}`, ms: i, ok: true })
  expect(calls.length).toBe(40)
  expect(calls[0]?.tool).toBe('T5')
  expect(calls[39]?.tool).toBe('T44')
  const svg = strip([{ tool: 'Bash', ms: 900, ok: true }, { tool: 'Edit', ms: 100, ok: false }])
  expect((svg.match(/<rect /g) ?? []).length).toBe(2)
  expect(svg.includes('x="228"')).toBe(true)
  expect(svg.includes('#d64545')).toBe(true)
  expect(blockRuns([{ tool: 'a', ms: 0, ok: true }, { tool: 'b', ms: 100, ok: true }, { tool: 'c', ms: 100, ok: false }]))
    .toEqual([{ text: '▁█', failed: false }, { text: '█', failed: true }])
})

test('context and plan figures come from the session’s usage', () => {
  expect(contextPercent(null)).toBe(null)
  expect(contextPercent(usage())).toBe(43)
  expect(contextPercent(usage({ context: { tokens: 50000, window: 200000 } }))).toBe(25)
  expect(contextPercent(usage({ context: { window: 200000 } }))).toBe(null)
  const now = Date.parse('2026-11-20T12:00:00Z')
  const limits = usage({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 30, resetsAt: '2026-11-20T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 72, resetsAt: '2026-11-23T12:00:00Z' },
    ],
    cost: { usd: 1.2 },
  })
  expect(planFigure(limits, now)).toEqual({ caption: 'Plan limit', value: '72%', line: 'resets 3 d', percent: 72 })
  expect(planFigure(usage({ cost: { usd: 1.2 } }), now)).toEqual({ caption: 'Cost', value: '$1.20', line: 'estimate', percent: null })
  expect(planFigure(usage(), now).value).toBe('–')
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

// ---- Parsing ----

test('git status: clean, changed, ahead and behind, detached, not a repository', () => {
  expect(parseGitStatus(GIT_CLEAN)).toEqual({ head: 'pane-look', detached: false, changed: 0, ahead: 0, behind: 0 })
  expect(parseGitStatus(GIT_CHANGED)).toEqual({ head: 'pane-look', detached: false, changed: 3, ahead: 2, behind: 1 })
  expect(parseGitStatus('# branch.oid 0123456789abcdef\r\n# branch.head (detached)\r\n1 .M N... a b c d e f\r\n'))
    .toEqual({ head: 'detached at 0123456', detached: true, changed: 1, ahead: null, behind: null })
  expect(parseGitStatus('# branch.oid (initial)\n# branch.head main\n')).toEqual({ head: 'main', detached: false, changed: 0, ahead: null, behind: null })
  expect(parseGitStatus('')).toBe(null)
  expect(parseGitStatus('fatal: not a git repository (or any of the parent directories): .git')).toBe(null)
})

test('gh pr view: no pull request, mixed checks, no checks, and failures', () => {
  const repo = { owner: 'cristiangirlea', name: 'ada-pane' }
  const pr = parsePullRequest(JSON.stringify(PR), repo)
  expect(pr).toEqual({
    number: 12, title: 'Pane look', state: 'open', review: 'required',
    checks: ['passed', 'failed', 'running', 'passed', 'passed'], issues: [1],
  })
  expect(parsePullRequest(JSON.stringify({ ...PR, statusCheckRollup: [], closingIssuesReferences: [] }), repo)?.checks).toEqual([])
  expect(parsePullRequest(JSON.stringify({ ...PR, state: 'MERGED', reviewDecision: 'APPROVED' }), repo)).toEqual(
    expect.objectContaining({ state: 'merged', review: 'approved' }))
  expect(parsePullRequest('{}', repo)).toBe(null)
  expect(parsePullRequest('nope', repo)).toBe(null)
  expect(checkState({ status: 'QUEUED' })).toBe('running')
  expect(checkState({ status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('failed')
  expect(checkState({ state: 'PENDING' })).toBe('running')
  expect(checkState({ state: 'ERROR' })).toBe('failed')
  const done = (stdout: string, exitCode: number, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  expect(readPullRequest(done('', 1, 'no pull requests found for branch "x"'), repo)).toEqual({ kind: 'none' })
  expect(readPullRequest(done('', 4, 'To get started with GitHub CLI, please run:  gh auth login'), repo)).toEqual({ kind: 'note', note: 'gh is not signed in' })
  expect(readPullRequest(done('', 1, 'HTTP 502'), repo)).toEqual({ kind: 'hidden' })
  expect(readPullRequest(done(JSON.stringify(PR), 0), repo).kind).toBe('found')
  expect(readPullRequestFailure(new Error('spawn gh ENOENT'))).toEqual({ kind: 'note', note: 'gh is not installed' })
  expect(readPullRequestFailure(new Error('timed out after 8000 ms'))).toEqual({ kind: 'hidden' })
})

test('links only for a GitHub remote, in https and git@ spelling, built from owner and name alone', () => {
  expect(githubRepo('https://github.com/cristiangirlea/ada-pane.git')).toEqual({ owner: 'cristiangirlea', name: 'ada-pane' })
  expect(githubRepo('https://github.com/cristiangirlea/ada-pane')).toEqual({ owner: 'cristiangirlea', name: 'ada-pane' })
  expect(githubRepo('git@github.com:cristiangirlea/ada-pane.git')).toEqual({ owner: 'cristiangirlea', name: 'ada-pane' })
  expect(githubRepo('ssh://git@github.com/cristiangirlea/ada-pane.git')).toEqual({ owner: 'cristiangirlea', name: 'ada-pane' })
  expect(githubRepo('https://x-access-token:SECRET@github.com/o/n.git')).toEqual({ owner: 'o', name: 'n' })
  expect(githubRepo('http://github.com/o/n.git')).toBe(null)
  expect(githubRepo('https://gitlab.com/o/n.git')).toBe(null)
  expect(githubRepo('https://github.com.evil.example/o/n')).toBe(null)
  expect(githubRepo('https://github.com/o/n/extra')).toBe(null)
  expect(githubRepo('https://github.com/../n')).toBe(null)
  expect(githubRepo(null)).toBe(null)
  const links = repoLinks({ owner: 'o', name: 'n' })
  expect([links.repository, links.pulls, links.actions, links.pull(3), links.issue(1)]).toEqual([
    'https://github.com/o/n', 'https://github.com/o/n/pulls', 'https://github.com/o/n/actions',
    'https://github.com/o/n/pull/3', 'https://github.com/o/n/issues/1',
  ])
})

test('a test runner is named by a command’s first words, never by an argument', () => {
  expect(testRunner('go test ./...')).toBe('go test')
  expect(testRunner('cd hooks && go test -run X')).toBe('go test')
  expect(testRunner('CGO_ENABLED=0 go test ./...')).toBe('go test')
  expect(testRunner('npm test')).toBe('npm test')
  expect(testRunner('npm run test -- --watch=false')).toBe('npm test')
  expect(testRunner('npx vitest run')).toBe('vitest')
  expect(testRunner('python -m pytest -q')).toBe('pytest')
  expect(testRunner('cargo test --workspace')).toBe('cargo test')
  expect(testRunner('claude plugin test .')).toBe('claude plugin test')
  expect(testRunner('echo go test')).toBe(null)
  expect(testRunner('git commit -m "run go test"')).toBe(null)
  expect(testRunner('grep -r "cargo test" .')).toBe(null)
  expect(testRunner('go tests')).toBe(null)
  expect(testRunner('go vet ./...')).toBe(null)
})

test('one action, in the spec’s order', () => {
  const tests = { runner: 'go test', ok: true, at: 1 }
  expect(chooseAction({ lastStatus: 'error', tests, editedSinceTests: true }, 90)?.key).toBe('ask-why')
  expect(chooseAction({ lastStatus: 'ok', tests, editedSinceTests: true }, 70)?.key).toBe('compact')
  expect(chooseAction({ lastStatus: 'ok', tests, editedSinceTests: true }, 70)?.text).toBe('/compact')
  expect(chooseAction({ lastStatus: 'ok', tests, editedSinceTests: true }, 69)?.key).toBe('rerun')
  expect(chooseAction({ lastStatus: 'ok', tests, editedSinceTests: true }, null)?.text).toBe('Run the tests again (go test) and tell me what changed.')
  expect(chooseAction({ lastStatus: 'ok', tests, editedSinceTests: false }, 10)).toBe(null)
  expect(chooseAction({ lastStatus: 'ok', tests: null, editedSinceTests: false }, 10)).toBe(null)
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

test('the pictures are plain markup with no script, and the ring fills to its percentage', () => {
  for (const mood of ['idle', 'busy', 'glad', 'worried'] as const) {
    for (const svg of [macaw(mood), ring(40, { mood })]) {
      expect(svg.startsWith('<svg ')).toBe(true)
      expect(/<script|on\w+=|href=/i.test(svg)).toBe(false)
    }
  }
  expect(ring(null, { mood: 'idle' }).includes('stroke-dasharray')).toBe(false)
  expect(ring(0, { mood: 'idle' }).includes('stroke-dasharray')).toBe(false)
  expect(ring(50, { mood: 'idle' }).includes('stroke-dasharray="62.83 125.66"')).toBe(true)
  expect(ring(20, { text: '9<script>' }).includes('>9scr</text>')).toBe(true)
  const grid = dayGrid([...Array(33).fill(false), true, true])
  expect((grid.match(/<rect /g) ?? []).length).toBe(35)
  expect((grid.match(/fill-opacity="1"/g) ?? []).length).toBe(2)
})

// ---- The pane ----

test('the session view: figures, the strip, the working tree and its action, on every surface', async ($, on) => {
  const w = world(on, { usage: usage({ context: { tokens: 150000, window: 200000, percent: 75 } }) })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('go'))
  await $.turn.start(turnBegins())
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  await w.clock.advance(11000)
  await $.tool.call({ tool: 'Edit', file_path: '/work/ada-pane/a.go', old_string: 'a', new_string: 'b' })
  await $.turn.complete(turnDone(134000))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('75%')).toBe(true)
    expect(all.includes('150k of 200k')).toBe(true)
    expect(all.includes('2:14')).toBe(true)
    expect(all.includes('2 tool calls')).toBe(true)
    expect(/2 calls\./.test(all)).toBe(true)
    expect(/Slowest: /.test(all)).toBe(true)
    expect(/pane-look, no changes, tests passed/.test(all)).toBe(true)
    expect(all.includes(', edited since')).toBe(true)
    expect(all.includes('Done')).toBe(true)
    expect((await ui.find({ type: 'Svg' })) !== undefined).toBe(surface !== 'terminal')
    if (surface === 'terminal') expect(all.includes('▁')).toBe(true)
    // Context at 75% outranks the edited tests.
    expect(await ui.find({ key: 'rerun' })).toBeUndefined()
    await ui.press({ key: 'compact' })
    await ui.unmount()
  }
  expect(w.filled).toEqual(['/compact', '/compact'])
})

test('tests then an edit offer to run them again; a failure offers to ask why', async ($, on) => {
  const w = world(on)
  let fail = false
  on('tool.call', () => (fail ? { result: {}, isError: true as const } : { result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test .' })
  let ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ key: 'rerun' })).toBeUndefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Write', file_path: '/work/x', content: 'y' })
  ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'rerun' })
  expect(w.filled).toEqual(['Run the tests again (claude plugin test) and tell me what changed.'])
  await ui.unmount()
  fail = true
  await $.tool.call({ tool: 'Bash', command: 'false' })
  ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ key: 'rerun' })).toBeUndefined()
  await ui.press({ key: 'ask-why' })
  expect(w.filled[1]).toBe('Look at the last tool call that failed and tell me why it failed and what to change.')
  expect((await texts(ui)).includes('Failed')).toBe(true)
  await ui.unmount()
})

test('a running turn shows its time, ticking once a second until it ends', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {} }))
  await $.prompt.submit(typed('go'))
  await $.turn.start(turnBegins())
  await w.clock.advance(1000)
  // A subagent's turn starting is not the session's: the clock keeps running.
  await $.turn.start(turnBegins({ agentId: 'a1' }))
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  await w.clock.advance(2000)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('0:03')).toBe(true)
  expect((await texts(ui)).includes('running, 1 tool call')).toBe(true)
  expect((await texts(ui)).includes('Working')).toBe(true)
  await w.clock.advance(2000)
  expect((await texts(ui)).includes('0:05')).toBe(true)
  // A subagent's turn ending is not the session's.
  await $.turn.complete(turnDone(9000, { agentId: 'a1' }))
  expect((await texts(ui)).includes('This turn')).toBe(true)
  await $.turn.complete(turnDone(5000))
  expect((await texts(ui)).includes('Last turn')).toBe(true)
  expect((await texts(ui)).includes('0:05')).toBe(true)
  await ui.unmount()
})

test('git is asked with fixed arguments, a 3 second limit and at most once in 10 seconds', async ($, on) => {
  const w = world(on, { now: 50_000_000, git: () => ran(GIT_CHANGED) })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const gits = () => w.runs.filter(r => r.argv[0] === 'git')
  expect(gits().length).toBe(1)
  // No cwd: the session's own directory, never the main checkout's root.
  expect(gits()[0]).toEqual({ argv: ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], cwd: undefined, timeoutMs: 3000 })
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: '/b', content: 'c' })
  await w.clock.settle()
  expect(gits().length).toBe(1)
  await w.clock.advance(10000)
  expect(gits().length).toBe(2)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('pane-look, 3 files changed')).toBe(true)
  await ui.unmount()
})

test('a git that cannot run hides the working-tree line it showed', async ($, on) => {
  const cfg: World = { now: 70_000_000 }
  const w = world(on, cfg)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const shown = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(shown)).includes('pane-look, no changes')).toBe(true)
  await shown.unmount()
  cfg.git = () => cannotStart('git')
  await w.clock.advance(11000)
  await $.tool.call({ tool: 'Write', file_path: '/a', content: 'b' })
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect((await texts(ui)).includes('pane-look')).toBe(false)
    await ui.unmount()
  }
})

test('the repo view: this branch, its pull request with checks and issue, and links built from the remote', async ($, on) => {
  const w = world(on, { now: 90_000_000, git: () => ran(GIT_CHANGED), gh: () => ran(JSON.stringify(PR)) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.runs.some(r => r.argv[0] === 'gh')).toBe(false)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    await ui.press({ key: 'view-repo' })
    const all = await texts(ui)
    expect(all.includes('3 files changed, 2 ahead, 1 behind')).toBe(true)
    expect(all.includes('Review required')).toBe(true)
    expect(all.includes('3 of 5 passed')).toBe(true)
    expect(all.includes('CI failing')).toBe(true)
    expect(all.includes('ada-pane')).toBe(true)
    if (surface === 'terminal') expect(all.includes('●')).toBe(true)
    const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(hrefs).toEqual([
      'https://github.com/cristiangirlea/ada-pane/pull/12', 'https://github.com/cristiangirlea/ada-pane/issues/1',
      'https://github.com/cristiangirlea/ada-pane', 'https://github.com/cristiangirlea/ada-pane/pulls',
      'https://github.com/cristiangirlea/ada-pane/actions',
    ])
    await ui.unmount()
  }
  const ghs = w.runs.filter(r => r.argv[0] === 'gh')
  // Opened twice within two minutes: asked once.
  expect(ghs.length).toBe(1)
  expect(ghs[0]).toEqual({
    argv: ['gh', 'pr', 'view', '--json', 'number,title,state,reviewDecision,statusCheckRollup,closingIssuesReferences'],
    cwd: undefined, timeoutMs: 8000,
  })
})

test('gh is asked after a turn only while the repo view is open, and at most once in 2 minutes', async ($, on) => {
  const w = world(on, { now: 110_000_000, gh: () => ran(JSON.stringify(PR)) })
  const ghs = () => w.runs.filter(r => r.argv[0] === 'gh').length
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(ghs()).toBe(0)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-repo' })
  expect(ghs()).toBe(1)
  await w.clock.advance(60000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(ghs()).toBe(1)
  await w.clock.advance(61000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(ghs()).toBe(2)
  await ui.press({ key: 'view-session' })
  await w.clock.advance(200000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(ghs()).toBe(2)
  await ui.unmount()
})

test('the view is kept for the next session', async ($, on) => {
  const w = world(on, { now: 130_000_000, store: { view: 'you' } })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await ui.find({ key: 'view-you' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'view-repo' })
  expect(w.store.get('view')).toBe('repo')
  await ui.unmount()
})

type Case = { name: string; w: World; view: 'session' | 'repo' | 'you'; check: (all: string, has: (key: string) => Promise<boolean>) => Promise<void> | void }

const STATES: Case[] = [
  { name: 'no tool call yet', w: {}, view: 'session', check: all => { expect(all.includes('No tool calls yet')).toBe(true) } },
  { name: 'not a git repository', w: { repo: null }, view: 'repo', check: async (all, has) => {
    expect(await has('view-repo')).toBe(false)
    expect(all.includes('pane-look')).toBe(false)
    expect(all.includes('No tool calls yet')).toBe(true)
  } },
  { name: 'remote not on GitHub', w: { repo: { ...REPO, remote: 'https://gitlab.com/o/n.git' } }, view: 'repo', check: all => {
    expect(all.includes('Links')).toBe(false)
    expect(all.includes('pull request')).toBe(false)
    expect(all.includes('No changes, 0 ahead, 0 behind')).toBe(true)
  } },
  { name: 'gh missing', w: { gh: () => cannotStart('gh') }, view: 'repo', check: all => { expect(all.includes('gh is not installed')).toBe(true) } },
  { name: 'gh not signed in', w: { gh: () => ran('', 4, 'please run:  gh auth login') }, view: 'repo', check: all => { expect(all.includes('gh is not signed in')).toBe(true) } },
  { name: 'branch has no pull request', w: {}, view: 'repo', check: all => { expect(all.includes('No pull request yet')).toBe(true) } },
  { name: 'pull request with no checks', w: { gh: () => ran(JSON.stringify({ ...PR, statusCheckRollup: [] })) }, view: 'repo', check: all => {
    expect(all.includes('No checks')).toBe(true)
    expect(all.includes('CI ')).toBe(false)
  } },
  { name: 'usage not known yet', w: { usage: null }, view: 'session', check: all => { expect(all.includes('not known yet')).toBe(true) } },
  { name: 'game off', w: { hrn: () => ran('{"version":1,"enabled":false}') }, view: 'you', check: all => { expect(all.includes('The experience game is off in hrn')).toBe(true) } },
  { name: 'hrn not installed', w: { hrn: () => cannotStart('hrn') }, view: 'you', check: all => { expect(all.includes('hrn is not installed')).toBe(true) } },
]

STATES.forEach((c, i) => {
  test(`state “${c.name}” draws without an error, on desktop and on the terminal`, async ($, on) => {
    const w = world(on, { now: 150_000_000 + i * 1_000_000, store: { view: c.view }, ...c.w })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...pane, surface })
      await c.check(await texts(ui), async key => (await ui.find({ key })) !== undefined)
      await ui.unmount()
    }
  })
})

test('state “stats never read” draws without an error', async ($, on) => {
  world(on, { now: 170_000_000, store: { view: 'you' } })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    await ui.press({ key: 'view-you' })
    expect((await texts(ui)).includes('Reading your stats')).toBe(true)
    await ui.unmount()
  }
})

test('state an earlier build kept under ada-2 is reset, not read', async ($, on) => {
  world(on, { now: 190_000_000 })
  on('state.get', () => ({
    value: { value: { shape: 'ada-2', value: { stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'progress', prompts: 3,
      started: 2, finished: 2, lastTool: 'Bash', lastStatus: 'ok', reaction: 'Old words.', mood: 'idle', recordingFailed: false } }, version: 1 },
  }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('Old words.')).toBe(false)
    expect(all.includes('No tool calls yet')).toBe(true)
    expect((await ui.find({ key: 'view-session' }))?.props.variant).toBe('primary')
    await ui.unmount()
  }
})

test('stats from hrn are kept and drawn in the you view, and Refresh asks again', async ($, on) => {
  const w = world(on, { now: 210_000_000, hrn: () => ran(JSON.stringify(wire)) })
  await $.command.run(slash('ada'))
  await w.clock.settle()
  const hrns = () => w.runs.filter(r => r.argv[0] === 'hrn')
  expect(hrns()[0]?.argv).toEqual(['hrn', 'bot', 'stats', '--json'])
  expect((hrns()[0]?.timeoutMs ?? 0) >= 120000).toBe(true)
  expect((w.store.get('stats') as { stats: { level: number } }).stats.level).toBe(9)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    await ui.press({ key: 'view-you' })
    const all = await texts(ui)
    expect(all.includes('Level 9')).toBe(true)
    expect(all.includes('4,240 XP, 760 to level 10')).toBe(true)
    expect(all.includes('days streak, 2 of 35 days')).toBe(true)
    expect(all.includes('★ Budget keeper')).toBe(true)
    expect(all.includes('Waiting')).toBe(true)
    if (surface === 'terminal') {
      expect(all.includes('20%')).toBe(true)
      expect(all.includes('· · · · · ■ ■')).toBe(true)
    }
    // The kit draws a Progress as its label and figure.
    expect((await ui.find({ type: 'Text', text: /^Delivery 545 XP$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^Practice 30 XP$/ })) !== undefined).toBe(true)
    await ui.press({ key: 'exercise' })
    const before = hrns().length
    await ui.press({ key: 'refresh' })
    expect(hrns().length).toBe(before + 1)
    await ui.unmount()
  }
  expect(w.filled).toEqual(['Run `hrn bot practice` and show me today’s exercise.', 'Run `hrn bot practice` and show me today’s exercise.'])
})

test('an earlier session’s stats show at once, beside why there are no new ones', async ($, on) => {
  const w = world(on, { now: 230_000_000, store: { view: 'you', stats: { at: 229_000_000, stats: parseStats(JSON.stringify(wire)).stats } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.includes('4,240 XP, 760 to level 10')).toBe(true)
  expect(all.includes('hrn did not answer')).toBe(true)
  await ui.unmount()
})

test('no timer runs while idle: a prompt that starts no turn, and a turn that ended', async ($, on) => {
  const w = world(on, { now: 260_000_000 })
  let writes = 0
  on('state.set', (_, e, next) => { writes++; return next(e) })
  // A command that answers itself, or a dropped prompt: submitted, but no turn starts.
  await $.prompt.submit(typed('/ada'))
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const before = writes
  await w.clock.advance(5000)
  expect(writes).toBe(before)
  let all = await texts(ui)
  expect(all.includes('This turn')).toBe(false)
  expect(all.includes('Working')).toBe(false)
  await $.turn.start(turnBegins())
  await w.clock.advance(3000)
  // A prompt typed while the turn runs does not restart its clock.
  await $.prompt.submit(typed('and also this'))
  await w.clock.advance(2000)
  expect((await texts(ui)).includes('0:05')).toBe(true)
  await $.turn.complete(turnDone(5000))
  // The readings a turn's end starts finish first; only a timer would write after that.
  await w.clock.settle()
  const ended = writes
  await w.clock.advance(5000)
  expect(writes).toBe(ended)
  all = await texts(ui)
  expect(all.includes('This turn')).toBe(false)
  expect(all.includes('Last turn')).toBe(true)
  await ui.unmount()
})

test('gh is not asked while the pane is not on screen, even with the repo view kept', async ($, on) => {
  const cfg: World = { now: 270_000_000, store: { view: 'repo' }, shown: false, gh: () => ran(JSON.stringify(PR)) }
  const w = world(on, cfg)
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.runs.some(r => r.argv[0] === 'gh')).toBe(false)
  cfg.shown = true
  await w.clock.advance(1000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.runs.filter(r => r.argv[0] === 'gh').length).toBe(1)
})

test('a denied or interrupted test command says nothing about the tests', async ($, on) => {
  world(on, { now: 280_000_000 })
  let answer: 'deny' | 'interrupt' | 'pass' = 'pass'
  on('tool.call', () => (answer === 'deny' ? { deny: 'The person declined.' }
    : answer === 'interrupt' ? { result: undefined, isError: true as const, text: '[Request interrupted by user for tool use]' }
      : { result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  answer = 'deny'
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  answer = 'interrupt'
  await $.tool.call({ tool: 'Bash', command: 'cargo test' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.includes('tests passed')).toBe(true)
  expect(all.includes('tests failed')).toBe(false)
  expect(all.includes('Tests failed')).toBe(false)
  await ui.unmount()
})

test('a reading that fails after one that worked hides its section', async ($, on) => {
  const cfg: World = { now: 290_000_000, git: () => ran(GIT_CHANGED), gh: () => ran(JSON.stringify(PR)) }
  const w = world(on, cfg)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-repo' })
  let all = await texts(ui)
  expect(all.includes('3 files changed, 2 ahead, 1 behind')).toBe(true)
  expect(all.includes('Review required')).toBe(true)
  cfg.git = () => ran('', 128, 'fatal: not a git repository')
  cfg.gh = () => ran('', 1, 'HTTP 502: Bad Gateway')
  // Past both the git and the gh wait.
  await w.clock.advance(121000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  all = await texts(ui)
  expect(all.includes('files changed')).toBe(false)
  expect(all.includes('Review required')).toBe(false)
  expect(all.includes('No pull request yet')).toBe(false)
  expect(all.includes('This branch')).toBe(false)
  // Links come from the remote, not from gh, so they stay.
  expect(all.includes('Links')).toBe(true)
  await ui.unmount()
})

const CONTEXT_COLOURS: [number, string | undefined][] = [[69, undefined], [70, 'warning'], [84, 'warning'], [85, 'error']]
CONTEXT_COLOURS.forEach(([percent, colour], i) => {
  test(`context at ${percent}% is drawn ${colour ?? 'plain'}`, async ($, on) => {
    world(on, { now: 300_000_000 + i * 1_000_000, usage: usage({ context: { tokens: percent * 2000, window: 200000, percent } }) })
    const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${percent}%$`) }))?.props.color).toBe(colour)
    await ui.unmount()
  })
})

const CI_CHIPS: [string, unknown[], string | null][] = [
  ['passing', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }], 'CI passing'],
  ['running', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }], 'CI running'],
  ['failing', [{ status: 'IN_PROGRESS' }, { state: 'ERROR' }], 'CI failing'],
  ['none', [], null],
]
CI_CHIPS.forEach(([name, rollup, chip], i) => {
  test(`the repo header’s CI chip: ${name}`, async ($, on) => {
    const w = world(on, { now: 310_000_000 + i * 1_000_000, store: { view: 'repo' }, gh: () => ran(JSON.stringify({ ...PR, statusCheckRollup: rollup })) })
    await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
    await w.clock.settle()
    const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
    const found = (await ui.findAll({ type: 'Text', text: /^● CI / })).map(t => t.text)
    expect(found).toEqual(chip ? [`● ${chip}`] : [])
    await ui.unmount()
  })
})

test('on the terminal, failed calls in the strip take the error colour', async ($, on) => {
  world(on, { now: 320_000_000 })
  let fail = false
  on('tool.call', () => (fail ? { result: {}, isError: true as const } : { result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  fail = true
  await $.tool.call({ tool: 'Bash', command: 'false' })
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  const blocks = (await ui.findAll({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]+$/ })).filter(t => t.props.color !== undefined).map(t => [t.text.length, t.props.color])
  expect(blocks).toEqual([[1, 'success'], [1, 'error']])
  await ui.unmount()
})

test('with usage not known yet, the ring has no fill', async ($, on) => {
  world(on, { now: 330_000_000, usage: null })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect(source.startsWith('<svg ')).toBe(true)
  expect(source.includes('stroke-dasharray')).toBe(false)
  await ui.unmount()
})

// ---- Privacy ----

test('nothing new reaches the recording file', async ($, on) => {
  const w = world(on, { now: 250_000_000, git: () => ran(GIT_CHANGED), gh: () => ran(JSON.stringify(PR)), hrn: () => ran(JSON.stringify(wire)) })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('secret prompt'))
  await $.turn.start(turnBegins())
  await $.tool.call({ tool: 'Bash', command: 'go test ./secret/...' })
  await $.tool.call({ tool: 'Edit', file_path: '/secret/file', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-repo' })
  await ui.unmount()
  await $.turn.complete(turnDone(4000))
  await w.clock.advance(20000)
  expect([...w.files.keys()].map(p => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''))).toEqual(['/hrn/claude-sessions/session-1.jsonl'])
  const rows = [...w.files.values()].join('').trim().split('\n').map(line => JSON.parse(line))
  expect(rows).toEqual([
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'prompt' },
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'tool', tool: 'Bash', status: 'ok' },
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'tool', tool: 'Edit', status: 'ok' },
  ])
  expect(/secret|pane-look|Pane look|go test/.test([...w.files.values()].join(''))).toBe(false)
})

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
  const prompt = await $.prompt.submit(typed('secret prompt'))
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
  const open = await $.command.run(slash('ada'))
  expect(open.text).toBe('Ada’s pane is open.')
  expect(opened).toBe(1)
  placed = false
  const waiting = await $.command.run(slash('ada'))
  expect(waiting.text).toBe('Ada’s pane is waiting for a place to draw: no surface')
})
