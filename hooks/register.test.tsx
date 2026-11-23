import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import {
  age, barHeights, deliveryStrip, isLive, kindLine, parseDelivery, parseRuns, watchPage, weekStart, blockRuns, checkState, chooseAction, contextPercent, dayGrid, duration, githubRepo, levelSpan, macaw,
  parseGitStatus, parsePullRequest, parseStats, svgSize, percentText, planFigure, pushCall, readPullRequest, readPullRequestFailure,
  record, repoLinks, resetsIn, ring, stopwatch, strip, testRunner, tokenCount,
  addTokens, askedFor, cacheShare, countKinds, countTool, handoff, loopPicture, parseContextParts, shortTool, stack, stackRuns,
  stageLine, stepLine, stopWord, toolMix,
} from './register'
import type { AgentInfo, EngineInterface, On, SessionUsage, TurnStepResult } from 'claude-code'
import type { Station } from './register'
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
  /** `hrn bot stats`; the arguments say whether it was asked per repository. */
  hrn?: (argv: string[]) => Answer
  /** `hrn runs`; unset answers as an hrn without --json does. */
  runs?: (argv: string[]) => Answer
  store?: Record<string, unknown>
  /** Whether the pane is the one its surface shows (true when not given). */
  shown?: boolean
  /** An earlier session's rebuild stamp: its text, 'unreadable' for one that cannot be read, 'unwritable' for none that can be kept. */
  stamp?: string
  /** The surfaces the session draws on (only the terminal when not given). */
  surfaces?: ('terminal' | 'desktop' | 'vscode' | 'mobile')[]
  /** What the watch address answers; unset refuses the connection. */
  page?: (url: string) => Promise<{ status: number; text: string }> | { status: number; text: string }
  /** The context by category, given when the session is asked for a breakdown; unset gives none. */
  breakdown?: unknown
  /** The helpers the engine lists. */
  agents?: Partial<AgentInfo>[]
  /** What the model answers to one request; unset answers with no tools and no usage. A throw fails the request. */
  step?: (index: number, agentId?: string) => Partial<TurnStepResult>
  /** The pieces a response streams before it ends. */
  chunks?: { kind: 'text'; index: number; text: string }[]
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
  const fetched: string[] = []
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('http.fetch', async (_, e) => {
    fetched.push(e.url)
    if (!w.page) throw new Error('connection refused')
    const r = await w.page(e.url)
    return { value: { status: r.status, ok: r.status === 200, headers: {}, text: r.text } }
  })
  on('session.id', () => ({ value: 'session-1' }))
  const breakdowns: string[] = []
  on('session.usage', (_, e) => {
    if (w.usage === null) throw new Error('not known yet')
    const base = w.usage ?? usage()
    const detail = (e as { breakdown?: string } | undefined)?.breakdown
    if (!detail) return { value: base }
    breakdowns.push(detail)
    return { value: w.breakdown === undefined ? base : { ...base, context: { ...base.context, breakdown: w.breakdown } } as SessionUsage }
  })
  on('agent.list', () => ({ value: (w.agents ?? []) as AgentInfo[] }))
  on('turn.step', async function* (_, e) {
    for (const chunk of w.chunks ?? []) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null, ...w.step?.(e.index, e.agentId) }
  })
  on('session.repo', () => ({ value: w.repo === undefined ? REPO : w.repo }))
  const isStamp = (path: string) => path.replace(/\\/g, '/').endsWith('/claude-sessions/.ledger-rebuild')
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || (isStamp(e.path) && w.stamp !== undefined) }))
  on('fs.read', (_, e) => {
    if (isStamp(e.path) && w.stamp === 'unreadable' && !files.has(e.path)) return { deny: 'unreadable' }
    return { value: files.get(e.path) ?? (isStamp(e.path) ? w.stamp ?? '' : '') }
  })
  on('fs.write', (_, e) => {
    if (isStamp(e.path) && w.stamp === 'unwritable') return { deny: 'read-only' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    if (e.argv[0] === 'git') return w.git ? w.git() : ran(GIT_CLEAN)
    if (e.argv[0] === 'gh') return w.gh ? w.gh() : ran('', 1, 'no pull requests found for branch "pane-look"')
    if (e.argv[1] === 'runs') return w.runs ? w.runs([...e.argv]) : ran('', 2, 'flag provided but not defined: -json')
    return w.hrn ? w.hrn([...e.argv]) : ran('', 1)
  })
  on('prompt.fill', (_, e) => { filled.push(e.text); return { isFilled: true, text: e.text, cursor: e.text.length } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'ada' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'ada', title: 'Ada', isShown: w.shown !== false, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, files, runs, filled, store, fetched, breakdowns }
}

/** One model request of the turn, read to its end as the engine reads it; the pane's own updates then land. */
async function request($: Parameters<TestBody>[0], w: { clock: { settle: () => Promise<unknown> } }, index: number, extra: { agentId?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-fable-5-2', effort: 'high', messageCount: 3 + index, ...extra })
  const chunks: unknown[] = []
  let piece = await stream.next()
  while (!piece.done) {
    chunks.push(piece.value)
    piece = await stream.next()
  }
  await w.clock.settle()
  return { chunks, result: piece.value }
}

const spent = (input: number, cached: number, written: number, out: number) =>
  ({ input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: written, output_tokens: out, model: 'claude-fable-5-2' })

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
  expect((svg.match(/stroke-dasharray="4 2"/g) ?? []).length).toBe(1)
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
  expect(githubRepo('https://github.com/o/..')).toBe(null)
  expect(githubRepo('git@github.com:o/.github.git')).toEqual({ owner: 'o', name: '.github' })
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

type Case = { name: string; w: World; view: 'session' | 'agent' | 'repo' | 'you'; check: (all: string, has: (key: string) => Promise<boolean>) => Promise<void> | void }

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
  { name: 'no request yet', w: {}, view: 'agent', check: all => {
    expect(all.includes('Waiting for a prompt.')).toBe(true)
    expect(all.includes('No request yet')).toBe(true)
    expect(all.includes('request by request')).toBe(false)
    expect(all.includes('What the model read')).toBe(false)
    expect(all.includes('What fills the context')).toBe(false)
    expect(all.includes('Helpers')).toBe(false)
  } },
  { name: 'no hrn on this computer', w: { hrn: () => cannotStart('hrn') }, view: 'agent', check: all => {
    expect(all.includes('hrn has not answered here: this is the session alone.')).toBe(true)
  } },
  { name: 'hrn here, nothing handed over', w: { repo: null, hrn: () => ran(JSON.stringify(wire)) }, view: 'agent', check: all => {
    expect(all.includes('Nothing handed to hrn this session.')).toBe(true)
  } },
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

const OLD_STATES: [string, Record<string, unknown>][] = [
  ['ada-2', { stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'progress', prompts: 3,
    started: 2, finished: 2, lastTool: 'Bash', lastStatus: 'ok', reaction: 'Old words.', mood: 'idle', recordingFailed: false }],
  ['ada-3', { stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'repo', reaction: 'Old words.', mood: 'idle',
    recordingFailed: false, lastTool: 'Bash', lastToolAt: 0, lastStatus: 'ok', running: 0, calls: [], callCount: 0, failedCount: 0,
    slowest: null, turnStartedAt: 0, turnCalls: 0, tick: 0, lastTurn: null, tests: null, editedSinceTests: false, git: null, pr: { kind: 'unknown' } }],
  ['ada-4', { stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'repo', reaction: 'Old words.', mood: 'idle',
    recordingFailed: false, lastTool: 'Bash', lastToolAt: 0, lastStatus: 'ok', running: 0, calls: [], callCount: 0, failedCount: 0,
    slowest: null, turnStartedAt: 0, turnCalls: 0, tick: 0, lastTurn: { ms: 5, calls: 1 }, tests: null, editedSinceTests: false,
    git: null, pr: { kind: 'unknown' }, delivery: null, runs: null }],
]
OLD_STATES.forEach(([shape, value], i) => test(`state an earlier build kept under ${shape} is reset, not read`, async ($, on) => {
  world(on, { now: 190_000_000 + i * 1_000_000, repo: null })
  on('state.get', () => ({ value: { value: { shape, value }, version: 1 } }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('Old words.')).toBe(false)
    expect(all.includes('No tool calls yet')).toBe(true)
    expect((await ui.find({ key: 'view-session' }))?.props.variant).toBe('primary')
    await ui.unmount()
  }
}))

test('stats from hrn are kept and drawn in the you view, and Refresh asks again', async ($, on) => {
  const w = world(on, { now: 210_000_000, repo: null, hrn: () => ran(JSON.stringify(wire)) })
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

// ---- Delivered here and runs here ----

const REPO_NAME = 'cristiangirlea/ada-pane'

const repoWire = {
  ...wire, week: { delivery: 1820, practice: 30 }, familiarity: null,
  repo: {
    name: REPO_NAME, week: 545, days: [...Array(33).fill(0), 100, 445],
    kinds: { inside_ceiling: 41, review_clean: 6, bug_squashed: 2, script_reused: 1, routed_failed: 0 }, share: 0.2995,
  },
  top: [{ repo: 'cristiangirlea/harness', week: 900 }, { repo: REPO_NAME, week: 545 }, { repo: '../bad', week: 5 }],
}

const runsWire = (now: number) => ({
  version: 1,
  runs: [
    { id: 'r1', backend: 'claude', status: 'running', started: new Date(now - 12 * 60000).toISOString(), duration_ms: 0, repo: 'github.com/' + REPO_NAME, branch: 'x' },
    { id: 'r0', backend: 'codex', status: 'running', started: new Date(now - 8 * 3600000).toISOString(), duration_ms: 0, repo: 'github.com/' + REPO_NAME, branch: '' },
    { id: 'r2', backend: 'codex', status: 'ok', started: new Date(now - 2 * 3600000).toISOString(), duration_ms: 192000, repo: 'github.com/' + REPO_NAME, branch: '' },
    { id: 'r3', backend: 'claude', status: 'error', started: new Date(now - 3 * 3600000).toISOString(), duration_ms: 45000, repo: 'github.com/' + REPO_NAME, branch: '' },
  ],
})

test('hrn’s per-repository answers are read with care', () => {
  const d = parseDelivery(JSON.stringify(repoWire), 'CristianGirlea/Ada-Pane')
  expect(d).toEqual({
    name: 'CristianGirlea/Ada-Pane', week: 545, total: 1820, days: [...Array(33).fill(0), 100, 445],
    kinds: [{ kind: 'inside_ceiling', count: 41 }, { kind: 'review_clean', count: 6 }, { kind: 'bug_squashed', count: 2 }],
    share: 0.2995, top: [{ repo: 'cristiangirlea/harness', week: 900 }, { repo: REPO_NAME, week: 545 }],
  })
  expect(parseDelivery(JSON.stringify(repoWire), 'someone/else')).toBe(null)
  expect(parseDelivery(JSON.stringify(wire), REPO_NAME)).toBe(null)
  expect(parseDelivery(JSON.stringify({ ...repoWire, repo: { ...repoWire.repo, days: [1, 2] } }), REPO_NAME)).toBe(null)
  expect(parseDelivery(JSON.stringify({ ...repoWire, repo: { ...repoWire.repo, share: 7 } }), REPO_NAME)?.share).toBe(1)
  expect(parseDelivery('not json', REPO_NAME)).toBe(null)
  const now = Date.parse('2026-11-20T12:00:00Z')
  const runs = parseRuns(JSON.stringify(runsWire(now)))
  expect(runs?.map(r => [r.id, r.status, r.ms])).toEqual([['r1', 'running', 0], ['r0', 'running', 0], ['r2', 'ok', 192000], ['r3', 'error', 45000]])
  expect(runs?.filter(r => isLive(r, now)).map(r => r.id)).toEqual(['r1'])
  expect(parseRuns(JSON.stringify({ version: 2, runs: [] }))).toBe(null)
  expect(parseRuns(JSON.stringify({ version: 1, runs: [{ id: 'x', backend: '<b>', status: 'ok', started: 'never' }] }))).toEqual([])
  expect(parseRuns(JSON.stringify({ version: 1, runs: [{ id: 'x', backend: '<b>', status: 'ok', started: '2026-11-20T10:00:00Z', duration_ms: -4 }] })))
    .toEqual([{ id: 'x', backend: 'unknown', status: 'ok', started: Date.parse('2026-11-20T10:00:00Z'), ms: 0 }])
  expect(kindLine('inside_ceiling', 41)).toBe('41 runs inside their ceiling')
  expect(kindLine('review_clean', 1)).toBe('1 clean review')
  expect(kindLine('something_new', 3)).toBe('3 something new')
  const strip35 = deliveryStrip([...Array(33).fill(0), 100, 445])
  expect((strip35.match(/<rect /g) ?? []).length).toBe(35)
  expect(/<script|on\w+=|href=/i.test(strip35)).toBe(false)
})

test('stats are asked per repository, with a short limit, where the session has a GitHub repository', async ($, on) => {
  const w = world(on, { now: 400_000_000, hrn: () => ran(JSON.stringify(repoWire)) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const stats = w.runs.filter(r => r.argv[1] === 'bot' && r.argv.includes('--json'))
  // One reading at start and one after the ledger rebuild, both per repository.
  expect(stats.length).toBe(2)
  for (const run of stats) expect(run).toEqual({ argv: ['hrn', 'bot', 'stats', '--json', '--repo', REPO_NAME], cwd: undefined, timeoutMs: 8000 })
  expect((w.store.get('stats') as { delivery: { week: number } }).delivery.week).toBe(545)
})

test('an hrn that refuses --repo is asked the old way, and not per repository again for an hour', async ($, on) => {
  const w = world(on, { now: 410_000_000, hrn: argv => (argv.includes('--repo') ? ran('', 1, 'hrn: unexpected argument "--repo": hrn bot stats takes none') : ran(JSON.stringify(wire))) })
  const stats = () => w.runs.filter(r => r.argv[1] === 'bot' && r.argv.includes('--json')).map(r => [r.argv.length, r.timeoutMs])
  await $.command.run(slash('ada'))
  await w.clock.settle()
  expect(stats()).toEqual([[6, 8000], [4, 180000]])
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-you' })
  expect((await texts(ui)).includes('Level 9')).toBe(true)
  await ui.press({ key: 'refresh' })
  expect(stats().slice(2)).toEqual([[4, 180000]])
  await w.clock.advance(3_700_000)
  await ui.press({ key: 'refresh' })
  expect(stats().slice(3)).toEqual([[6, 8000], [4, 180000]])
  await ui.unmount()
})

test('the repo view draws what was delivered here, the runs here and the top repositories', async ($, on) => {
  const now = 420_000_000
  const w = world(on, { now, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(repoWire)), runs: () => ran(JSON.stringify(runsWire(now))) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.runs.filter(r => r.argv[1] === 'runs').map(r => r.argv)).toEqual([['hrn', 'runs', '--json', '--repo', REPO_NAME, '-n', '8']])
  expect(w.runs.find(r => r.argv[1] === 'runs')?.timeoutMs).toBe(8000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    for (const words of ['Delivered here', '545', 'This week 545 of 1,820', '41 runs inside their ceiling', '6 clean reviews', '2 bugs squashed',
      'Runs here', 'claude, running 12 m', 'codex, 3 m 12 s, 1 h ago', 'claude, 45 s, 2 h ago', 'Top repositories this week',
      'cristiangirlea/harness, 900', `${REPO_NAME}, 545 (this one)`]) {
      expect([surface, words, all.includes(words)]).toEqual([surface, words, true])
    }
    // A run that never ended long ago is not running now.
    expect(all.includes('codex, running')).toBe(false)
    expect(all.includes('1 kept script reused')).toBe(false)
    expect(all.includes('../bad')).toBe(false)
    if (surface === 'terminal') {
      expect(all.includes('30%')).toBe(true)
      expect(all.includes('▁'.repeat(33))).toBe(true)
    } else {
      const sources = (await ui.findAll({ type: 'Svg' })).map(x => String(x.props.source))
      expect(sources[0]?.includes('stroke-dasharray="37.64 125.66"')).toBe(true)
      expect(sources.some(src => src.includes('Delivery in the last 35 days'))).toBe(true)
    }
    await ui.unmount()
  }
})

test('state “nothing delivered here yet” draws without an error', async ($, on) => {
  const empty = { ...repoWire, repo: { name: REPO_NAME, week: 0, days: Array(35).fill(0), kinds: {}, share: 0 }, top: [] }
  const w = world(on, { now: 430_000_000, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(empty)), runs: () => ran('{"version":1,"runs":[]}') })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('Nothing delivered here yet')).toBe(true)
    expect(all.includes('No hrn runs here in the last 14 days')).toBe(true)
    expect(all.includes('Top repositories')).toBe(false)
    await ui.unmount()
  }
})

test('state “hrn without --repo” draws the repo view without what hrn cannot give', async ($, on) => {
  const w = world(on, { now: 440_000_000, store: { view: 'repo' }, hrn: argv => (argv.includes('--repo') ? ran('', 1, 'unexpected argument "--repo"') : ran(JSON.stringify(wire))) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('This branch')).toBe(true)
    expect(all.includes('Links')).toBe(true)
    for (const words of ['Delivered here', 'Runs here', 'Top repositories']) expect([words, all.includes(words)]).toEqual([words, false])
    await ui.unmount()
  }
})

test('runs are asked every 30 seconds while one is live, and otherwise as gh is', async ($, on) => {
  const now = 450_000_000
  let live = true
  const cfg: World = {
    now, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(repoWire)),
    runs: () => ran(JSON.stringify(live ? runsWire(now) : { version: 1, runs: runsWire(now).runs.filter(r => r.id !== 'r1') })),
  }
  const w = world(on, cfg)
  const asked = () => w.runs.filter(r => r.argv[1] === 'runs').length
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(asked()).toBe(1)
  await w.clock.advance(30000)
  expect(asked()).toBe(2)
  live = false
  await w.clock.advance(30000)
  expect(asked()).toBe(3)
  // No run is live now: no timer, and a turn's end asks only once 2 minutes have passed since the last answer.
  await w.clock.advance(60000)
  expect(asked()).toBe(3)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(asked()).toBe(3)
  await w.clock.advance(70000)
  expect(asked()).toBe(3)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(asked()).toBe(4)
  cfg.shown = false
  await w.clock.advance(200000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(asked()).toBe(4)
})

const KEPT: [string, boolean][] = [['https://github.com/cristiangirlea/ada-pane.git', true], ['https://github.com/cristiangirlea/other.git', false]]
KEPT.forEach(([remote, shown], i) => test(`a kept delivery shows at once for its own repository only (${shown ? 'same' : 'another'})`, async ($, on) => {
  const kept = parseDelivery(JSON.stringify(repoWire), REPO_NAME)
  const stats = parseStats(JSON.stringify(wire)).stats
  const w = world(on, { now: 460_000_000 + i * 1_000_000, repo: { ...REPO, remote }, store: { view: 'repo', stats: { at: 459_000_000, stats, delivery: kept } }, hrn: () => ran('', 1, 'busy') })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('Delivered here')).toBe(shown)
  await ui.unmount()
}))

test('the 2-minute stats reading runs only while the repo view is on screen', async ($, on) => {
  const cfg: World = { now: 470_000_000, hrn: () => ran(JSON.stringify(repoWire)) }
  const w = world(on, cfg)
  const stats = () => w.runs.filter(r => r.argv[1] === 'bot' && r.argv.includes('--json')).length
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  // What start reads (once, and once after the ledger rebuild) is the baseline.
  const atStart = stats()
  expect(atStart).toBe(2)
  // Session view: turn ends 3 and 6 minutes on ask nothing (the full reading waits 10 minutes).
  for (const at of [180000, 180000]) {
    await w.clock.advance(at)
    await $.turn.complete(turnDone(1000))
    await w.clock.settle()
  }
  expect(stats()).toBe(atStart)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-repo' })
  expect(stats()).toBe(atStart + 1)
  cfg.shown = false
  await w.clock.advance(150000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(stats()).toBe(atStart + 1)
  await ui.unmount()
})

test('an hrn that refuses runs --json is not asked again for an hour', async ($, on) => {
  const w = world(on, { now: 480_000_000, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(repoWire)) })
  const asked = () => w.runs.filter(r => r.argv[1] === 'runs').length
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(asked()).toBe(1)
  for (const step of [180000, 1_620_000]) {
    await w.clock.advance(step)
    await $.turn.complete(turnDone(1000))
    await w.clock.settle()
  }
  expect(asked()).toBe(1)
  await w.clock.advance(1_900_000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(asked()).toBe(2)
})

const LEAVING: [string, (cfg: World, ui: { press: (t: { key: string }) => Promise<unknown> }) => Promise<void>][] = [
  ['the you view is chosen', async (_, ui) => { await ui.press({ key: 'view-you' }) }],
  ['the pane is hidden', async cfg => { cfg.shown = false }],
]
LEAVING.forEach(([name, leave], i) => test(`a live run is not followed once ${name}`, async ($, on) => {
  const now = 490_000_000 + i * 10_000_000
  const cfg: World = { now, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(repoWire)), runs: () => ran(JSON.stringify(runsWire(now))) }
  const w = world(on, cfg)
  const asked = () => w.runs.filter(r => r.argv[1] === 'runs').length
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(asked()).toBe(1)
  await leave(cfg, ui)
  await w.clock.advance(30000)
  await w.clock.advance(30000)
  expect(asked()).toBe(1)
  await ui.unmount()
}))

test('an old hrn in the repo view never runs the slow full reading on every turn', async ($, on) => {
  const w = world(on, { now: 520_000_000, store: { view: 'repo' }, hrn: argv => (argv.includes('--repo') ? ran('', 1, 'unexpected argument "--repo"') : ran(JSON.stringify(wire))) })
  const full = () => w.runs.filter(r => r.argv[1] === 'bot' && r.argv.includes('--json') && !r.argv.includes('--repo')).length
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  // Start reads the old way once, and once more after the ledger rebuild; turns after that add none.
  const atStart = full()
  expect(atStart).toBe(2)
  for (const step of [180000, 180000]) {
    await w.clock.advance(step)
    await $.turn.complete(turnDone(1000))
    await w.clock.settle()
  }
  expect(full()).toBe(atStart)
})

test('a per-repository reading that runs out of time falls back to the full one, then waits an hour', async ($, on) => {
  const w = world(on, { now: 530_000_000, store: { view: 'repo' }, hrn: argv => (argv.includes('--repo') ? cannotStart('timed out') : ran(JSON.stringify(wire))) })
  const asked = () => w.runs.filter(r => r.argv[1] === 'bot' && r.argv.includes('--json')).map(r => r.argv.includes('--repo') ? r.timeoutMs : 'full')
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  // The reading after the ledger rebuild comes within the hour, so it goes the old way too.
  expect(asked()).toEqual([8000, 'full', 'full'])
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.includes('Delivered here')).toBe(false)
  await ui.press({ key: 'view-you' })
  expect((await texts(ui)).includes('Level 9')).toBe(true)
  await ui.press({ key: 'refresh' })
  expect(asked()).toEqual([8000, 'full', 'full', 'full'])
  await ui.unmount()
})

test('runs that stopped without a result are listed as such, never as an empty section', async ($, on) => {
  const now = 540_000_000
  const stale = { version: 1, runs: [{ id: 'r0', backend: 'codex', status: 'running', started: new Date(now - 8 * 3600000).toISOString(), duration_ms: 0, repo: '', branch: '' }] }
  const w = world(on, { now, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(repoWire)), runs: () => ran(JSON.stringify(stale)) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect((await texts(ui)).includes('codex, stopped without a result, 8 h ago')).toBe(true)
    await ui.unmount()
  }
})

test('a kept delivery that cannot be read still leaves the kept stats', async ($, on) => {
  const stats = parseStats(JSON.stringify(wire)).stats
  const w = world(on, { now: 550_000_000, store: { view: 'you', stats: { at: 549_000_000, stats, delivery: { name: REPO_NAME, kinds: 'broken' } } }, hrn: () => ran('', 1, 'busy') })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('Level 9')).toBe(true)
  await ui.unmount()
})

