import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, RenderChildren, SessionUsage, Timer } from 'claude-code'
import type { AdaState, AdaView, CheckState, GitStatus, PrReading, PullRequest, Stats, TestRun, ToolBar } from '../types'

const initial: AdaState = {
  stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'session',
  reaction: 'Ready when you are.', mood: 'idle', recordingFailed: false,
  lastTool: '', lastToolAt: 0, lastStatus: '', running: 0,
  calls: [], callCount: 0, failedCount: 0, slowest: null,
  turnStartedAt: 0, turnCalls: 0, tick: 0, lastTurn: null,
  tests: null, editedSinceTests: false, git: null, pr: { kind: 'unknown' },
}

// The tag declines what a version with other fields stored.
const pane = atom({ plugin: 'ada-pane', key: 'pane' } as const, initial, { shape: 'ada-3' })

// hrn reads every run record: a first answer has taken over a minute.
const STATS_TIMEOUT_MS = 180000
const STATS_EVERY_MS = 600000
const GIT_TIMEOUT_MS = 3000
const GIT_EVERY_MS = 10000
const PR_TIMEOUT_MS = 8000
const PR_EVERY_MS = 120000
const STRIP_CALLS = 40

const SCARLET = '#D85A30'
const UNFILLED = '#8a94a3'
const OK_FILL = '#2a9d6a'
const FAILED_FILL = '#d64545'

// No optional locks: a status read must never hold the index lock the agent's own git needs.
const GIT_ARGS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'] as const
const PR_ARGS = ['gh', 'pr', 'view', '--json', 'number,title,state,reviewDecision,statusCheckRollup,closingIssuesReferences'] as const
const FILE_WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

let lastRefresh = -Infinity
let statsBusy = false
let writes = Promise.resolve()
let ticker: Timer | null = null
let gitAt = -Infinity
let gitBusy = false
let gitLater: Timer | null = null
let gitLaterAt = 0
let prAt = -Infinity
let prBusy = false

async function change($: EngineInterface, fn: (s: AdaState) => AdaState) {
  try { await update($, pane, fn) } catch { /* Observation must not affect the session. */ }
}

// A clock that moved back (a new session's mocked or reset time) never holds a call back.
const tooSoon = (now: number, at: number, every: number) => now >= at && now - at < every

const whole = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

/** What the pane keeps of hrn's answer; null when it is not one. */
export function parseStats(text: string): { stats: Stats | null; note: string } {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) } catch { return { stats: null, note: 'hrn gave no stats' } }
  if (raw === null || typeof raw !== 'object') return { stats: null, note: 'hrn gave no stats' }
  if (raw.enabled === false) return { stats: null, note: 'The experience game is off in hrn' }
  if (typeof raw.level !== 'number' || typeof raw.xp !== 'number') return { stats: null, note: 'hrn gave no stats' }
  const week = (raw.week ?? {}) as Record<string, unknown>
  const ada = raw.ada as Record<string, unknown> | null | undefined
  const exercise = raw.exercise as Record<string, unknown> | null | undefined
  return {
    note: '',
    stats: {
      level: whole(raw.level),
      xp: whole(raw.xp),
      streak: typeof raw.streak === 'number' ? whole(raw.streak) : null,
      week: { delivery: whole(week.delivery), practice: whole(week.practice) },
      days: Array.isArray(raw.days) ? raw.days.slice(-35).map(day => day === true) : [],
      badges: Array.isArray(raw.badges) ? raw.badges.filter((b): b is string => typeof b === 'string').slice(0, 40) : [],
      ada: ada ? { level: whole(ada.level), xpThisWeek: whole(ada.xp_this_week) } : null,
      exercise: exercise && typeof exercise.kind === 'string' ? { kind: exercise.kind, answered: exercise.answered === true } : null,
    },
  }
}

async function refresh($: EngineInterface, force = false) {
  try {
    const now = await $.clock.now()
    const state = await read($, pane)
    if (statsBusy || state.refreshing || (!force && tooSoon(now, lastRefresh, STATS_EVERY_MS))) return
    statsBusy = true
    lastRefresh = now
    await change($, s => ({ ...s, refreshing: true }))
    let found: { stats: Stats | null; note: string } = { stats: null, note: 'hrn did not answer' }
    try {
      const result = await $.process.run(['hrn', 'bot', 'stats', '--json'], { timeoutMs: STATS_TIMEOUT_MS })
      if (result.exitCode === 0 && !result.isStdoutTruncated) found = parseStats(result.stdout)
    } catch { found = { stats: null, note: 'hrn is not installed, or did not answer in time' } }
    const at = await $.clock.now()
    if (found.stats) {
      const stats = found.stats
      try { await $.store.set('stats', { at, stats }) } catch { /* The next session reads hrn again. */ }
      await change($, s => ({ ...s, stats, statsAt: at, statsNote: '', refreshing: false }))
    } else {
      // An earlier answer stays on show beside the reason there is no new one.
      await change($, s => ({ ...s, statsNote: found.note, refreshing: false }))
    }
  } catch { await change($, s => ({ ...s, refreshing: false })) } finally { statsBusy = false }
}