test('a kept delivery from an earlier week is not shown', async ($, on) => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const stats = parseStats(JSON.stringify(wire)).stats
  const lastWeek = Date.parse('2026-11-15T12:00:00Z')
  const kept = { name: REPO_NAME, week: 545, total: 1820, days: Array(35).fill(1), kinds: [], share: 0.3, top: [] }
  const w = world(on, { now, store: { view: 'repo', stats: { at: lastWeek, stats, delivery: kept } }, hrn: () => ran('', 1, 'busy') })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('Delivered here')).toBe(false)
  await ui.unmount()
})

test('a runs reading that fails after one that worked hides runs here', async ($, on) => {
  const now = 560_000_000
  const cfg: World = { now, store: { view: 'repo' }, hrn: () => ran(JSON.stringify(repoWire)), runs: () => ran(JSON.stringify(runsWire(now))) }
  const w = world(on, cfg)
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('Runs here')).toBe(true)
  cfg.runs = () => ran('', 1, 'hrn: cannot read run records')
  await w.clock.advance(30000)
  expect((await texts(ui)).includes('Runs here')).toBe(false)
  await ui.unmount()
})

test('the week starts on Monday at midnight UTC, as hrn’s does', () => {
  expect(new Date(weekStart(Date.parse('2026-11-20T15:00:00Z'))).toISOString()).toBe('2026-11-16T00:00:00.000Z')
  expect(new Date(weekStart(Date.parse('2026-11-16T00:00:00Z'))).toISOString()).toBe('2026-11-16T00:00:00.000Z')
  expect(new Date(weekStart(Date.parse('2026-11-22T23:59:59Z'))).toISOString()).toBe('2026-11-16T00:00:00.000Z')
})