/** The stats and view an earlier session kept, shown at once while hrn is asked again. */
async function recall($: EngineInterface) {
  try {
    const view = await $.store.get('view')
    if (view === 'session' || view === 'repo' || view === 'you') await change($, s => ({ ...s, view }))
  } catch { /* Session is the default. */ }
  try {
    const kept = await $.store.get('stats') as { at?: unknown; stats?: unknown } | null | undefined
    if (!kept || typeof kept.at !== 'number' || !kept.stats) return
    const { stats } = parseStats(JSON.stringify(toWire(kept.stats as Stats)))
    if (stats) await change($, s => (s.stats ? s : { ...s, stats, statsAt: kept.at as number }))
  } catch { /* Nothing kept. */ }
}

const toWire = (s: Stats) => ({
  enabled: true, level: s.level, xp: s.xp, streak: s.streak, week: s.week, days: s.days, badges: s.badges,
  ada: s.ada && { level: s.ada.level, xp_this_week: s.ada.xpThisWeek }, exercise: s.exercise,
})

export function record($: EngineInterface, entry: { kind: 'prompt' } | { kind: 'tool'; tool: string; status: 'ok' | 'error' }, limit = 1024 * 1024) {
  writes = writes.then(async () => {
    try {
      const home = await $.env.get('HRN_HOME') || ((await $.env.get('HOME') || await $.env.get('USERPROFILE')) + '/.hrn')
      if (!home || home.startsWith('undefined/')) throw new Error('Home unavailable')
      const session = await $.session.id()
      if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error('Invalid session id')
      const base = `${home.replace(/[\\/]+$/, '')}/claude-sessions/${session}`
      const time = new Date(await $.clock.now()).toISOString()
      const line = JSON.stringify({ time, session, ...entry }) + '\n'
      const bytes = (text: string) => new TextEncoder().encode(text).length
      if (bytes(line) > limit) throw new Error('Record exceeds file limit')
      let number = 1
      let path = `${base}.jsonl`
      let previous = ''
      while (await $.fs.exists(path)) {
        previous = await $.fs.read(path)
        const nextPath = `${base}.${number + 1}.jsonl`
        if (!await $.fs.exists(nextPath)) break
        path = nextPath
        number++
      }
      if (bytes(previous) + bytes(line) > limit) {
        path = `${base}.${number + 1}.jsonl`
        previous = ''
      }
      await $.fs.write(path, previous + line)
    } catch { await change($, s => ({ ...s, recordingFailed: true })) }
  })
  return writes
}

// ---- Readings ----

/** `git status --porcelain=v2 --branch`; null when it is not that output. */
export function parseGitStatus(text: string): GitStatus | null {
  let oid = ''
  let head = ''
  let ahead: number | null = null
  let behind: number | null = null
  let changed = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.head ')) head = line.slice(14).trim()
    else if (line.startsWith('# branch.ab ')) {
      const ab = /^\+(\d+) -(\d+)$/.exec(line.slice(12).trim())
      if (ab) { ahead = Number(ab[1]); behind = Number(ab[2]) }
    } else if (/^[12u?] /.test(line)) changed++
  }
  if (!head) return null
  const detached = head === '(detached)'
  const short = /^[0-9a-f]{7,}$/.test(oid) ? oid.slice(0, 7) : 'an unknown commit'
  return { head: detached ? `detached at ${short}` : head.slice(0, 120), detached, changed, ahead, behind }
}

/** One entry of gh's `statusCheckRollup`: a check run or a commit status. */
export function checkState(item: unknown): CheckState {
  const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
  const upper = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : '')
  if (raw.__typename === 'StatusContext' || (raw.state !== undefined && raw.status === undefined)) {
    const state = upper(raw.state)
    return state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'running'
  }
  if (upper(raw.status) !== 'COMPLETED') return 'running'
  const conclusion = upper(raw.conclusion)
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return 'passed'
  return conclusion === '' ? 'running' : 'failed'
}

/** gh's pull request for the branch, keeping only issues of this repository. */
export function parsePullRequest(text: string, repo: { owner: string; name: string }): PullRequest | null {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || typeof raw.number !== 'number' || !Number.isInteger(raw.number) || raw.number <= 0) return null
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
  const issues = (Array.isArray(raw.closingIssuesReferences) ? raw.closingIssuesReferences : [])
    .map(entry => (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>)
    .filter(entry => {
      const where = entry.repository as { name?: unknown; owner?: { login?: unknown } } | undefined
      return !where || (same(where.name, repo.name) && same(where.owner?.login, repo.owner))
    })
    .map(entry => entry.number)
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    .slice(0, 5)
  const review = raw.reviewDecision === 'APPROVED' ? 'approved'
    : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes'
      : raw.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'none'
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    state: raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open',
    review,
    checks: (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).slice(0, 60).map(checkState),
    issues,
  }
}

/** What a finished `gh pr view` means for the pane. */
export function readPullRequest(result: ProcessRunResult, repo: { owner: string; name: string }): PrReading {
  if (result.exitCode === 0 && !result.isStdoutTruncated) {
    const pr = parsePullRequest(result.stdout, repo)
    return pr ? { kind: 'found', pr } : { kind: 'hidden' }
  }
  if (/no (?:open )?pull requests? found/i.test(result.stderr)) return { kind: 'none' }
  if (/gh auth login|not logged in/i.test(result.stderr)) return { kind: 'note', note: 'gh is not signed in' }
  return { kind: 'hidden' }
}

/** A `gh` that could not run: a start failure means it is missing; anything else hides the section. */
export function readPullRequestFailure(err: unknown): PrReading {
  const message = err instanceof Error ? err.message : String(err)
  return /ENOENT|not found|cannot start|could not start|no such file/i.test(message) ? { kind: 'note', note: 'gh is not installed' } : { kind: 'hidden' }
}

/** `owner/name` of a GitHub remote, in https, scp or ssh spelling; null for any other host. */
export function githubRepo(remote: string | null | undefined): { owner: string; name: string } | null {
  if (typeof remote !== 'string') return null
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  const [, owner = '', name = ''] = m ?? []
  if (!owner || !name || owner.startsWith('.') || name.startsWith('.')) return null
  return { owner, name }
}

/** Built from owner and name alone, so nothing else in the remote (a token) reaches a link. */
export function repoLinks(repo: { owner: string; name: string }) {
  const base = `https://github.com/${repo.owner}/${repo.name}`
  return {
    repository: base, pulls: `${base}/pulls`, actions: `${base}/actions`,
    pull: (n: number) => `${base}/pull/${n}`, issue: (n: number) => `${base}/issues/${n}`,
  }
}

const RUNNERS: [RegExp, string][] = [
  [/^go\s+test\b/, 'go test'],
  [/^npm\s+(?:run\s+)?test\b/, 'npm test'],
  [/^(?:npx\s+)?vitest\b/, 'vitest'],
  [/^(?:python3?\s+-m\s+)?pytest\b/, 'pytest'],
  [/^cargo\s+test\b/, 'cargo test'],
  [/^claude\s+plugin\s+test\b/, 'claude plugin test'],
]

/** The test runner a command starts, by its first words; a runner named later is an argument. */
export function testRunner(command: string): string | null {
  const rest = command.trim()
    .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
  for (const [pattern, name] of RUNNERS) if (pattern.test(rest)) return name
  return null
}

export type Action = { key: 'ask-why' | 'compact' | 'rerun'; label: string; text: string }

/** The one action worth a press now, by the spec's order. */
export function chooseAction(s: Pick<AdaState, 'lastStatus' | 'tests' | 'editedSinceTests'>, context: number | null): Action | null {
  if (s.lastStatus === 'error') {
    return { key: 'ask-why', label: 'Ask why it failed', text: 'Look at the last tool call that failed and tell me why it failed and what to change.' }
  }
  if (context !== null && context >= 70) return { key: 'compact', label: 'Compact now', text: '/compact' }
  if (s.tests && s.editedSinceTests) {
    return { key: 'rerun', label: 'Run the tests again', text: `Run the tests again (${s.tests.runner}) and tell me what changed.` }
  }
  return null
}

// ---- Formatters ----

/** hrn's rule: level n starts at 50 n squared. */
export function levelSpan(level: number, xp: number) {
  const from = 50 * level * level
  const to = 50 * (level + 1) * (level + 1)
  const done = Math.min(to - from, Math.max(0, xp - from))
  return { toGo: to - from - done, percent: Math.round((done / (to - from)) * 100) }
}

export const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ',')