// ---- Watch ----

const REPO_STATE = {
  stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'repo', reaction: 'Ready when you are.', mood: 'idle',
  recordingFailed: false, lastTool: '', lastToolAt: 0, lastStatus: '', running: 0, calls: [], callCount: 0, failedCount: 0,
  slowest: null, turnStartedAt: 0, turnCalls: 0, tick: 0, lastTurn: null, tests: null, editedSinceTests: false,
  git: null, pr: { kind: 'none' }, delivery: null, runs: null,
  stage: 'idle', model: '', effort: '', steps: [], stepCount: 0, loopCalls: 0, loopTool: '', loopRunning: 0,
  turnTokens: { fresh: 0, cached: 0, written: 0, out: 0 }, sessionTokens: { fresh: 0, cached: 0, written: 0, out: 0 },
  helperTokens: { fresh: 0, cached: 0, written: 0, out: 0 }, helpersStarted: 0, toolCounts: [],
  handoffs: { sent: 0, running: 0, back: 0, failed: 0, backends: [] }, contextParts: null,
}

const WATCH_PAGE = '<!doctype html><title>Runs · hrn watch</title>'

test('the watch address is a port on this computer, or nothing', () => {
  expect(watchPage('127.0.0.1:8089')).toBe('http://127.0.0.1:8089/')
  expect(watchPage(' localhost:8091 ')).toBe('http://localhost:8091/')
  expect(watchPage('[::1]:9000')).toBe('http://[::1]:9000/')
  for (const bad of ['example.com:8089', '192.168.0.5:8089', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:70000', 'http://127.0.0.1:8089', '127.0.0.1:8089/x', 7, null]) {
    expect([bad, watchPage(bad)]).toEqual([bad, null])
  }
})

test('the watch link is drawn on the terminal only, while a watch answers', async ($, on) => {
  const w = world(on, { now: 600_000_000, store: { view: 'repo' }, page: () => ({ status: 200, text: WATCH_PAGE }) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.fetched).toEqual(['http://127.0.0.1:8089/'])
  const terminal = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await terminal.findAll({ type: 'Link' })).filter(l => l.props.label === 'Watch').map(l => l.props.href)).toEqual(['http://127.0.0.1:8089/'])
  await terminal.unmount()
  // A remote surface would draw a loopback link as plain words, so the words must be absent too.
  const desktop = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await desktop.findAll({ type: 'Link' })).some(l => l.props.label === 'Watch')).toBe(false)
  expect((await desktop.findAll({ text: /Watch/ })).length).toBe(0)
  await desktop.unmount()
})