export function age(now: number, at: number) {
  if (!at) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

export const percentText = (n: number) => `${Math.round(Math.min(100, Math.max(0, n)))}%`

export function tokenCount(n: number) {
  const v = Math.max(0, n)
  if (v < 1000) return String(Math.round(v))
  if (v < 999500) return `${Math.round(v / 1000)}k`
  return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

/** `45 s`, `3 m 12 s`, `1 h 5 m`. */
export function duration(ms: number) {
  const seconds = Math.round(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} m ${seconds % 60} s` : `${minutes} m`
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${Math.floor(minutes / 60)} h`
}

/** A stopwatch reading: `2:14`, `1:02:03`. */
export function stopwatch(ms: number) {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return h ? `${h}:${two(m)}:${two(total % 60)}` : `${m}:${two(total % 60)}`
}

/** `resets 3 d`; '' when the time is not one. */
export function resetsIn(now: number, at: string | undefined) {
  const when = at ? Date.parse(at) : NaN
  if (!Number.isFinite(when)) return ''
  const minutes = Math.ceil((when - now) / 60000)
  if (minutes <= 0) return 'resets now'
  if (minutes < 60) return `resets ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `resets ${hours} h` : `resets ${Math.floor(hours / 24)} d`
}

/** How full the context is, 0 to 100; null while the session has not said. */
export function contextPercent(usage: SessionUsage | null): number | null {
  const c = usage?.context
  if (!c) return null
  if (typeof c.percent === 'number' && Number.isFinite(c.percent)) return Math.min(100, Math.max(0, c.percent))
  if (typeof c.tokens === 'number' && c.window > 0) return Math.min(100, Math.max(0, (c.tokens / c.window) * 100))
  return null
}

/** The plan limit nearest its end, else the cost when there are no limits, else nothing. */
export function planFigure(usage: SessionUsage | null, now: number) {
  const limits = (usage?.rateLimits ?? []).filter(l => typeof l.percentUsed === 'number' && Number.isFinite(l.percentUsed))
  if (limits.length) {
    const top = limits.reduce((a, b) => (b.percentUsed > a.percentUsed ? b : a))
    return { caption: 'Plan limit', value: percentText(top.percentUsed), line: resetsIn(now, top.resetsAt), percent: top.percentUsed }
  }
  if (usage?.cost && Number.isFinite(usage.cost.usd)) {
    return { caption: 'Cost', value: `$${usage.cost.usd.toFixed(2)}`, line: 'estimate', percent: null }
  }
  return { caption: 'Plan limit', value: '–', line: 'not reported', percent: null }
}

/** Keeps the newest calls the strip has room for. */
export function pushCall(calls: ToolBar[], bar: ToolBar) {
  return [...calls, bar].slice(-STRIP_CALLS)
}

/** Bar heights on a square-root scale, so one long call does not flatten the rest. */
export function barHeights(ms: number[], tallest: number, shortest = 3) {
  const top = Math.sqrt(Math.max(1, ...ms))
  return ms.map(v => Math.round(shortest + (tallest - shortest) * (Math.sqrt(Math.max(0, v)) / top)))
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** The strip as block characters, runs of failed calls apart so they take the error colour. */
export function blockRuns(calls: ToolBar[]) {
  const levels = barHeights(calls.map(c => c.ms), BLOCKS.length - 1, 0)
  const runs: { text: string; failed: boolean }[] = []
  calls.forEach((call, i) => {
    const last = runs[runs.length - 1]
    const block = BLOCKS[levels[i] ?? 0] ?? '▁'
    if (last && last.failed === !call.ok) last.text += block
    else runs.push({ text: block, failed: !call.ok })
  })
  return runs
}

// ---- Pictures ----

const MOOD_EYE: Record<AdaState['mood'], string> = {
  idle: '<circle cx="39" cy="24" r="3.4" fill="#17202c"/><circle cx="40.2" cy="22.8" r="1.1" fill="#fff"/>',
  busy: '<circle cx="39" cy="24" r="3.4" fill="#17202c"/><circle cx="37.8" cy="25" r="1.1" fill="#fff"/>',
  glad: '<path d="M35 25q4-5 8 0" fill="none" stroke="#17202c" stroke-width="2.2" stroke-linecap="round"/>',
  worried: '<circle cx="39" cy="25" r="3" fill="#17202c"/><path d="M34 18l9 3" stroke="#17202c" stroke-width="2" stroke-linecap="round"/>',
}

const macawBody = (mood: AdaState['mood']) =>
  `<path d="M14 62c0-22 6-34 14-40C32 8 44 4 52 12c6 6 5 16-1 22-4 4-5 9-5 14v14z" fill="${SCARLET}"/>`
  + '<path d="M14 62c0-12 3-22 8-29 3 9 9 14 17 15v14z" fill="#f2c230"/>'
  + '<path d="M14 62c0-8 2-14 5-19 3 6 7 9 12 10v9z" fill="#2a63c9"/>'
  + '<ellipse cx="40" cy="25" rx="10" ry="9.5" fill="#fbf6ee"/>'
  + MOOD_EYE[mood]
  + '<path d="M49 22c8-1 12 5 10 13-1 5-5 8-9 8 3-4 3-8 0-11-2-2-3-6-1-10z" fill="#2b2f36"/>'
  + '<path d="M50 33c2 3 2 6 0 10-3 0-5-2-6-5z" fill="#3d434d"/>'

/** Ada, a scarlet macaw, with the eye her mood gives her. */
export function macaw(mood: AdaState['mood']) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56"><title>Ada</title>${macawBody(mood)}</svg>`
}

/** The 46 px header ring, filled to a percentage, with Ada or a number inside. */
export function ring(percent: number | null, inside: { mood: AdaState['mood'] } | { text: string }) {
  const c = 2 * Math.PI * 20
  const filled = percent === null ? 0 : (Math.min(100, Math.max(0, percent)) / 100) * c
  const arc = filled > 0
    ? `<circle cx="23" cy="23" r="20" fill="none" stroke="${SCARLET}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 23 23)"/>`
    : ''
  const middle = 'mood' in inside
    ? `<g transform="translate(8 8) scale(0.47)">${macawBody(inside.mood)}</g>`
    : `<text x="23" y="28" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="15" font-weight="700" fill="${SCARLET}">${inside.text.replace(/[^0-9A-Za-z–]/g, '').slice(0, 4)}</text>`
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46" width="46" height="46">'
    + `<circle cx="23" cy="23" r="20" fill="none" stroke="${UNFILLED}" stroke-opacity="0.5" stroke-width="4"/>${arc}${middle}</svg>`
}

/** The last tool calls as thin bars, newest right: height by duration, colour by result. */
export function strip(calls: ToolBar[]) {
  const shown = calls.slice(-STRIP_CALLS)
  const heights = barHeights(shown.map(c => c.ms), 28)
  const offset = STRIP_CALLS - shown.length
  const bars = shown.map((call, i) => {
    const h = heights[i] ?? 3
    return `<rect x="${(offset + i) * 6}" y="${28 - h}" width="4" height="${h}" rx="1" fill="${call.ok ? OK_FILL : FAILED_FILL}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 238 28" width="238" height="28"><title>The last ${shown.length} tool calls</title>${bars}</svg>`
}

/** The last 35 days as a grid of weeks, a filled square for a day with practice. */
export function dayGrid(days: boolean[]) {
  const cells = days.slice(-35)
  const squares = cells.map((practised, i) =>
    `<rect x="${(i % 7) * 13}" y="${Math.floor(i / 7) * 13}" width="10" height="10" rx="2.5" fill="${practised ? OK_FILL : UNFILLED}" fill-opacity="${practised ? 1 : 0.5}"/>`).join('')
  const rows = Math.max(1, Math.ceil(cells.length / 7))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 ${rows * 13 - 3}" width="88" height="${rows * 13 - 3}"><title>Practice in the last ${cells.length} days</title>${squares}</svg>`
}

// ---- Background readings ----

async function refreshGit($: EngineInterface) {
  if (gitBusy) return
  try {
    const now = await $.clock.now()
    if (tooSoon(now, gitAt, GIT_EVERY_MS)) {
      // One reading at the end of the wait, so a burst of edits still lands.
      // A wait long past its time was dropped (a reload, a stopped clock): set it again.
      if (!gitLater || now - gitLaterAt > 1000 || gitLaterAt - now > GIT_EVERY_MS) {
        const wait = GIT_EVERY_MS - (now - gitAt)
        gitLaterAt = now + wait
        try { gitLater = $.clock.after(wait, () => { gitLater = null; void refreshGit($) }) } catch { gitLater = null }
      }
      return
    }
    gitAt = now
    gitBusy = true
    const repo = await $.session.repo()
    let git: GitStatus | null = null
    if (repo) {
      // The session's own directory: in a worktree, repo.root is the main checkout.
      const result = await $.process.run(GIT_ARGS, { timeoutMs: GIT_TIMEOUT_MS })
      if (result.exitCode === 0 && !result.isStdoutTruncated) git = parseGitStatus(result.stdout)
    }
    await change($, s => ({ ...s, git }))
  } catch {
    await change($, s => ({ ...s, git: null }))
  } finally { gitBusy = false }
}

async function refreshPr($: EngineInterface) {
  if (prBusy) return
  try {
    const state = await read($, pane)
    if (state.view !== 'repo') return
    const shown = await safely(() => $.ui.panes())
    if (!shown?.some(p => p.id === 'ada' && p.isShown)) return
    const now = await $.clock.now()
    if (tooSoon(now, prAt, PR_EVERY_MS)) return
    const repo = await $.session.repo()
    const gh = githubRepo(repo?.remote)
    if (!repo || !gh) { await change($, s => ({ ...s, pr: { kind: 'hidden' } })); return }
    prAt = now
    prBusy = true
    let pr: PrReading
    try { pr = readPullRequest(await $.process.run(PR_ARGS, { timeoutMs: PR_TIMEOUT_MS }), gh) } catch (err) { pr = readPullRequestFailure(err) }
    await change($, s => ({ ...s, pr }))
  } catch { /* The section stays as it was. */ } finally { prBusy = false }
}

function startTicker($: EngineInterface) {
  stopTicker()
  try { ticker = $.clock.every(1000, () => { void change($, s => (s.turnStartedAt ? { ...s, tick: s.tick + 1 } : s)) }) } catch { ticker = null }
}

function stopTicker() {
  try { ticker?.cancel() } catch { /* Already stopped. */ }
  ticker = null
}

async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}

const VIEWS: { id: AdaView; label: string }[] = [
  { id: 'session', label: 'Session' }, { id: 'repo', label: 'Repo' }, { id: 'you', label: 'You' },
]

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const plural = (n: number, one: string, many: string) => `${grouped(n)} ${n === 1 ? one : many}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try { await $.command.register({ name: 'ada', description: 'Open Ada’s session pane' }) } catch {}
    try { void $.ui.open({ id: 'ada', title: 'Ada' }).catch(() => {}) } catch {}
    // A reload mid-turn keeps the running time moving.
    if ((await safely(() => read($, pane)))?.turnStartedAt) startTicker($)
    void recall($).then(async () => {
      await refreshGit($)
      await refreshPr($)
      await refresh($)
    })
    return result
  })
  on('command.run', { command: 'ada' }, async ($) => {
    void refresh($, true)
    try {
      const opened = await $.ui.open({ id: 'ada', title: 'Ada' })
      return { text: opened.isPlaced ? 'Ada’s pane is open.' : `Ada’s pane is waiting for a place to draw: ${opened.reason}` }
    } catch (err) {
      return { text: `Ada’s pane could not open: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await record($, { kind: 'prompt' })
    return result
  })
  // A turn, not a prompt: a command that answers itself or a dropped prompt starts none.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const now = await safely(() => $.clock.now()) ?? 0
    await change($, s => ({ ...s, turnStartedAt: now || 1, turnCalls: 0, tick: 0, reaction: 'Let’s see what we can do.', mood: 'busy' }))
    startTicker($)
    return result
  })
  on('tool.call', async ($, e, next) => {
    const started = await safely(() => $.clock.now()) ?? 0
    await change($, s => ({ ...s, running: s.running + 1, lastTool: e.tool, lastToolAt: started, lastStatus: 'running', reaction: 'On it.', mood: 'busy' }))
    const result = await next(e)
    const ended = await safely(() => $.clock.now()) ?? started
    const error = result.deny !== undefined || result.isError === true
    const runner = e.tool === 'Bash' && e.run_in_background !== true ? testRunner(e.command) : null
    const writesFiles = FILE_WRITERS.has(e.tool)
    const bar: ToolBar = { tool: e.tool, ms: Math.max(0, ended - started), ok: !error }
    // An errored call carries only its error text, so an interruption is known by its words.
    const interrupted = result.isError === true
      && /interrupted by (?:the )?user/i.test(`${result.text ?? ''} ${typeof result.result === 'string' ? result.result : ''}`)
    const tests: TestRun | null = runner && result.deny === undefined && !interrupted ? { runner, ok: !error, at: ended } : null
    await change($, s => ({
      ...s,
      running: Math.max(0, s.running - 1), lastTool: e.tool, lastToolAt: ended, lastStatus: error ? 'error' : 'ok',
      calls: pushCall(s.calls, bar), callCount: s.callCount + 1, failedCount: s.failedCount + (error ? 1 : 0),
      slowest: !s.slowest || bar.ms > s.slowest.ms ? bar : s.slowest,
      turnCalls: s.turnCalls + 1,
      tests: tests ?? s.tests,
      editedSinceTests: tests ? false : s.editedSinceTests || (writesFiles && !error && s.tests !== null),
      reaction: tests ? (error ? 'Tests failed; worth a look.' : 'Tests passed. Nice.') : error ? 'That one failed; worth a look.' : 'Done. What’s next?',
      mood: error ? 'worried' : tests ? 'glad' : 'idle',
    }))
    await record($, { kind: 'tool', tool: e.tool, status: error ? 'error' : 'ok' })
    if (writesFiles) void refreshGit($)
    return result
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    stopTicker()
    await change($, s => ({
      ...s,
      turnStartedAt: 0, tick: 0, running: 0,
      lastTurn: { ms: Math.max(0, e.durationMs), calls: s.turnCalls },
      ...(e.isAborted ? { reaction: 'Stopped. Over to you.', mood: 'idle' as const }
        : s.mood === 'busy' ? { reaction: 'Done. What’s next?', mood: 'idle' as const } : {}),
    }))
    void refreshGit($).then(() => refreshPr($)).then(() => refresh($))
    return result
  })
  on('ui.render', { component: 'Pane', requestId: 'ada' }, async ($, e) => {
    const { Box, Text, Button, Link, Progress } = $.ui.resolve(e)
    const state = await read($, pane)
    const now = await safely(() => $.clock.now()) ?? 0
    const usage = await safely(() => $.session.usage())
    const repo = await safely(() => $.session.repo())
    const gh = githubRepo(repo?.remote)
    const terminal = e.surface === 'terminal'
    const picture = (source: string, alt: string) => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={source} alt={alt} />
    }
    const view: AdaView = state.view === 'repo' && !repo ? 'session' : state.view
    const show = (next: AdaView) => () => {
      void change($, s => ({ ...s, view: next })).then(async () => {
        try { await $.store.set('view', next) } catch { /* The next session opens on Session. */ }
        if (next === 'repo') await refreshPr($)
      })
    }
    const fill = (text: string) => () => { void $.prompt.fill({ text, mode: 'insert' }) }
    const section = (caption: string, children: RenderChildren) => (
      <Box flexDirection="column">
        <Text size="caption" dimColor>{caption}</Text>
        {children}
      </Box>
    )
    const tile = (caption: string, value: string, line: string, color?: string) => (
      <Box flexDirection="column" flexGrow={1}>
        <Text size="caption" dimColor>{caption}</Text>
        <Text size="title" mono tabular color={color}>{value}</Text>
        <Text size="caption" dimColor>{line}</Text>
      </Box>
    )
    const chip = (label: string, color: string) => <Text size="caption" color={color}>● {label}</Text>

    const context = contextPercent(usage)
    const stats = state.stats
    const span = stats ? levelSpan(stats.level, stats.xp) : null
    const statsLine = state.refreshing
      ? (stats ? `Asking hrn again; read ${age(now, state.statsAt)}` : 'Reading your stats')
      : state.statsNote || (stats ? `Read ${age(now, state.statsAt)}` : 'Reading your stats')
    const pr = state.pr.kind === 'found' ? state.pr.pr : null
    const checks = pr ? {
      passed: pr.checks.filter(c => c === 'passed').length,
      failed: pr.checks.filter(c => c === 'failed').length,
      running: pr.checks.filter(c => c === 'running').length,
    } : null

    // ---- Header ----
    let ringPercent: number | null = null
    let ringSource = ''
    let ringAlt = ''
    let title = ''
    let under = ''
    let right: RenderChildren = null
    if (view === 'session') {
      ringPercent = context
      ringSource = ring(context, { mood: state.mood })
      ringAlt = `Ada, context ${context === null ? 'not known yet' : percentText(context)}`
      title = clip(state.reaction, 40)
      under = state.lastTool ? `${state.lastTool}, ${state.lastStatus === 'running' ? 'running' : age(now, state.lastToolAt)}` : 'No tool calls yet'
      right = state.lastStatus === 'error' ? chip('Failed', 'error')
        : state.turnStartedAt || state.running ? chip('Working', 'warning')
          : state.lastTurn || state.callCount ? chip('Done', 'success') : null
    } else if (view === 'repo') {
      ringSource = ring(null, { mood: state.mood })
      ringAlt = 'Ada'
      title = clip(gh ? gh.name : repo?.name ?? (repo?.root.split(/[\\/]/).filter(Boolean).pop() || 'This repository'), 40)
      under = state.git ? state.git.head : ''
      right = !checks || pr?.checks.length === 0 ? null
        : checks.failed ? chip('CI failing', 'error')
          : checks.running ? chip('CI running', 'warning') : chip('CI passing', 'success')
    } else {
      ringPercent = span ? span.percent : null
      ringSource = ring(ringPercent, { text: stats ? String(stats.level) : '–' })
      ringAlt = stats && span ? `Level ${stats.level}, ${span.percent}% of the way to the next` : 'Level not known yet'
      title = stats ? `Level ${stats.level}` : 'Your progress'
      under = stats && span ? `${grouped(stats.xp)} XP, ${grouped(span.toGo)} to level ${stats.level + 1}` : ''
      right = (
        <Box flexDirection="column" alignItems="flex-end">
          <Text size="caption" dimColor>{state.refreshing ? 'Asking…' : stats ? age(now, state.statsAt) : ''}</Text>
          <Button key="refresh" label="Refresh" plain dimColor={state.refreshing} onPress={() => { void refresh($, true) }} />
        </Box>
      )
    }
    const header = (
      <Box flexDirection="row" gap={1} alignItems="center">
        {terminal
          ? <Text color="claude" mono tabular>{ringPercent === null ? '–' : percentText(ringPercent)}</Text>
          : picture(ringSource, ringAlt)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text weight="bold" wrap="truncate-end">{title}</Text>
          {under ? <Text size="caption" dimColor wrap="truncate-end">{under}</Text> : null}
        </Box>
        {right}
      </Box>
    )

    const switcher = (
      <Box flexDirection="row" gap={1}>
        {VIEWS.filter(v => v.id !== 'repo' || repo).map(v => (
          <Button key={`view-${v.id}`} label={v.label} variant={view === v.id ? 'primary' : 'secondary'} onPress={show(v.id)} />
        ))}
      </Box>
    )

    // ---- Session ----
    const sessionView = () => {
      const plan = planFigure(usage, now)
      const planColor = plan.percent === null ? undefined : plan.percent >= 85 ? 'error' : plan.percent >= 70 ? 'warning' : undefined
      const contextColor = context === null ? undefined : context >= 85 ? 'error' : context >= 70 ? 'warning' : undefined
      const contextLine = usage?.context && typeof usage.context.tokens === 'number'
        ? `${tokenCount(usage.context.tokens)} of ${tokenCount(usage.context.window)}` : 'not known yet'
      const turn = state.turnStartedAt
        ? tile('This turn', stopwatch(now - state.turnStartedAt), `running, ${plural(state.turnCalls, 'tool call', 'tool calls')}`, 'warning')
        : state.lastTurn
          ? tile('Last turn', stopwatch(state.lastTurn.ms), plural(state.lastTurn.calls, 'tool call', 'tool calls'))
          : tile('Last turn', '–', 'none yet')
      const tests = state.tests
      const tree = [
        state.git && state.git.head,
        state.git && (state.git.changed ? plural(state.git.changed, 'file changed', 'files changed') : 'no changes'),
      ].filter((p): p is string => !!p)
      const action = chooseAction(state, context)
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2}>
            {tile('Context', context === null ? '–' : percentText(context), contextLine, contextColor)}
            {tile(plan.caption, plan.value, plan.line, planColor)}
            {turn}
          </Box>
          {section('Tool calls', state.calls.length === 0 ? <Text dimColor>No tool calls yet</Text> : (
            <Box flexDirection="column">
              {terminal
                ? <Text>{blockRuns(state.calls).map(run => <Text color={run.failed ? 'error' : 'success'}>{run.text}</Text>)}</Text>
                : picture(strip(state.calls), `The last ${state.calls.length} tool calls, ${state.calls.filter(c => !c.ok).length} failed`)}
              <Text size="caption" dimColor>
                {plural(state.callCount, 'call', 'calls')}{state.failedCount ? `, ${grouped(state.failedCount)} failed` : ''}.
                {state.slowest ? ` Slowest: ${state.slowest.tool}, ${duration(state.slowest.ms)}` : ''}
              </Text>
            </Box>
          ))}
          {(tree.length > 0 || tests) && (
            <Text size="caption">
              {tree.join(', ')}{tree.length && tests ? ', ' : ''}
              {tests && <Text color={tests.ok ? 'success' : 'error'}>tests {tests.ok ? 'passed' : 'failed'} {age(now, tests.at)}</Text>}
              {tests && state.editedSinceTests && <Text color="warning">, edited since</Text>}
            </Text>
          )}
          {action && <Button key={action.key} label={action.label} variant="primary" onPress={fill(action.text)} />}
          {state.recordingFailed && <Text size="caption" color="warning">Session recording unavailable.</Text>}
        </Box>
      )
    }

    // ---- Repo ----
    const repoView = () => {
      const git = state.git
      const links = gh ? repoLinks(gh) : null
      const branchLine = git ? [
        git.changed ? plural(git.changed, 'file changed', 'files changed') : 'No changes',
        git.ahead === null ? 'no upstream' : `${grouped(git.ahead)} ahead, ${grouped(git.behind ?? 0)} behind`,
      ].join(', ') : ''
      const review = pr ? (pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed'
        : { approved: 'Approved', changes: 'Changes requested', required: 'Review required', none: 'No review yet' }[pr.review]) : ''
      const reviewColor = pr?.state === 'merged' ? 'merged' : pr?.review === 'approved' ? 'success' : pr?.review === 'changes' ? 'error' : undefined
      const prPart = !gh ? null
        : state.pr.kind === 'found' && pr && links ? (
          <Box flexDirection="column">
            <Text><Link href={links.pull(pr.number)}>{clip(`#${pr.number} ${pr.title}`, 60)}</Link></Text>
            <Text size="caption" color={reviewColor}>{review}</Text>
            {checks && pr.checks.length > 0
              ? <Text size="caption">
                  {pr.checks.slice(0, 24).map(c => <Text color={c === 'passed' ? 'success' : c === 'failed' ? 'error' : 'warning'}>●</Text>)}
                  <Text dimColor> {checks.passed} of {pr.checks.length} passed</Text>
                </Text>
              : <Text size="caption" dimColor>No checks</Text>}
            {pr.issues.length > 0 && (
              <Text size="caption">Closes {pr.issues.map((n, i) => <Text>{i ? ', ' : ''}<Link href={links.issue(n)}>{`#${n}`}</Link></Text>)}</Text>
            )}
          </Box>
        )
          : state.pr.kind === 'none' ? <Text dimColor>No pull request yet</Text>
            : state.pr.kind === 'note' ? <Text size="caption" dimColor>{state.pr.note}</Text>
              : state.pr.kind === 'unknown' ? <Text size="caption" dimColor>Asking GitHub…</Text>
                : null
      return (
        <Box flexDirection="column" gap={1}>
          {(git || prPart) && section('This branch', (
            <Box flexDirection="column">
              {git && <Text>{branchLine}</Text>}
              {prPart}
            </Box>
          ))}
          {links && section('Links', (
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              <Link href={links.repository} label="Repository" />
              <Link href={links.pulls} label="Pull requests" />
              <Link href={links.actions} label="Actions" />
            </Box>
          ))}
        </Box>
      )
    }

    // ---- You ----
    const youView = () => {
      if (!stats) return <Text dimColor>{statsLine}</Text>
      const top = Math.max(1, stats.week.delivery, stats.week.practice)
      const practised = stats.days.filter(Boolean).length
      return (
        <Box flexDirection="column" gap={1}>
          {state.statsNote && <Text size="caption" dimColor>{state.statsNote}</Text>}
          {section('This week', (
            <Box flexDirection="column">
              <Progress label="Delivery" value={stats.week.delivery} max={top} valueText={`${grouped(stats.week.delivery)} XP`} color="success" />
              <Progress label="Practice" value={stats.week.practice} max={top} valueText={`${grouped(stats.week.practice)} XP`} color="success" />
            </Box>
          ))}
          {section('Practice', (
            <Box flexDirection="row" gap={2} alignItems="center">
              {terminal
                ? <Box flexDirection="column">{Array.from({ length: Math.ceil(stats.days.length / 7) }, (_, w) => (
                    <Text color="success">{stats.days.slice(w * 7, w * 7 + 7).map(d => (d ? '■' : '·')).join(' ')}</Text>
                  ))}</Box>
                : picture(dayGrid(stats.days), `${practised} of the last ${stats.days.length} days with practice`)}
              <Box flexDirection="column">
                <Text size="title" mono tabular>{stats.streak === null ? '–' : String(stats.streak)}</Text>
                <Text size="caption" dimColor>{stats.streak === 1 ? 'day streak' : 'days streak'}, {practised} of {stats.days.length} days</Text>
              </Box>
            </Box>
          ))}
          {stats.exercise && section('Today’s exercise', (
            <Box flexDirection="column">
              <Text>{stats.exercise.kind} {chip(stats.exercise.answered ? 'Done' : 'Waiting', stats.exercise.answered ? 'success' : 'warning')}</Text>
              {!stats.exercise.answered && (
                <Button key="exercise" label="Open it" variant="primary" onPress={fill('Run `hrn bot practice` and show me today’s exercise.')} />
              )}
            </Box>
          ))}
          {stats.badges.length > 0 && section('Badges', (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {stats.badges.map(badge => <Text size="caption">★ {badge}</Text>)}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {header}
        {switcher}
        {view === 'session' ? sessionView() : view === 'repo' ? repoView() : youView()}
      </Box>
    )
  })
}