test('the watch address comes from the option', { options: { watch_address: 'localhost:8091' } }, async ($, on) => {
  const w = world(on, { now: 610_000_000, store: { view: 'repo' }, page: () => ({ status: 200, text: WATCH_PAGE }) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.fetched).toEqual(['http://localhost:8091/'])
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Link' })).filter(l => l.props.label === 'Watch').map(l => l.props.href)).toEqual(['http://localhost:8091/'])
  await ui.unmount()
})

test('an option naming another host is never reached', { options: { watch_address: 'example.com:8089' } }, async ($, on) => {
  const w = world(on, { now: 620_000_000, store: { view: 'repo' }, page: () => ({ status: 200, text: WATCH_PAGE }) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.fetched).toEqual([])
})

const NOT_WATCH: [string, World['page'] | undefined][] = [
  ['nothing listens', undefined],
  ['another server answers', () => ({ status: 200, text: '<title>Something else</title>' })],
  ['the watch refuses', () => ({ status: 403, text: WATCH_PAGE })],
]
NOT_WATCH.forEach(([name, page], i) => test(`no watch link when ${name}`, async ($, on) => {
  const w = world(on, { now: 630_000_000 + i * 1_000_000, store: { view: 'repo' }, page })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.fetched.length).toBe(1)
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Link' })).some(l => l.props.label === 'Watch')).toBe(false)
  await ui.unmount()
}))

test('a watch that never answers is given up on after two seconds', async ($, on) => {
  let clock: { sleep: (ms: number) => Promise<void>; advance: (ms: number) => Promise<void> } | null = null
  const w = world(on, { now: 660_000_000, store: { view: 'repo' }, page: async () => { await clock?.sleep(3_600_000); return { status: 200, text: WATCH_PAGE } } })
  clock = w.clock
  await $.session.start({ cwd: '/work/ada-pane', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  await w.clock.advance(2000)
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Link' })).some(l => l.props.label === 'Watch')).toBe(false)
  await ui.unmount()
  // The hung reading let go of the watch, so the next one after the two-minute wait still asks.
  await w.clock.advance(121000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.fetched.length).toBe(2)
  await w.clock.advance(3_600_000)
})

const NO_LINK_ROOM: [string, World][] = [
  ['the session has no repository', { repo: null }],
  ['the remote is not on GitHub', { repo: { ...REPO, remote: 'https://gitlab.com/o/n.git' } }],
  ['no terminal shows the pane', { surfaces: ['desktop'] }],
]
NO_LINK_ROOM.forEach(([name, extra], i) => test(`the watch is not asked when ${name}`, async ($, on) => {
  const w = world(on, { now: 680_000_000 + i * 1_000_000, store: { view: 'repo' }, page: () => ({ status: 200, text: WATCH_PAGE }), ...extra })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await w.clock.advance(130000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.fetched).toEqual([])
}))

test('a watch that answered is not linked once the option names another address', async ($, on) => {
  const w = world(on, { now: 690_000_000, store: { view: 'repo' }, page: () => ({ status: 200, text: WATCH_PAGE }) })
  on('state.get', () => ({ value: { value: { shape: 'ada-5', value: { ...REPO_STATE, watch: 'http://127.0.0.1:9999/' } }, version: 1 } }))
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  // The kept state is read: its view is the one drawn.
  expect((await ui.find({ key: 'view-repo' }))?.props.variant).toBe('primary')
  expect((await ui.findAll({ type: 'Link' })).some(l => l.props.label === 'Watch')).toBe(false)
  await ui.unmount()
  expect(w.fetched).toEqual([])
})

test('the watch is asked only while the repo view is on screen, at most once in two minutes', async ($, on) => {
  const cfg: World = { now: 670_000_000, page: () => ({ status: 200, text: WATCH_PAGE }) }
  const w = world(on, cfg)
  await $.session.start({ cwd: '/work/ada-pane', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.fetched.length).toBe(0)
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'view-repo' })
  expect(w.fetched.length).toBe(1)
  await w.clock.advance(60000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.fetched.length).toBe(1)
  await w.clock.advance(61000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.fetched.length).toBe(2)
  cfg.shown = false
  await w.clock.advance(200000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.fetched.length).toBe(2)
  await ui.unmount()
})

// ---- Ledger rebuild ----

const STAMP = '/hrn/claude-sessions/.ledger-rebuild'
const isRebuild = (argv: string[]) => argv.length === 3 && argv[1] === 'bot' && argv[2] === 'stats'

test('the ledger is rebuilt when a session starts, then not again for 15 minutes, and the stats are read again after it', async ($, on) => {
  const w = world(on, { now: 700_000_000, repo: null, hrn: () => ran(JSON.stringify(wire)) })
  const rebuilds = () => w.runs.filter(r => isRebuild(r.argv))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(rebuilds().map(r => r.timeoutMs)).toEqual([120000])
  const stamp = [...w.files.entries()].find(([path]) => path.replace(/\\/g, '/').endsWith(STAMP))
  expect(stamp?.[1]).toBe('700000000')
  // The reading after the rebuild is forced, so it comes though one was made a moment before.
  expect(w.runs.filter(r => r.argv.includes('--json')).length).toBe(2)
  await w.clock.advance(10 * 60000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(rebuilds().length).toBe(1)
  await w.clock.advance(6 * 60000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(rebuilds().length).toBe(2)
})

test('a recent rebuild by another session is not repeated', async ($, on) => {
  const now = 710_000_000
  const w = world(on, { now, repo: null, hrn: () => ran(JSON.stringify(wire)), stamp: String(now - 5 * 60000) })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.runs.filter(r => isRebuild(r.argv)).length).toBe(0)
})

test('an unreadable stamp does not stop rebuilds', async ($, on) => {
  const w = world(on, { now: 720_000_000, repo: null, hrn: () => ran(JSON.stringify(wire)), stamp: 'unreadable' })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.runs.filter(r => isRebuild(r.argv)).length).toBe(1)
})

test('a session that cannot keep the stamp still rebuilds at most once in 15 minutes', async ($, on) => {
  const w = world(on, { now: 725_000_000, repo: null, hrn: () => ran(JSON.stringify(wire)), stamp: 'unwritable' })
  const rebuilds = () => w.runs.filter(r => isRebuild(r.argv)).length
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(rebuilds()).toBe(1)
  await w.clock.advance(5 * 60000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(rebuilds()).toBe(1)
  await w.clock.advance(11 * 60000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(rebuilds()).toBe(2)
})

test('no timer rebuilds the ledger while the session is idle', async ($, on) => {
  const w = world(on, { now: 730_000_000, repo: null, hrn: () => ran(JSON.stringify(wire)) })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await w.clock.advance(60 * 60000)
  expect(w.runs.filter(r => isRebuild(r.argv)).length).toBe(1)
})

test('every picture is drawn at the size its markup declares, so the strip stays a thin row', async ($, on) => {
  world(on, { now: 740_000_000, repo: null })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const sizes = (await ui.findAll({ type: 'Svg' })).map(x => [String(x.props.alt).split(',')[0], x.props.width, x.props.height])
  expect(sizes).toEqual([['Ada', 46, 46], ['The last 1 tool calls', 238, 28]])
  await ui.unmount()
  expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="4"><rect width="99" height="99"/></svg>')).toEqual([10, 4])
  expect(svgSize('<svg viewBox="0 0 10 10"></svg>')).toEqual([undefined, undefined])
})

// ---- The agent's loop ----

test('a tool is named without its server, and a response by how it ended', () => {
  expect(shortTool('Bash')).toBe('Bash')
  expect(shortTool('mcp__hrn__run')).toBe('run')
  expect(shortTool('mcp__plugin_x__list__all')).toBe('list__all')
  expect(shortTool('mcp__')).toBe('mcp__')
  expect(shortTool('<b>Bad name</b>')).toBe('bBadnameb')
  expect(shortTool('')).toBe('tool')
  expect(shortTool('a'.repeat(60)).length).toBe(24)
  expect(['tool_use', 'end_turn', 'stop_sequence', 'max_tokens', 'model_context_window_exceeded', 'refusal', 'pause_turn', 'compaction', null, undefined, 'new'].map(stopWord))
    .toEqual(['tools', 'answer', 'answer', 'cut', 'cut', 'refused', 'paused', 'paused', 'none', 'none', 'none'])
  const asked = askedFor([{ name: 'Grep' }, { name: 'Read' }, { name: 'Read' }, { name: 'mcp__hrn__run' }, { name: 'Edit' }, { name: 'Write' }, {}])
  expect(asked).toEqual([{ tool: 'Read', count: 2 }, { tool: 'Grep', count: 1 }, { tool: 'run', count: 1 }, { tool: 'Edit', count: 1 }])
  expect(askedFor(undefined)).toEqual([])
  expect(stepLine({ index: 0, stop: 'tools', tools: asked.slice(0, 2), out: 0 })).toBe('asked for Read ×2, Grep')
  expect((['tools', 'answer', 'cut', 'refused', 'paused', 'none'] as const).map(stop => stepLine({ index: 0, stop, tools: [], out: 0 })))
    .toEqual(['asked for tools', 'answered', 'ran out of room', 'refused', 'paused', 'no response'])
})

test('tokens add up, and the cache’s share is of what was read', () => {
  const none = { fresh: 0, cached: 0, written: 0, out: 0 }
  expect(addTokens(none, null)).toEqual(none)
  const one = addTokens(none, spent(100, 800, 100, 40))
  expect(one).toEqual({ fresh: 100, cached: 800, written: 100, out: 40 })
  expect(addTokens(one, { input_tokens: 5, output_tokens: NaN })).toEqual({ fresh: 105, cached: 800, written: 100, out: 40 })
  expect(cacheShare(one)).toBe(80)
  expect(cacheShare(none)).toBe(null)
  expect(cacheShare({ fresh: 10, cached: 0, written: 0, out: 5 })).toBe(0)
})

test('calls are counted per tool, most called first', () => {
  let counts: { tool: string; count: number }[] = []
  for (const tool of ['Read', 'Bash', 'Bash', 'mcp__hrn__run', 'Bash', 'Read']) counts = countTool(counts, tool)
  expect(counts).toEqual([{ tool: 'Bash', count: 3 }, { tool: 'Read', count: 2 }, { tool: 'run', count: 1 }])
  expect(toolMix(counts)).toBe('Bash 3, Read 2, run 1')
  expect(toolMix(counts, 1)).toBe('Bash 3')
  for (let i = 0; i < 40; i++) counts = countTool(counts, `T${i}`)
  expect(counts.length).toBe(24)
  expect(counts[0]).toEqual({ tool: 'Bash', count: 3 })
})

test('a call that hands a task to hrn is known by the tool or the command’s first words', () => {
  expect(handoff('mcp__hrn__run', { task: 'secret', backend: 'codex' })).toEqual({ backend: 'codex', waits: true })
  expect(handoff('mcp__hrn__batch', {})).toEqual({ backend: '', waits: true })
  // A submitted job answers at once: its end is another tool's to ask for.
  expect(handoff('mcp__hrn__remote_submit', { backend: 'api' })).toEqual({ backend: 'api', waits: false })
  expect(handoff('mcp__hrn__run', { backend: 'Not a backend; rm -rf' })).toEqual({ backend: '', waits: true })
  expect(handoff('mcp__hrn__runs', {})).toBe(null)
  expect(handoff('mcp__hrn__show', {})).toBe(null)
  expect(handoff('mcp__other__run', {})).toBe(null)
  expect(handoff('Bash', { command: 'hrn run -b claude "fix the thing"' })).toEqual({ backend: 'claude', waits: true })
  expect(handoff('Bash', { command: 'cd /work && HRN_HOME=/x hrn batch tasks.json --backend=agy' })).toEqual({ backend: 'agy', waits: true })
  expect(handoff('PowerShell', { command: 'hrn.exe flow plan.json' })).toEqual({ backend: '', waits: true })
  expect(handoff('Bash', { command: 'hrn run -b codex x', run_in_background: true })).toEqual({ backend: 'codex', waits: false })
  // A word of the task, or of the next command, is never taken for a backend.
  expect(handoff('Bash', { command: 'hrn run "rename the -b flag in parser"' })).toEqual({ backend: '', waits: true })
  expect(handoff('Bash', { command: "hrn run 'use --backend secret here'" })).toEqual({ backend: '', waits: true })
  expect(handoff('Bash', { command: 'hrn run task.md && deploy --backend secret' })).toEqual({ backend: '', waits: true })
  expect(handoff('Bash', { command: 'hrn run task.md; other -b secret' })).toEqual({ backend: '', waits: true })
  expect(handoff('Bash', { command: 'hrn run task.md | tee -b secret' })).toEqual({ backend: '', waits: true })
  expect(handoff('Bash', { command: 'hrn run --backend gemini task.md; echo done' })).toEqual({ backend: 'gemini', waits: true })
  expect(handoff('Bash', { command: 'hrn runs --json' })).toBe(null)
  expect(handoff('Bash', { command: 'hrn bot stats' })).toBe(null)
  expect(handoff('Bash', { command: 'echo hrn run -b codex' })).toBe(null)
  expect(handoff('Bash', {})).toBe(null)
  expect(handoff('Read', { command: 'hrn run x' })).toBe(null)
})

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 4000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 90000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 20000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 12000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'Memory\nfiles', tokens: 6000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'Skills', tokens: 3000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'Custom agents', tokens: 1000, color: 'a', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 50000, color: 'a', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 31000, color: 'a', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33000, color: 'a', isDeferred: false, kind: 'buffer' },
    { name: 'Empty', tokens: 0, color: 'a', isDeferred: false, kind: 'used' },
    'not a row',
  ],
}

test('the context by category: largest first, the small ones together, what is outside the window left out', () => {
  expect(parseContextParts(BREAKDOWN)).toEqual([
    { name: 'Messages', tokens: 90000, kind: 'used' }, { name: 'System tools', tokens: 20000, kind: 'used' },
    { name: 'MCP tools', tokens: 12000, kind: 'used' }, { name: 'Memory files', tokens: 6000, kind: 'used' },
    { name: 'System prompt', tokens: 4000, kind: 'used' }, { name: 'Other', tokens: 4000, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' }, { name: 'Free space', tokens: 31000, kind: 'free' },
  ])
  expect(parseContextParts(undefined)).toBe(null)
  expect(parseContextParts({ categories: 'none' })).toBe(null)
  expect(parseContextParts({ categories: [] })).toBe(null)
})

test('what the loop is doing reads as one sentence', () => {
  const idle = { stage: 'idle' as const, stepCount: 0, turnStartedAt: 0, loopTool: '', loopRunning: 0, lastTurn: null, loopCalls: 0 }
  expect(stageLine(idle)).toBe('Waiting for a prompt.')
  expect(stageLine({ ...idle, turnStartedAt: 5, stage: 'model' })).toBe('Request 1: the model reads the conversation and decides what to do.')
  expect(stageLine({ ...idle, turnStartedAt: 5, stage: 'model', stepCount: 3, loopCalls: 4 })).toBe('Request 3: the model reads the results and decides what to do next.')
  expect(stageLine({ ...idle, turnStartedAt: 5, stage: 'tools', loopTool: 'mcp__hrn__run', loopRunning: 1 })).toBe('Running run; the results go back to the model.')
  expect(stageLine({ ...idle, turnStartedAt: 5, stage: 'tools', loopTool: 'Read', loopRunning: 3 })).toBe('Running Read and 2 more; the results go back to the model.')
  // The turn's size is the main loop's: a helper's 30 calls are not its own.
  expect(stageLine({ ...idle, lastTurn: { ms: 1, calls: 31, steps: 2, loopCalls: 1, stopped: false } })).toBe('The last turn took 2 requests and 1 tool call.')
  expect(stageLine({ ...idle, lastTurn: { ms: 1, calls: 3, steps: 1, loopCalls: 3, stopped: true } })).toBe('The last turn was stopped after 1 request and 3 tool calls.')
  expect(countKinds(['Explore', 'general-purpose', 'Explore', 'a b', 'x', 'y'])).toBe('Explore 2, general-purpose 1, other 1')
  expect(countKinds([])).toBe('')
})

test('the loop’s picture: four stations, a lane for hrn when it is here, hollow until a task is sent', () => {
  const stations: Station[] = [
    { label: 'You', line: 'prompt', state: 'done' }, { label: 'Model', line: '3 requests', state: 'now' },
    { label: 'Tools', line: '<script>4 calls', state: 'done' }, { label: 'Answer', line: '0:12', state: 'idle' },
  ]
  const lane = (state: Station['state']): Station[] => [
    { label: 'hrn', line: '1 task', state }, { label: 'Backend', line: 'codex', state }, { label: 'Result', line: 'comes back', state: 'idle' },
  ]
  const alone = loopPicture(stations, null)
  expect(svgSize(alone)).toEqual([320, 34])
  expect((alone.match(/<rect /g) ?? []).length).toBe(4)
  expect(alone.includes('#C24A22')).toBe(true)
  expect(alone.includes('>script4 calls</text>')).toBe(true)
  const unused = loopPicture(stations, lane('idle'))
  expect(svgSize(unused)).toEqual([320, 84])
  expect((unused.match(/<rect /g) ?? []).length).toBe(7)
  expect((unused.match(/fill="none" stroke="#8a94a3" stroke-dasharray="3 2"\/>/g) ?? []).length).toBe(3)
  expect(loopPicture(stations, lane('done')).includes('fill="none" stroke="#8a94a3" stroke-dasharray="3 2"/>')).toBe(false)
  for (const svg of [alone, unused, stack([{ value: 1, fill: '#111' }], 'a <b> & c')]) {
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(/<script|on\w+=|href=|<b>/i.test(svg)).toBe(false)
  }
})

test('a bar split by share fills its length, as a picture and as blocks', () => {
  const parts = [{ value: 60, fill: '#1' }, { value: 30, fill: '#2' }, { value: 0, fill: '#3' }, { value: 10, fill: '#4', faint: true }]
  const svg = stack(parts, 'shares')
  expect(svgSize(svg)).toEqual([320, 10])
  expect([...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m => [Number(m[1]), Number(m[2])])).toEqual([[0, 191], [192, 95], [288, 31]])
  expect((svg.match(/fill-opacity="0.5"/g) ?? []).length).toBe(1)
  expect(stackRuns(parts, 10)).toEqual([{ text: '██████', fill: '#1', faint: false }, { text: '███', fill: '#2', faint: false }, { text: '░', fill: '#4', faint: true }])
  expect(stackRuns(parts).map(r => r.text).join('').length).toBe(30)
  expect(stackRuns([{ value: 0, fill: '#1' }])).toEqual([])
  expect(stack([], 'none').includes('<rect')).toBe(false)
  expect(strip([]).includes('stroke-dasharray="4 2"')).toBe(true)
})

test('the agent view follows a turn: the stage, each request, the tokens and the model, on every surface', async ($, on) => {
  const w = world(on, {
    now: 760_000_000, store: { view: 'agent' },
    step: index => (index === 0
      ? { toolUses: [{ name: 'Read', input: { file_path: '/secret/a' } }, { name: 'Read', input: {} }, { name: 'Grep', input: { pattern: 'secret' } }], stopReason: 'tool_use', usage: spent(1000, 8000, 1000, 1200) }
      : { stopReason: 'end_turn', usage: spent(500, 9500, 0, 310) }),
  })
  let hold = false
  let finish: () => void = () => {}
  on('tool.call', () => (hold ? new Promise<{ result: object }>(resolve => { finish = () => resolve({ result: {} }) }) : { result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await $.prompt.submit(typed('secret prompt'))
  await $.turn.start(turnBegins())
  await request($, w, 0)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect((await ui.find({ key: 'view-agent' }))?.props.variant).toBe('primary')
    expect(all.includes('Thinking')).toBe(true)
    expect(all.includes('claude-fable-5-2, high effort')).toBe(true)
    expect(all.includes('Request 1: the model reads the conversation and decides what to do.')).toBe(true)
    expect(all.includes('This turn, request by request')).toBe(true)
    expect(all.includes('asked for Read ×2, Grep')).toBe(true)
    expect(all.includes('1k written')).toBe(true)
    expect(all.includes('What the model read this turn')).toBe(true)
    expect(all.includes('80% came from the cache')).toBe(true)
    expect(all.includes('From the cache')).toBe(true)
    expect(all.includes('secret')).toBe(false)
    const pictures = (await ui.findAll({ type: 'Svg' })).map(x => [x.props.width, x.props.height])
    expect(pictures).toEqual(surface === 'terminal' ? [] : [[46, 46], [320, 34], [320, 10]])
    if (surface === 'terminal') expect(all.includes('You (prompt)')).toBe(true)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  // A call in flight puts the loop at the tools.
  hold = true
  const call = $.tool.call({ tool: 'Read', file_path: '/secret/a' })
  await w.clock.settle()
  expect((await texts(ui)).includes('Using tools')).toBe(true)
  expect((await texts(ui)).includes('Running Read; the results go back to the model.')).toBe(true)
  finish()
  await call
  await request($, w, 1)
  expect((await texts(ui)).includes('Request 2: the model reads the results and decides what to do next.')).toBe(true)
  expect((await texts(ui)).includes(' 2 answered, 310 written')).toBe(true)
  await $.turn.complete(turnDone(12000))
  await w.clock.settle()
  const after = await texts(ui)
  expect(after.includes('Answered')).toBe(true)
  expect(after.includes('The last turn took 2 requests and 1 tool call.')).toBe(true)
  expect(after.includes('Last turn, request by request')).toBe(true)
  expect(after.includes('What the model read last turn')).toBe(true)
  expect(after.includes('88% came from the cache')).toBe(true)
  expect(after.includes('This session: 20k read, 2k written.')).toBe(true)
  expect(after.includes('secret')).toBe(false)
  // The next turn starts its own list.
  await $.turn.start(turnBegins())
  expect((await texts(ui)).includes('request by request')).toBe(false)
  await ui.unmount()
})

test('only the newest eight requests of a turn are listed, with a count of the earlier ones', async ($, on) => {
  const w = world(on, { now: 765_000_000, store: { view: 'agent' }, step: () => ({ toolUses: [{ name: 'Read', input: {} }], stopReason: 'tool_use' }) })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await $.turn.start(turnBegins())
  for (let i = 0; i < 11; i++) await request($, w, i)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.includes('3 earlier requests')).toBe(true)
  expect((all.match(/asked for Read/g) ?? []).length).toBe(8)
  expect(all.includes('Request 11')).toBe(true)
  await ui.unmount()
})

test('a helper’s requests are counted as the helpers’, never listed as the turn’s', async ($, on) => {
  const w = world(on, {
    now: 770_000_000, store: { view: 'agent' },
    step: (_, agentId) => (agentId ? { toolUses: [{ name: 'Grep', input: {} }], stopReason: 'tool_use', usage: spent(2000, 1000, 0, 700) } : { stopReason: 'tool_use', toolUses: [{ name: 'Agent', input: { prompt: 'secret task' } }] }),
    agents: [
      { id: 'a1', type: 'Explore', status: 'running', description: 'secret task', label: 'secret label' },
      { id: 'a2', type: 'Explore', status: 'completed', description: 'secret task', label: 'secret label' },
      { id: 'a3', type: 'general-purpose', status: 'waiting', description: 'secret task', label: 'secret label' },
    ],
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await $.turn.start(turnBegins())
  await request($, w, 0)
  await $.tool.call({ tool: 'Agent', prompt: 'secret task', description: 'secret', subagent_type: 'Explore' })
  await $.turn.start(turnBegins({ agentId: 'a1' }))
  await request($, w, 0, { agentId: 'a1' })
  // A compaction or memory pass is the engine's own loop: what it reads is not a helper's.
  await request($, w, 0, { agentId: 'fork-9' })
  // A helper's call does not move the main loop off the model.
  await request($, w, 1)
  await $.tool.call({ tool: 'Grep', pattern: 'secret', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'secret', agentId: 'a1' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('Thinking')).toBe(true)
    expect(all.includes('Request 2: the model reads the results and decides what to do next.')).toBe(true)
    expect(all.includes(surface === 'terminal' ? 'Tools (1 call)' : 'They read')).toBe(true)
    expect(all.includes('asked for Grep')).toBe(false)
    expect(all.includes('asked for Agent')).toBe(true)
    expect(all.includes('2 running, 3 started this session')).toBe(true)
    expect(all.includes('Explore 2, general-purpose 1')).toBe(true)
    expect(all.includes('They read 3k and wrote 700.')).toBe(true)
    expect(all.includes('secret')).toBe(false)
    await ui.unmount()
  }
  await $.turn.complete(turnDone(4000))
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await texts(ui)).includes('The last turn took 2 requests and 1 tool call.')).toBe(true)
  await ui.press({ key: 'view-session' })
  // The session view counts every call of the turn, a helper's too.
  expect((await texts(ui)).includes('3 tool calls')).toBe(true)
  await ui.unmount()
})

test('a request’s pieces pass through in order and its result is what the model gave', async ($, on) => {
  const chunks = [{ kind: 'text' as const, index: 0, text: 'one ' }, { kind: 'text' as const, index: 0, text: 'two' }]
  const w = world(on, { now: 772_000_000, chunks, step: () => ({ answer: 'one two', stopReason: 'end_turn', usage: spent(1, 2, 3, 4) }) })
  await $.turn.start(turnBegins())
  const got = await request($, w, 0)
  expect(got.chunks).toEqual(chunks)
  expect(got.result).toEqual({ turnId: 't1', index: 0, answer: 'one two', toolUses: [], stopReason: 'end_turn', usage: spent(1, 2, 3, 4) })
})

test('a request that fails still fails for its caller, and a stopped turn is not drawn as answered', async ($, on) => {
  const w = world(on, { now: 773_000_000, store: { view: 'agent' }, step: () => { throw new Error('overloaded') } })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await $.turn.start(turnBegins())
  let failed = false
  try { await request($, w, 0) } catch { failed = true }
  expect(failed).toBe(true)
  await $.turn.complete(turnDone(2000, { isAborted: true }))
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('Stopped')).toBe(true)
    expect(all.includes('Answered')).toBe(false)
    expect(all.includes('The last turn was stopped after 1 request and 0 tool calls.')).toBe(true)
    expect(all.includes('request by request')).toBe(false)
    if (surface === 'terminal') expect(all.includes('Answer (stopped)')).toBe(true)
    await ui.unmount()
  }
})

test('a request goes through though the pane cannot keep what it saw', async ($, on) => {
  let refuse = false
  const w = world(on, { now: 774_000_000, step: () => ({ answer: 'fine', stopReason: 'end_turn', usage: spent(1, 2, 3, 4) }) })
  on('state.set', (_, e, next) => (refuse ? { deny: 'no room' } : next(e)))
  await $.turn.start(turnBegins())
  refuse = true
  const got = await request($, w, 0)
  expect(got.result.answer).toBe('fine')
  refuse = false
})

test('calls side by side: on it while one still runs, thinking once the last is back', async ($, on) => {
  const w = world(on, { now: 776_000_000 })
  const waiting: (() => void)[] = []
  on('tool.call', () => new Promise<{ result: object }>(resolve => { waiting.push(() => resolve({ result: {} })) }))
  await $.turn.start(turnBegins())
  const first = $.tool.call({ tool: 'Read', file_path: '/a' })
  const second = $.tool.call({ tool: 'Grep', pattern: 'x' })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-agent' })
  expect((await texts(ui)).includes('Running Grep and 1 more; the results go back to the model.')).toBe(true)
  waiting[0]?.()
  await first
  await ui.press({ key: 'view-session' })
  expect((await texts(ui)).includes('On it.')).toBe(true)
  waiting[1]?.()
  await second
  expect((await texts(ui)).includes('Thinking it over.')).toBe(true)
  await ui.unmount()
})

test('the context is broken down only while the agent view is on screen, at most once a minute', async ($, on) => {
  const cfg: World = { now: 775_000_000, breakdown: BREAKDOWN }
  const w = world(on, cfg)
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.breakdowns).toEqual([])
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-agent' })
  expect(w.breakdowns).toEqual(['summary'])
  expect(w.store.get('view')).toBe('agent')
  const all = await texts(ui)
  expect(all.includes('What fills the context')).toBe(true)
  expect(all.includes('Messages')).toBe(true)
  expect(all.includes('90k')).toBe(true)
  expect(all.includes('Autocompact buffer')).toBe(true)
  expect(all.includes('deferred')).toBe(false)
  expect((await ui.findAll({ type: 'Svg' })).some(x => String(x.props.alt) === 'The context window by what fills it')).toBe(true)
  await w.clock.advance(30000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.breakdowns.length).toBe(1)
  await w.clock.advance(31000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.breakdowns.length).toBe(2)
  cfg.shown = false
  await w.clock.advance(61000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.breakdowns.length).toBe(2)
  cfg.shown = true
  await ui.press({ key: 'view-session' })
  await w.clock.advance(61000)
  await $.turn.complete(turnDone(1000))
  await w.clock.settle()
  expect(w.breakdowns.length).toBe(2)
  await ui.unmount()
})

test('a session that gives no breakdown draws the agent view without that section', async ($, on) => {
  const w = world(on, { now: 778_000_000, store: { view: 'agent' } })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(w.breakdowns).toEqual(['summary'])
  expect((await texts(ui)).includes('What fills the context')).toBe(false)
  expect((await texts(ui)).includes('The loop')).toBe(true)
  await ui.unmount()
})

test('tasks handed to hrn are counted by their result, and the lane lights up', async ($, on) => {
  const w = world(on, { now: 780_000_000, store: { view: 'agent' }, hrn: () => cannotStart('hrn') })
  let fail = false
  on('tool.call', () => (fail ? { result: {}, isError: true as const } : { result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const alone = await $.ui.mount({ ...pane, surface: 'desktop' })
  // Without hrn the picture is the session alone.
  expect((await alone.findAll({ type: 'Svg' })).map(x => x.props.height)).toEqual([46, 34])
  await alone.unmount()
  await $.tool.call({ tool: 'mcp__hrn__run', task: 'secret task', backend: 'codex' } as never)
  fail = true
  await $.tool.call({ tool: 'Bash', command: 'hrn run -b claude "secret task"' })
  fail = false
  await $.tool.call({ tool: 'Bash', command: 'hrn batch secret.json', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'hrn runs --json' })
  await $.tool.call({ tool: 'Bash', command: 'hrn run "rename the -b flag in secret"' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    const all = await texts(ui)
    expect(all.includes('4 tasks handed over: 2 came back, 1 failed')).toBe(true)
    expect(all.includes('On codex, claude')).toBe(true)
    expect(all.includes('secret')).toBe(false)
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).map(x => x.props.height)).toEqual([46, 84])
    else expect(all.includes('hrn (4 tasks)')).toBe(true)
    await ui.unmount()
  }
})

test('a refused hrn call hands nothing over, a submitted job is not waited for, and a call that never answers is not left running', async ($, on) => {
  const w = world(on, { now: 782_000_000, store: { view: 'agent' } })
  let answer: 'ok' | 'deny' | 'throw' = 'deny'
  on('tool.call', () => {
    if (answer === 'throw') throw new Error('lost')
    return answer === 'deny' ? { deny: 'not allowed' } : { result: {} }
  })
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  await $.tool.call({ tool: 'mcp__hrn__run', task: 'x', backend: 'codex' } as never)
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect((await texts(ui)).includes('handed over')).toBe(false)
  answer = 'ok'
  await $.tool.call({ tool: 'mcp__hrn__remote_submit', task: 'x' } as never)
  expect((await texts(ui)).includes('1 task handed over: not waited for')).toBe(true)
  answer = 'throw'
  let failed = false
  try { await $.tool.call({ tool: 'mcp__hrn__run', task: 'x' } as never) } catch { failed = true }
  expect(failed).toBe(true)
  const all = await texts(ui)
  expect(all.includes('2 tasks handed over: 1 failed')).toBe(true)
  expect(all.includes('running')).toBe(false)
  await ui.unmount()
})

test('inside a turn a finished call is not the end of it', async ($, on) => {
  world(on, { now: 785_000_000 })
  on('tool.call', () => ({ result: {} }))
  await $.turn.start(turnBegins())
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  let all = await texts(ui)
  expect(all.includes('Thinking it over.')).toBe(true)
  expect(all.includes('Done')).toBe(false)
  expect(all.includes('Working')).toBe(true)
  await $.turn.complete(turnDone(3000))
  all = await texts(ui)
  expect(all.includes('Done. What’s next?')).toBe(true)
  expect(all.includes('Working')).toBe(false)
  expect((all.match(/Done/g) ?? []).length).toBe(1)
  await ui.unmount()
})

test('the session view names the tools called most', async ($, on) => {
  world(on, { now: 788_000_000 })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  // One tool alone says nothing the line above it does not.
  expect((await texts(ui)).includes('Read 1')).toBe(false)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((await texts(ui)).includes('Bash 2, Read 1')).toBe(true)
  await ui.unmount()
})

test('a branch read in a repository is not shown once the session stands outside one', async ($, on) => {
  const cfg: World = { now: 790_000_000 }
  const w = world(on, cfg)
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(ui)).includes('pane-look, no changes')).toBe(true)
  await ui.unmount()
  cfg.repo = null
  const outside = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect((await texts(outside)).includes('pane-look')).toBe(false)
  expect(await outside.find({ key: 'view-repo' })).toBeUndefined()
  await outside.unmount()
})

// ---- Privacy ----

test('nothing new reaches the recording file', async ($, on) => {
  const w = world(on, {
    now: 250_000_000, git: () => ran(GIT_CHANGED), gh: () => ran(JSON.stringify(PR)), hrn: () => ran(JSON.stringify(repoWire)), runs: () => ran(JSON.stringify(runsWire(250_000_000))),
    chunks: [{ kind: 'text', index: 0, text: 'secret answer' }],
    step: () => ({ answer: 'secret answer', toolUses: [{ name: 'Bash', input: { command: 'cat /secret/file' } }], stopReason: 'tool_use', usage: spent(1, 2, 3, 4) }),
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/work/ada-pane', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('secret prompt'))
  await $.turn.start(turnBegins())
  await $.tool.call({ tool: 'Bash', command: 'go test ./secret/...' })
  await $.tool.call({ tool: 'Edit', file_path: '/secret/file', old_string: 'a', new_string: 'b' })
  await request($, w, 0)
  await $.tool.call({ tool: 'mcp__hrn__run', task: 'secret task', backend: 'codex' } as never)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await ui.press({ key: 'view-repo' })
  await ui.press({ key: 'view-agent' })
  expect((await texts(ui)).includes('asked for Bash')).toBe(true)
  expect((await texts(ui)).includes('secret')).toBe(false)
  await ui.unmount()
  await $.turn.complete(turnDone(4000))
  await w.clock.advance(20000)
  const written = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  // Beside the recording only the ledger rebuild's stamp is written, and it holds a time alone.
  expect([...w.files.keys()].map(written).sort()).toEqual(['/hrn/claude-sessions/.ledger-rebuild', '/hrn/claude-sessions/session-1.jsonl'])
  const stamp = [...w.files.entries()].find(([path]) => written(path).endsWith('.ledger-rebuild'))?.[1] ?? ''
  expect(/^\d+$/.test(stamp)).toBe(true)
  w.files.delete([...w.files.keys()].find(path => written(path).endsWith('.ledger-rebuild')) ?? '')
  const rows = [...w.files.values()].join('').trim().split('\n').map(line => JSON.parse(line))
  expect(rows).toEqual([
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'prompt' },
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'tool', tool: 'Bash', status: 'ok' },
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'tool', tool: 'Edit', status: 'ok' },
    { time: new Date(250_000_000).toISOString(), session: 'session-1', kind: 'tool', tool: 'mcp__hrn__run', status: 'ok' },
  ])
  expect(/secret|pane-look|Pane look|go test|ada-pane|harness|codex|claude,|r1|\.\.\/bad/.test([...w.files.values()].join(''))).toBe(false)
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
