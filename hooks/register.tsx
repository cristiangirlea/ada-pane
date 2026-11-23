import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, RenderChildren, SessionUsage, Timer } from 'claude-code'
import type { AdaState, AdaView, CheckState, ContextPart, Delivery, GitStatus, HrnRun, PrReading, PullRequest, Stats, Step, TestRun, Tokens, ToolBar } from '../types'

const NO_TOKENS: Tokens = { fresh: 0, cached: 0, written: 0, out: 0 }

const initial: AdaState = {
  stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'session',
  reaction: 'Ready when you are.', mood: 'idle', recordingFailed: false,
  lastTool: '', lastToolAt: 0, lastStatus: '', running: 0,
  calls: [], callCount: 0, failedCount: 0, slowest: null,
  turnStartedAt: 0, turnCalls: 0, tick: 0, lastTurn: null, loopCalls: 0, loopTool: '', loopRunning: 0,
  stage: 'idle', model: '', effort: '', steps: [], stepCount: 0,
  turnTokens: NO_TOKENS, sessionTokens: NO_TOKENS, helperTokens: NO_TOKENS, helpersStarted: 0,
  toolCounts: [], handoffs: { sent: 0, running: 0, back: 0, failed: 0, backends: [] }, contextParts: null,
  tests: null, editedSinceTests: false, git: null, pr: { kind: 'unknown' }, delivery: null, runs: null,
}

// The tag declines what a version with other fields stored.
const pane = atom({ plugin: 'ada-pane', key: 'pane' } as const, initial, { shape: 'ada-5' })

// hrn reads every run record: a first answer has taken over a minute.
const STATS_ARGS = ['hrn', 'bot', 'stats', '--json'] as const
const STATS_TIMEOUT_MS = 180000
const STATS_EVERY_MS = 600000
// Per repository hrn skips its slow walk and answers in well under a second; the spec gives it gh's limit.
const REPO_STATS_TIMEOUT_MS = 8000
const RUNS_TIMEOUT_MS = 8000
const RUNS_LIVE_EVERY_MS = 30000
// A run with no result this long after it started has stopped without one.
const STALE_RUN_MS = 6 * 3600000
// How long to remember that the installed hrn refused a newer flag before asking again.
const FLAG_RETRY_MS = 3600000
// The text form folds new runs into the ledger the JSON form reads; it can take a minute.
const REBUILD_EVERY_MS = 15 * 60000
const REBUILD_TIMEOUT_MS = 120000
const GIT_TIMEOUT_MS = 3000
const GIT_EVERY_MS = 10000
const PR_TIMEOUT_MS = 8000
const PR_EVERY_MS = 120000
const STRIP_CALLS = 40
const STEPS_KEPT = 8
const TOOLS_KEPT = 24
// The breakdown is estimated locally and sends nothing, but it is still work: once a minute at most.
const CONTEXT_EVERY_MS = 60000

const SCARLET = '#D85A30'
const UNFILLED = '#8a94a3'
const OK_FILL = '#2a9d6a'
const FAILED_FILL = '#d64545'
const FRESH_FILL = '#4a7fd4'
const WRITTEN_FILL = '#d9a23b'
// Mid-tones that hold on light and dark, one per part of the context, largest first.
const PART_FILLS = ['#4a7fd4', '#8b6fd6', '#d9a23b', '#2a9d9d', '#c9577c', '#7d8794']
// A station's fill carries white text on either theme.
const STATION_FILL = { now: '#C24A22', done: '#23805a', idle: '#6b7785' } as const
const HOLLOW_TEXT = '#7d8794'

// No optional locks: a status read must never hold the index lock the agent's own git needs.
const GIT_ARGS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'] as const
const PR_ARGS = ['gh', 'pr', 'view', '--json', 'number,title,state,reviewDecision,statusCheckRollup,closingIssuesReferences'] as const
const FILE_WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

let lastRefresh = -Infinity
let statsBusy = false
let lastRebuild = -Infinity
let rebuilding = false
let writes = Promise.resolve()
let ticker: Timer | null = null
let gitAt = -Infinity
let gitBusy = false
let gitLater: Timer | null = null
let gitLaterAt = 0
let prAt = -Infinity
let prBusy = false
let repoRefusedAt = -Infinity
let runsAt = -Infinity
let runsBusy = false
let runsRefusedAt = -Infinity
let runsLater: Timer | null = null
let contextAt = -Infinity
let contextBusy = false
// Loops the engine lists as helpers; its own forks (a compaction, a memory pass) carry ids it never lists.
const helperIds = new Set<string>()
let watchAt = -Infinity
let watchBusy = false
// Set from the plugin's options at register; null when the option names no loopback address.
let watchUrl: string | null = 'http://127.0.0.1:8089/'
const WATCH_TIMEOUT_MS = 2000

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

async function refresh($: EngineInterface, force = false, every = STATS_EVERY_MS) {
  try {
    const now = await $.clock.now()
    const state = await read($, pane)
    if (statsBusy || state.refreshing || (!force && tooSoon(now, lastRefresh, every))) return
    statsBusy = true
    lastRefresh = now
    await change($, s => ({ ...s, refreshing: true }))
    const gh = githubRepo((await safely(() => $.session.repo()))?.remote)
    const name = gh ? `${gh.owner}/${gh.name}` : ''
    let found: { stats: Stats | null; note: string } = { stats: null, note: 'hrn did not answer' }
    let delivery: Delivery | null = null
    let asked = false
    try {
      let result: ProcessRunResult | null = null
      if (name && !tooSoon(now, repoRefusedAt, FLAG_RETRY_MS)) {
        // An hrn older than --repo refuses it, and one that runs out of time cannot give it: ask the old way,
        // and not per repository again for a while.
        try {
          result = await $.process.run([...STATS_ARGS, '--repo', name], { timeoutMs: REPO_STATS_TIMEOUT_MS })
        } catch { result = null }
        if (!result || (result.exitCode !== 0 && /unexpected argument|--repo/.test(result.stderr))) {
          repoRefusedAt = now
          result = null
        } else asked = true
      }
      result ??= await $.process.run(STATS_ARGS, { timeoutMs: STATS_TIMEOUT_MS })
      if (result.exitCode === 0 && !result.isStdoutTruncated) {
        found = parseStats(result.stdout)
        if (asked) delivery = parseDelivery(result.stdout, name)
      }
    } catch { found = { stats: null, note: 'hrn is not installed, or did not answer in time' } }
    const at = await $.clock.now()
    if (found.stats) {
      const stats = found.stats
      try { await $.store.set('stats', { at, stats, delivery }) } catch { /* The next session reads hrn again. */ }
      await change($, s => ({ ...s, stats, statsAt: at, statsNote: '', refreshing: false, delivery }))
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
    if (view === 'session' || view === 'agent' || view === 'repo' || view === 'you') await change($, s => ({ ...s, view }))
  } catch { /* Session is the default. */ }
  try {
    const kept = await $.store.get('stats') as { at?: unknown; stats?: unknown; delivery?: unknown } | null | undefined
    if (!kept || typeof kept.at !== 'number' || !kept.stats) return
    const { stats } = parseStats(JSON.stringify(toWire(kept.stats as Stats)))
    const gh = githubRepo((await safely(() => $.session.repo()))?.remote)
    let keptDelivery: Delivery | null = null
    // A delivery from an earlier week would show last week's figures as this week's.
    if (gh && kept.delivery && kept.at >= weekStart(await $.clock.now())) {
      try { keptDelivery = parseDelivery(JSON.stringify(deliveryWire(kept.delivery as Delivery)), `${gh.owner}/${gh.name}`) } catch { keptDelivery = null }
    }
    if (stats) await change($, s => (s.stats ? s : { ...s, stats, statsAt: kept.at as number, delivery: keptDelivery }))
  } catch { /* Nothing kept. */ }
}

/** A kept delivery in the shape hrn prints, so it is read back through the same checks. */
const deliveryWire = (d: Delivery) => ({
  week: { delivery: d.total },
  repo: { name: d.name, week: d.week, days: d.days, kinds: Object.fromEntries(d.kinds.map(k => [k.kind, k.count])), share: d.share },
  top: d.top,
})

/** This repository's delivery from `hrn bot stats --json --repo`; null when the answer is not one for it. */
export function parseDelivery(text: string, name: string): Delivery | null {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) } catch { return null }
  const repo = raw && typeof raw === 'object' ? raw.repo as Record<string, unknown> | undefined : undefined
  if (!repo || typeof repo !== 'object' || typeof repo.name !== 'string' || repo.name.toLowerCase() !== name.toLowerCase()) return null
  if (!Array.isArray(repo.days) || repo.days.length !== 35 || !Array.isArray(raw.top)) return null
  const share = typeof repo.share === 'number' && Number.isFinite(repo.share) ? Math.min(1, Math.max(0, repo.share)) : 0
  const kinds = Object.entries(repo.kinds && typeof repo.kinds === 'object' ? repo.kinds as Record<string, unknown> : {})
    .filter((k): k is [string, number] => /^[a-z_]{1,40}$/.test(k[0]) && typeof k[1] === 'number' && k[1] > 0)
    .map(([kind, count]) => ({ kind, count: whole(count) }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1))
    .slice(0, 3)
  const top = raw.top
    .map(t => (t && typeof t === 'object' ? t : {}) as Record<string, unknown>)
    .filter(t => typeof t.repo === 'string' && isOwnerName(t.repo) && typeof t.week === 'number')
    .slice(0, 5)
    .map(t => ({ repo: t.repo as string, week: whole(t.week) }))
  const week = (raw.week ?? {}) as Record<string, unknown>
  return {
    name, week: whole(repo.week), total: whole(week.delivery), days: repo.days.map(whole), kinds, share, top,
  }
}

/** One repository's runs from `hrn runs --json --repo`; null when the answer is not one. */
export function parseRuns(text: string): HrnRun[] | null {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.runs)) return null
  const word = (v: unknown, fallback: string) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,24}$/.test(v) ? v : fallback)
  return raw.runs.slice(0, 8)
    .map(r => (r && typeof r === 'object' ? r : {}) as Record<string, unknown>)
    .filter(r => typeof r.id === 'string' && typeof r.started === 'string' && Number.isFinite(Date.parse(r.started)))
    .map(r => ({
      id: word(r.id, '?'), backend: word(r.backend, 'unknown'), status: word(r.status, 'unknown'),
      started: Date.parse(r.started as string), ms: whole(r.duration_ms),
    }))
}

/** Monday 00:00 UTC on or before now, where hrn's week starts. */
export function weekStart(now: number) {
  const d = new Date(now)
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return day - ((d.getUTCDay() + 6) % 7) * 86400000
}

/** The watch's page for a `host:port` on this computer; null for any other host, so the pane never reaches out. */
export function watchPage(address: unknown): string | null {
  if (typeof address !== 'string') return null
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(address.trim())
  const port = m ? Number(m[2]) : 0
  return m && port >= 1 && port <= 65535 ? `http://${m[1]}:${port}/` : null
}

/** Still running: no result yet, and started recently enough not to be a run that stopped without one. */
export const isLive = (run: HrnRun, now: number) => run.status === 'running' && now - run.started < STALE_RUN_MS

const toWire = (s: Stats) => ({
  enabled: true, level: s.level, xp: s.xp, streak: s.streak, week: s.week, days: s.days, badges: s.badges,
  ada: s.ada && { level: s.ada.level, xp_this_week: s.ada.xpThisWeek }, exercise: s.exercise,
})

async function hrnHome($: EngineInterface) {
  const home = await $.env.get('HRN_HOME') || ((await $.env.get('HOME') || await $.env.get('USERPROFILE')) + '/.hrn')
  if (!home || home.startsWith('undefined/')) throw new Error('Home unavailable')
  return home.replace(/[\\/]+$/, '')
}

// Only the text form folds new runs into the ledger; run it now and then so the JSON stays current.
// A stamp in the hrn home keeps it to one rebuild per computer, however many sessions are open.
async function rebuild($: EngineInterface) {
  try {
    const now = await $.clock.now()
    if (rebuilding || tooSoon(now, lastRebuild, REBUILD_EVERY_MS)) return
    const stamp = `${await hrnHome($)}/claude-sessions/.ledger-rebuild`
    let last = NaN
    try { if (await $.fs.exists(stamp)) last = Number(await $.fs.read(stamp)) } catch { /* An unreadable stamp must not stop rebuilds. */ }
    if (Number.isFinite(last) && last <= now && now - last < REBUILD_EVERY_MS) { lastRebuild = last; return }
    rebuilding = true
    lastRebuild = now
    try { await $.fs.write(stamp, String(now)) } catch { /* Without a stamp this session still rebuilds on its own schedule. */ }
    try { await $.process.run(['hrn', 'bot', 'stats'], { timeoutMs: REBUILD_TIMEOUT_MS }) } catch { /* The next rebuild tries again. */ }
    rebuilding = false
    void refresh($, true)
  } catch { rebuilding = false }
}

export function record($: EngineInterface, entry: { kind: 'prompt' } | { kind: 'tool'; tool: string; status: 'ok' | 'error' }, limit = 1024 * 1024) {
    writes = writes.then(async () => {
      try {
        const home = await hrnHome($)
        const session = await $.session.id()
        if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error('Invalid session id')
        const base = `${home}/claude-sessions/${session}`
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

/** `owner/name` as GitHub spells it: a name may start with a dot (`.github`) but is never `.` or `..`. */
export function isOwnerName(s: string) {
  const m = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/([A-Za-z0-9_.-]+)$/.exec(s)
  return !!m && m[1] !== '.' && m[1] !== '..'
}

/** `owner/name` of a GitHub remote, in https, scp or ssh spelling; null for any other host. */
export function githubRepo(remote: string | null | undefined): { owner: string; name: string } | null {
  if (typeof remote !== 'string') return null
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  const [, owner = '', name = ''] = m ?? []
  return isOwnerName(`${owner}/${name}`) ? { owner, name } : null
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
  const rest = program(command)
  for (const [pattern, name] of RUNNERS) if (pattern.test(rest)) return name
  return null
}

/** A command from the program it starts, past a leading `cd … &&` and variable settings. */
const program = (command: string) => command.trim()
  .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')
  .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')

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

// ---- The agent's loop ----

/** A tool's name as the pane prints it: an MCP tool by its own name, without its server. */
export function shortTool(name: string) {
  const own = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
  return own.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24) || 'tool'
}

/** How a response ended, in the pane's words. */
export function stopWord(reason: string | null | undefined): Step['stop'] {
  if (reason === 'tool_use') return 'tools'
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'answer'
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'cut'
  if (reason === 'refusal') return 'refused'
  if (reason === 'pause_turn' || reason === 'compaction') return 'paused'
  return 'none'
}

/** The tools one response asked for, most asked first: names and counts, never arguments. */
export function askedFor(uses: readonly { name?: unknown }[] | null | undefined) {
  const counts = new Map<string, number>()
  for (const use of uses ?? []) {
    const tool = shortTool(typeof use?.name === 'string' ? use.name : '')
    counts.set(tool, (counts.get(tool) ?? 0) + 1)
  }
  return [...counts].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count).slice(0, 4)
}

/** `asked for Read ×3, Grep`, `answered`. */
export function stepLine(step: Step) {
  if (step.tools.length) return `asked for ${step.tools.map(t => (t.count > 1 ? `${t.tool} ×${t.count}` : t.tool)).join(', ')}`
  return { tools: 'asked for tools', answer: 'answered', cut: 'ran out of room', refused: 'refused', paused: 'paused', none: 'no response' }[step.stop]
}

type ApiUsage = Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number>>

/** A running total with one response's counts added. */
export function addTokens(sum: Tokens, usage: ApiUsage | null | undefined): Tokens {
  if (!usage) return sum
  return {
    fresh: sum.fresh + whole(usage.input_tokens), cached: sum.cached + whole(usage.cache_read_input_tokens),
    written: sum.written + whole(usage.cache_creation_input_tokens), out: sum.out + whole(usage.output_tokens),
  }
}

/** The share of what the model read that the cache served, 0 to 100; null when it read nothing. */
export function cacheShare(t: Tokens) {
  const read = t.fresh + t.cached + t.written
  return read > 0 ? Math.round((t.cached / read) * 100) : null
}

/** The calls per tool with one more counted, most called first. */
export function countTool(counts: { tool: string; count: number }[], tool: string) {
  const name = shortTool(tool)
  const next = counts.some(c => c.tool === name)
    ? counts.map(c => (c.tool === name ? { ...c, count: c.count + 1 } : c))
    : [...counts, { tool: name, count: 1 }]
  return next.sort((a, b) => b.count - a.count).slice(0, TOOLS_KEPT)
}

/** `Bash 21, Read 12, Edit 9, Grep 4`: the tools called most. */
export const toolMix = (counts: { tool: string; count: number }[], most = 4) =>
  counts.slice(0, most).map(c => `${c.tool} ${grouped(c.count)}`).join(', ')

const HRN_TOOL = /^mcp__hrn__(run|batch|flow|remote_submit)$/

/**
 * A call that hands a task to hrn, with the backend it names ('' for none) and whether the call waits for the
 * task to end; null for any other call.
 */
export function handoff(tool: string, input: Record<string, unknown>): { backend: string; waits: boolean } | null {
  const backend = (v: unknown) => (typeof v === 'string' && /^[a-z][a-z0-9_-]{0,15}$/.test(v) ? v : '')
  const viaTool = HRN_TOOL.exec(tool)
  // A submitted job is queued and answered at once; its end is asked for with another tool.
  if (viaTool) return { backend: backend(input.backend), waits: viaTool[1] !== 'remote_submit' }
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof input.command !== 'string') return null
  const m = /^hrn(?:\.exe)?\s+(?:run|batch|flow)\b([\s\S]*)$/.exec(program(input.command))
  if (!m) return null
  // Only the flags before the task: its text, in quotes or after another command, is never read.
  const flags = (m[1] ?? '').split(/["'`]|&&|\|\||[;|\n]/)[0] ?? ''
  return { backend: backend(/(?:^|\s)(?:-b|--backend)[\s=]+(\S+)/.exec(flags)?.[1]), waits: input.run_in_background !== true }
}

/** The context window by category: what fills it, largest first, then the compaction reserve and the room left. */
export function parseContextParts(breakdown: unknown): ContextPart[] | null {
  const rows = breakdown && typeof breakdown === 'object' ? (breakdown as { categories?: unknown }).categories : null
  if (!Array.isArray(rows)) return null
  const parts = rows
    .map(r => (r && typeof r === 'object' ? r : {}) as Record<string, unknown>)
    .filter(r => (r.kind === 'used' || r.kind === 'free' || r.kind === 'buffer') && typeof r.name === 'string' && typeof r.tokens === 'number' && r.tokens > 0)
    .map(r => ({
      name: (r.name as string).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28),
      tokens: whole(r.tokens), kind: r.kind as ContextPart['kind'],
    }))
  if (parts.length === 0) return null
  const used = parts.filter(part => part.kind === 'used').sort((a, b) => b.tokens - a.tokens)
  const rest = used.slice(5).reduce((n, part) => n + part.tokens, 0)
  return [
    ...used.slice(0, 5), ...(rest ? [{ name: 'Other', tokens: rest, kind: 'used' as const }] : []),
    ...parts.filter(part => part.kind === 'buffer'), ...parts.filter(part => part.kind === 'free'),
  ]
}

/** What the loop is doing now, in one sentence. */
export function stageLine(s: Pick<AdaState, 'stage' | 'stepCount' | 'turnStartedAt' | 'loopTool' | 'loopRunning' | 'lastTurn' | 'loopCalls'>) {
  if (s.turnStartedAt) {
    if (s.stage === 'tools') {
      return `Running ${shortTool(s.loopTool)}${s.loopRunning > 1 ? ` and ${grouped(s.loopRunning - 1)} more` : ''}; the results go back to the model.`
    }
    const request = `Request ${grouped(Math.max(1, s.stepCount))}`
    return s.loopCalls ? `${request}: the model reads the results and decides what to do next.` : `${request}: the model reads the conversation and decides what to do.`
  }
  if (s.lastTurn) {
    const size = `${plural(s.lastTurn.steps, 'request', 'requests')} and ${plural(s.lastTurn.loopCalls, 'tool call', 'tool calls')}`
    return s.lastTurn.stopped ? `The last turn was stopped after ${size}.` : `The last turn took ${size}.`
  }
  return 'Waiting for a prompt.'
}

const modelName = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._:@[\]/-]{1,60}$/.test(v) ? v.slice(0, 40) : '')
const effortWord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^[a-z]{1,8}$/.test(v) ? v : '')

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
  // A dashed line marks the 40 places, so a few bars read as the end of a track and not as adrift.
  const track = `<line x1="0" y1="27" x2="238" y2="27" stroke="${UNFILLED}" stroke-opacity="0.5" stroke-width="2" stroke-dasharray="4 2"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 238 28" width="238" height="28"><title>The last ${shown.length} tool calls</title>${track}${bars}</svg>`
}

export type Share = { value: number; fill: string; faint?: boolean }

/** Where each part of a whole starts and ends on a line of the given length. */
function spans(parts: Share[], length: number) {
  const total = parts.reduce((n, part) => n + Math.max(0, part.value), 0)
  let sum = 0
  return total <= 0 ? [] : parts.map(part => {
    const from = Math.round((sum / total) * length)
    sum += Math.max(0, part.value)
    return { part, from, to: Math.round((sum / total) * length) }
  }).filter(span => span.to > span.from)
}

/** One bar split by share. */
export function stack(parts: Share[], title: string) {
  const rects = spans(parts, 320).map(({ part, from, to }) =>
    `<rect x="${from}" y="0" width="${Math.max(1, to - from - 1)}" height="10" rx="2" fill="${part.fill}"${part.faint ? ' fill-opacity="0.5"' : ''}/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 10" width="320" height="10"><title>${title.replace(/[<>&]/g, '')}</title>${rects}</svg>`
}

/** The same bar as block characters, one run per part. */
export function stackRuns(parts: Share[], cells = 30) {
  return spans(parts, cells).map(({ part, from, to }) => ({ text: (part.faint ? '░' : '█').repeat(to - from), fill: part.fill, faint: !!part.faint }))
}

export type Station = { label: string; line: string; state: 'now' | 'done' | 'idle' }

const stationText = (text: string) => text.replace(/[^0-9A-Za-z :,._–-]/g, '').slice(0, 14)

// A hollow station is one not in use: an outline and grey words, which stay readable on either theme.
const station = (x: number, y: number, s: Station, hollow = false) =>
  (hollow
    ? `<rect x="${x + 0.5}" y="${y + 0.5}" width="67" height="33" rx="8" fill="none" stroke="${UNFILLED}" stroke-dasharray="3 2"/>`
    : `<rect x="${x}" y="${y}" width="68" height="34" rx="8" fill="${STATION_FILL[s.state]}"/>`)
  + `<text x="${x + 34}" y="${y + 14}" text-anchor="middle" font-size="11" font-weight="700" fill="${hollow ? HOLLOW_TEXT : '#fff'}">${stationText(s.label)}</text>`
  + `<text x="${x + 34}" y="${y + 27}" text-anchor="middle" font-size="10" fill="${hollow ? HOLLOW_TEXT : '#fff'}" fill-opacity="0.92">${stationText(s.line)}</text>`

const ARROW_HEADS = { r: 'l-5 -3v6z', l: 'l5 -3v6z', d: 'l-3 -5h6z', u: 'l-3 5h6z' } as const
const arrow = (path: string, x: number, y: number, to: keyof typeof ARROW_HEADS, dashed = false) =>
  `<path d="${path}" fill="none" stroke="${UNFILLED}" stroke-width="1.6"${dashed ? ' stroke-dasharray="3 2"' : ''}/>`
  + `<path d="M${x} ${y}${ARROW_HEADS[to]}" fill="${UNFILLED}"/>`

/**
 * The loop as a picture: you, the model, the tools and the answer in a row, the model and the tools passing
 * work back and forth. With a lane, the road a task takes through hrn hangs under the tools, hollow until one is sent.
 */
export function loopPicture(stations: Station[], lane: Station[] | null) {
  const row = stations.slice(0, 4).map((s, i) => station(i * 84, 0, s)).join('')
    + arrow('M70 17H78', 82, 17, 'r')
    + arrow('M154 11H162', 166, 11, 'r') + arrow('M166 23H158', 154, 23, 'l')
    + arrow('M238 17H246', 250, 17, 'r')
  const unused = !!lane && lane.every(s => s.state === 'idle')
  const under = !lane ? '' : arrow('M190 34V42H34V45', 34, 50, 'd', true) + arrow('M214 50V39', 214, 34, 'u', true)
    + lane.slice(0, 3).map((s, i) => station(i * 84, 50, s, unused)).join('')
    + arrow('M70 67H78', 82, 67, 'r') + arrow('M154 67H162', 166, 67, 'r')
  const height = lane ? 84 : 34
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 ${height}" width="320" height="${height}" font-family="system-ui,-apple-system,Segoe UI,sans-serif">`
    + `<title>How a turn runs</title>${row}${under}</svg>`
}

/** Thirty-five days of delivery in this repository, one bar a day, height by experience. */
export function deliveryStrip(days: number[]) {
  const top = Math.max(1, ...days)
  const bars = days.slice(-35).map((xp, i) => {
    const h = xp > 0 ? Math.max(3, Math.round((xp / top) * 24)) : 2
    return `<rect x="${i * 6}" y="${24 - h}" width="4" height="${h}" rx="1" fill="${xp > 0 ? OK_FILL : UNFILLED}" fill-opacity="${xp > 0 ? 1 : 0.5}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 208 24" width="208" height="24"><title>Delivery in the last 35 days</title>${bars}</svg>`
}

const KIND_WORDS: Record<string, [string, string]> = {
  inside_ceiling: ['run inside its ceiling', 'runs inside their ceiling'],
  review_clean: ['clean review', 'clean reviews'],
  bug_squashed: ['bug squashed', 'bugs squashed'],
  script_reused: ['kept script reused', 'kept scripts reused'],
  routed_passed: ['routed run passed', 'routed runs passed'],
  first_use: ['first use', 'first uses'],
}

/** `41 runs inside their ceiling`; a kind this build does not know reads as its words. */
export function kindLine(kind: string, count: number) {
  const [one, many] = KIND_WORDS[kind] ?? [kind.replace(/_/g, ' '), kind.replace(/_/g, ' ')]
  return `${grouped(count)} ${count === 1 ? one : many}`
}

/** The width and height a drawing's root element declares, so it is drawn at its own size. */
export function svgSize(source: string): [number | undefined, number | undefined] {
  const root = /^<svg\b[^>]*>/.exec(source)?.[0] ?? ''
  const read = (name: string) => {
    const v = Number(new RegExp(`\\s${name}="(\\d+)"`).exec(root)?.[1])
    return Number.isFinite(v) && v > 0 ? v : undefined
  }
  return [read('width'), read('height')]
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
    if (!await onScreen($)) return
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

async function refreshRuns($: EngineInterface) {
  if (runsBusy) return
  try {
    const state = await read($, pane)
    if (state.view !== 'repo') return
    if (!await onScreen($)) return
    const now = await $.clock.now()
    if (tooSoon(now, runsRefusedAt, FLAG_RETRY_MS)) return
    const live = state.runs?.some(run => isLive(run, now)) ?? false
    if (tooSoon(now, runsAt, live ? RUNS_LIVE_EVERY_MS : PR_EVERY_MS)) return
    const gh = githubRepo((await $.session.repo())?.remote)
    if (!gh) { await change($, s => ({ ...s, runs: null })); return }
    runsAt = now
    runsBusy = true
    let runs: HrnRun[] | null = null
    try {
      const result = await $.process.run(['hrn', 'runs', '--json', '--repo', `${gh.owner}/${gh.name}`, '-n', '8'], { timeoutMs: RUNS_TIMEOUT_MS })
      if (result.exitCode === 0 && !result.isStdoutTruncated) runs = parseRuns(result.stdout)
      // An hrn older than --json refuses it: leave the section out for a while.
      else if (/not defined|unknown flag/.test(result.stderr)) runsRefusedAt = now
    } catch { runs = null }
    await change($, s => ({ ...s, runs }))
    // While a run is live the section follows it; once none is, it waits for the next turn or view.
    if (runs?.some(run => isLive(run, now)) && !runsLater) {
      try { runsLater = $.clock.after(RUNS_LIVE_EVERY_MS, () => { runsLater = null; void refreshRuns($) }) } catch { runsLater = null }
    }
  } catch { /* The section stays as it was. */ } finally { runsBusy = false }
}

/** Which address answered as an hrn watch (its page's title ends in `· hrn watch`), or null. */
async function refreshWatch($: EngineInterface) {
  if (watchBusy || !watchUrl) return
  try {
    const state = await read($, pane)
    if (state.view !== 'repo') return
    if (!await onScreen($)) return
    // The link sits among the GitHub links and is drawn on the terminal only: without either, nothing would show it.
    if (!githubRepo((await safely(() => $.session.repo()))?.remote)) return
    if (!(await safely(() => $.session.surfaces()))?.includes('terminal')) return
    const now = await $.clock.now()
    if (tooSoon(now, watchAt, PR_EVERY_MS)) return
    watchAt = now
    watchBusy = true
    const url = watchUrl
    // A server that accepts and never answers must not hold the reading.
    const answer = await Promise.race([
      $.http.fetch(url).then(r => r.status === 200 && /· hrn watch<\/title>/.test(r.text)).catch(() => false),
      $.clock.sleep(WATCH_TIMEOUT_MS).then(() => false),
    ])
    await change($, s => ({ ...s, watch: answer ? url : null }))
  } catch { await change($, s => ({ ...s, watch: null })) } finally { watchBusy = false }
}

/** What the repo view reads, each under its own limits; nothing unless the view is on screen. */
async function refreshRepo($: EngineInterface) {
  await refreshPr($)
  await refreshRuns($)
  await refreshWatch($)
  const state = await safely(() => read($, pane))
  const gh = githubRepo((await safely(() => $.session.repo()))?.remote)
  const now = await safely(() => $.clock.now()) ?? 0
  // Only the quick per-repository answer is worth asking this often; the full one waits for its own time.
  if (gh && !tooSoon(now, repoRefusedAt, FLAG_RETRY_MS) && state?.view === 'repo' && await onScreen($)) {
    await refresh($, false, PR_EVERY_MS)
  }
}

/** What fills the context, by category; asked only while the agent view is on screen. */
async function refreshContext($: EngineInterface) {
  try {
    const state = await read($, pane)
    if (state.view !== 'agent' || !await onScreen($)) return
    const now = await $.clock.now()
    if (contextBusy || tooSoon(now, contextAt, CONTEXT_EVERY_MS)) return
    contextAt = now
    contextBusy = true
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      const parts = parseContextParts(usage.context?.breakdown)
      await change($, s => ({ ...s, contextParts: parts ? { at: now, parts } : null }))
    } finally { contextBusy = false }
  } catch { /* The section stays as it was. */ }
}

/** Whether a loop is a helper the engine lists; one of its own forks is not. */
async function isHelper($: EngineInterface, agentId: string) {
  if (helperIds.has(agentId)) return true
  for (const agent of await safely(() => $.agent.list()) ?? []) helperIds.add(agent.id)
  return helperIds.has(agentId)
}

/** Whether a surface shows the pane now: nothing is asked for a pane nobody sees. */
async function onScreen($: EngineInterface) {
  return (await safely(() => $.ui.panes()))?.some(p => p.id === 'ada' && p.isShown) ?? false
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
  { id: 'session', label: 'Session' }, { id: 'agent', label: 'Agent' }, { id: 'repo', label: 'Repo' }, { id: 'you', label: 'You' },
]

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/** `Explore 4, general-purpose 2`: helpers by type, the three most started. */
export function countKinds(types: string[]) {
  const counts = new Map<string, number>()
  for (const type of types) {
    const name = /^[A-Za-z][A-Za-z0-9:_.-]{0,39}$/.test(type) ? type : 'other'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} ${grouped(count)}`).join(', ')
}
const plural = (n: number, one: string, many: string) => `${grouped(n)} ${n === 1 ? one : many}`

export const register: Register = (on, options) => {
  watchUrl = watchPage(options?.watch_address ?? '127.0.0.1:8089')
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try { await $.command.register({ name: 'ada', description: 'Open Ada’s session pane' }) } catch {}
    try { void $.ui.open({ id: 'ada', title: 'Ada' }).catch(() => {}) } catch {}
    // A reload mid-turn keeps the running time moving.
    if ((await safely(() => read($, pane)))?.turnStartedAt) startTicker($)
    void recall($).then(async () => {
      await refreshGit($)
      await refreshRepo($)
      await refreshContext($)
      await refresh($)
      await rebuild($)
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
    await change($, s => ({
      ...s, turnStartedAt: now || 1, turnCalls: 0, tick: 0, reaction: 'Let’s see what we can do.', mood: 'busy',
      stage: 'model', steps: [], stepCount: 0, turnTokens: NO_TOKENS, loopCalls: 0, loopTool: '', loopRunning: 0,
    }))
    startTicker($)
    return result
  })
  // One model request of a turn. The stream beneath is passed on piece by piece, untouched,
  // and no update is waited for: the request and its result are never held back.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined) {
      void change($, s => ({ ...s, stage: 'model', stepCount: Math.max(s.stepCount, e.index + 1), model: modelName(e.model), effort: effortWord(e.effort) }))
    }
    const result = yield* next(e)
    try {
      const usage = result?.usage ?? null
      const step: Step = { index: e.index, stop: stopWord(result?.stopReason), tools: askedFor(result?.toolUses), out: whole(usage?.output_tokens) }
      if (agentId === undefined) {
        void change($, s => ({
          ...s,
          steps: [...s.steps.filter(kept => kept.index !== step.index), step].slice(-STEPS_KEPT),
          turnTokens: addTokens(s.turnTokens, usage), sessionTokens: addTokens(s.sessionTokens, usage),
        }))
      } else if (usage) {
        void isHelper($, agentId).then(listed => (listed ? change($, s => ({ ...s, helperTokens: addTokens(s.helperTokens, usage) })) : undefined))
      }
    } catch { /* Observation must not affect the session. */ }
    return result
  })
  on('tool.call', async ($, e, next) => {
    const started = await safely(() => $.clock.now()) ?? 0
    const main = e.agentId === undefined
    const input = e as unknown as Record<string, unknown>
    const handed = handoff(e.tool, input)
    // A task sent off without waiting is counted as sent; its end is not seen.
    const waited = handed?.waits === true
    await change($, s => ({
      ...s, running: s.running + 1, lastTool: e.tool, lastToolAt: started, lastStatus: 'running', reaction: 'On it.', mood: 'busy',
      ...(main ? { stage: 'tools' as const, loopTool: e.tool, loopRunning: s.loopRunning + 1 } : {}),
      ...(handed ? {
        handoffs: {
          ...s.handoffs, sent: s.handoffs.sent + 1, running: s.handoffs.running + (waited ? 1 : 0),
          backends: handed.backend && !s.handoffs.backends.includes(handed.backend) ? [...s.handoffs.backends, handed.backend].slice(0, 6) : s.handoffs.backends,
        },
      } : {}),
    }))
    const result = await next(e).catch(async (err: unknown) => {
      // A call that never answers must not stay counted as running.
      await change($, s => ({
        ...s, running: Math.max(0, s.running - 1), loopRunning: Math.max(0, s.loopRunning - (main ? 1 : 0)),
        ...(waited ? { handoffs: { ...s.handoffs, running: Math.max(0, s.handoffs.running - 1), failed: s.handoffs.failed + 1 } } : {}),
      }))
      throw err
    })
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
      ...(main ? { loopCalls: s.loopCalls + 1, loopRunning: Math.max(0, s.loopRunning - 1) } : {}),
      toolCounts: countTool(s.toolCounts, e.tool),
      helpersStarted: s.helpersStarted + (e.tool === 'Agent' && !error ? 1 : 0),
      // A call that was refused handed nothing over; one that returned says nothing of its checks.
      ...(handed && result.deny !== undefined ? {
        handoffs: { ...s.handoffs, sent: Math.max(0, s.handoffs.sent - 1), running: Math.max(0, s.handoffs.running - (waited ? 1 : 0)) },
      } : waited ? {
        handoffs: {
          ...s.handoffs, running: Math.max(0, s.handoffs.running - 1),
          back: s.handoffs.back + (error ? 0 : 1), failed: s.handoffs.failed + (error ? 1 : 0),
        },
      } : {}),
      tests: tests ?? s.tests,
      editedSinceTests: tests ? false : s.editedSinceTests || (writesFiles && !error && s.tests !== null),
      // Inside a turn a finished call is not the end: the model reads its result next.
      reaction: tests ? (error ? 'Tests failed; worth a look.' : 'Tests passed. Nice.') : error ? 'That one failed; worth a look.'
        : !s.turnStartedAt ? 'Done. What’s next?' : s.running > 1 ? 'On it.' : 'Thinking it over.',
      mood: error ? 'worried' : tests ? 'glad' : s.turnStartedAt ? 'busy' : 'idle',
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
      turnStartedAt: 0, tick: 0, running: 0, stage: 'idle', loopRunning: 0,
      lastTurn: { ms: Math.max(0, e.durationMs), calls: s.turnCalls, steps: s.stepCount, loopCalls: s.loopCalls, stopped: e.isAborted === true },
      ...(e.isAborted ? { reaction: 'Stopped. Over to you.', mood: 'idle' as const }
        : s.mood === 'busy' ? { reaction: 'Done. What’s next?', mood: 'idle' as const } : {}),
    }))
    void refreshGit($).then(() => refreshRepo($)).then(() => refreshContext($)).then(() => refresh($)).then(() => rebuild($))
    return result
  })
  on('ui.render', { component: 'Pane', requestId: 'ada' }, async ($, e) => {
    const { Box, Text, Button, Link, Progress } = $.ui.resolve(e)
    const state = await read($, pane)
    const now = await safely(() => $.clock.now()) ?? 0
    const usage = await safely(() => $.session.usage())
    const repo = await safely(() => $.session.repo())
    // Helpers are read from the engine's own list, never their task or what they wrote.
    const agents = state.view === 'agent' ? await safely(() => $.agent.list()) : null
    const gh = githubRepo(repo?.remote)
    const terminal = e.surface === 'terminal'
    const picture = (source: string, alt: string) => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)
      // Without a size the surface widens a drawing to its slot; thin bars must stay thin.
      const [width, height] = svgSize(source)
      return <Svg source={source} alt={alt} width={width} height={height} />
    }
    const view: AdaView = state.view === 'repo' && !repo ? 'session' : state.view
    // A reading taken in a repository says nothing once the session stands outside one.
    const git = repo ? state.git : null
    const show = (next: AdaView) => () => {
      void change($, s => ({ ...s, view: next })).then(async () => {
        try { await $.store.set('view', next) } catch { /* The next session opens on Session. */ }
        if (next === 'repo') await refreshRepo($)
        if (next === 'agent') await refreshContext($)
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

    // Readings of another repository (the session moved) are not this one's.
    const delivery = state.delivery && gh && state.delivery.name.toLowerCase() === `${gh.owner}/${gh.name}`.toLowerCase() ? state.delivery : null
    // ---- Header ----
    let ringPercent: number | null = null
    let ringSource = ''
    let ringAlt = ''
    let title = ''
    let under = ''
    let right: RenderChildren = null
    if (view === 'session' || view === 'agent') {
      ringPercent = context
      ringSource = ring(context, { mood: state.mood })
      ringAlt = `Ada, context ${context === null ? 'not known yet' : percentText(context)}`
      if (view === 'session') {
        title = clip(state.reaction, 40)
        under = state.lastTool ? `${shortTool(state.lastTool)}, ${state.lastStatus === 'running' ? 'running' : age(now, state.lastToolAt)}` : 'No tool calls yet'
      } else {
        title = state.turnStartedAt ? (state.stage === 'tools' ? 'Using tools' : 'Thinking')
          : state.lastTurn ? (state.lastTurn.stopped ? 'Stopped' : 'Answered') : 'Waiting for a prompt'
        under = state.model ? `${state.model}${state.effort ? `, ${state.effort} effort` : ''}` : 'No request yet'
      }
      // The line beside Ada already says when a turn is done; the chip is for what needs a look.
      right = state.lastStatus === 'error' ? chip('Failed', 'error')
        : state.turnStartedAt || state.running ? chip('Working', 'warning') : null
    } else if (view === 'repo') {
      ringPercent = delivery ? delivery.share * 100 : null
      ringSource = ring(ringPercent, { mood: state.mood })
      ringAlt = delivery ? `Ada, ${percentText(ringPercent ?? 0)} of the week’s delivery` : 'Ada'
      title = clip(gh ? gh.name : repo?.name ?? (repo?.root.split(/[\\/]/).filter(Boolean).pop() || 'This repository'), 40)
      under = git ? git.head : ''
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
        git && git.head,
        git && (git.changed ? plural(git.changed, 'file changed', 'files changed') : 'no changes'),
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
                {state.slowest ? ` Slowest: ${shortTool(state.slowest.tool)}, ${duration(state.slowest.ms)}` : ''}
              </Text>
              {state.toolCounts.length > 1 && <Text size="caption" dimColor>{toolMix(state.toolCounts)}</Text>}
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

    // ---- Agent ----
    const agentView = () => {
      const turning = !!state.turnStartedAt
      const ended = !turning && !!state.lastTurn
      const answered = ended && !state.lastTurn?.stopped
      const steps = turning ? state.stepCount : state.lastTurn?.steps ?? 0
      // The main loop's own calls: a helper's are its own loop's.
      const calls = turning ? state.loopCalls : state.lastTurn?.loopCalls ?? 0
      const at = (here: boolean, was: boolean): Station['state'] => (here ? 'now' : was ? 'done' : 'idle')
      const stations: Station[] = [
        { label: 'You', line: 'prompt', state: at(false, turning || ended) },
        { label: 'Model', line: plural(steps, 'request', 'requests'), state: at(turning && state.stage !== 'tools', steps > 0) },
        { label: 'Tools', line: plural(calls, 'call', 'calls'), state: at(turning && state.stage === 'tools', calls > 0) },
        { label: 'Answer', line: turning ? stopwatch(now - state.turnStartedAt) : !state.lastTurn ? 'waiting' : answered ? stopwatch(state.lastTurn.ms) : 'stopped', state: at(false, answered) },
      ]
      const sent = state.handoffs
      // hrn has a lane once it answered here or was handed a task; without it the picture is the session alone.
      const lane: Station[] | null = !stats && !sent.sent ? null : [
        { label: 'hrn', line: sent.sent ? plural(sent.sent, 'task', 'tasks') : 'no task yet', state: at(sent.running > 0, sent.sent > 0) },
        { label: 'Backend', line: sent.backends.length === 1 ? sent.backends[0] ?? '' : sent.backends.length ? `${sent.backends.length} backends` : 'its own', state: at(sent.running > 0, sent.sent > 0) },
        { label: 'Result', line: sent.failed ? `${grouped(sent.failed)} failed` : sent.back ? `${grouped(sent.back)} back` : 'comes back', state: at(false, sent.back + sent.failed > 0) },
      ]
      const stationColor = (s: Station) => (s.state === 'now' ? 'claude' : s.state === 'done' ? 'success' : undefined)
      const road = (list: Station[], joins: string[]) => (
        <Text>{list.map((s, i) => <Text>{i ? joins[i - 1] ?? ' → ' : ''}<Text color={stationColor(s)} weight={s.state === 'now' ? 'bold' : undefined} dimColor={s.state === 'idle'}>{s.label} ({s.line})</Text></Text>)}</Text>
      )

      const took = state.turnTokens
      const share = cacheShare(took)
      const readParts: Share[] = [
        { value: took.cached, fill: OK_FILL }, { value: took.fresh, fill: FRESH_FILL }, { value: took.written, fill: WRITTEN_FILL },
      ]
      const bar = (parts: Share[], alt: string) => (terminal
        ? <Text>{stackRuns(parts).map(run => <Text color={run.fill} dimColor={run.faint}>{run.text}</Text>)}</Text>
        : picture(stack(parts, alt), alt))
      const key = (rows: { name: string; tokens: number; fill: string }[]) => (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {rows.map(row => <Text size="caption"><Text color={row.fill}>■</Text> {row.name} <Text dimColor>{tokenCount(row.tokens)}</Text></Text>)}
        </Box>
      )
      const all = state.sessionTokens
      const kept = state.contextParts?.parts ?? null
      const partFill = (part: ContextPart, i: number) => (part.kind === 'used' ? PART_FILLS[i % PART_FILLS.length] ?? UNFILLED : UNFILLED)
      const live = (agents ?? []).filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
      const kinds = countKinds((agents ?? []).map(a => a.type))
      const helped = state.helperTokens
      return (
        <Box flexDirection="column" gap={1}>
          {section('The loop', (
            <Box flexDirection="column">
              {terminal
                ? <Box flexDirection="column">{road(stations, [' → ', ' ⇄ ', ' → '])}{lane && road(lane, [' → ', ' → '])}</Box>
                : picture(loopPicture(stations, lane), `You, the model, the tools and the answer: ${stageLine(state)}`)}
              <Text>{stageLine(state)}</Text>
              <Text size="caption" dimColor>Each request, the model reads the whole conversation, then asks for tools or answers.</Text>
            </Box>
          ))}
          {state.steps.length > 0 && section(turning ? 'This turn, request by request' : 'Last turn, request by request', (
            <Box flexDirection="column">
              {steps > state.steps.length && <Text size="caption" dimColor>{plural(steps - state.steps.length, 'earlier request', 'earlier requests')}</Text>}
              {state.steps.map(step => (
                <Text size="caption"><Text mono tabular dimColor>{String(step.index + 1).padStart(2, ' ')}</Text> {stepLine(step)}<Text dimColor>, {tokenCount(step.out)} written</Text></Text>
              ))}
            </Box>
          ))}
          {share !== null && section(turning ? 'What the model read this turn' : 'What the model read last turn', (
            <Box flexDirection="column">
              {bar(readParts, `${share}% of it came from the cache`)}
              {key([
                { name: 'From the cache', tokens: took.cached, fill: OK_FILL }, { name: 'New', tokens: took.fresh, fill: FRESH_FILL },
                { name: 'Saved for next time', tokens: took.written, fill: WRITTEN_FILL },
              ].filter(row => row.tokens > 0))}
              <Text size="caption" dimColor>
                {share}% came from the cache, so a request pays mostly for what changed. This session: {tokenCount(all.fresh + all.cached + all.written)} read, {tokenCount(all.out)} written.
              </Text>
            </Box>
          ))}
          {kept && section('What fills the context', (
            <Box flexDirection="column">
              {bar(kept.map((part, i) => ({ value: part.tokens, fill: partFill(part, i), faint: part.kind === 'free' })), 'The context window by what fills it')}
              {key(kept.map((part, i) => ({ name: part.name, tokens: part.tokens, fill: partFill(part, i) })))}
            </Box>
          ))}
          {(live.length > 0 || state.helpersStarted > 0) && section('Helpers', (
            <Box flexDirection="column">
              <Text>{grouped(live.length)} running, {grouped(Math.max(state.helpersStarted, (agents ?? []).length))} started this session</Text>
              {kinds && <Text size="caption" dimColor>{kinds}</Text>}
              {helped.out > 0 && <Text size="caption" dimColor>They read {tokenCount(helped.fresh + helped.cached + helped.written)} and wrote {tokenCount(helped.out)}.</Text>}
              <Text size="caption" dimColor>A helper is the same loop again with a context of its own; only its report comes back.</Text>
            </Box>
          ))}
          {section('Through hrn', (
            <Box flexDirection="column">
              <Text dimColor={!sent.sent}>
                {sent.sent
                  ? `${plural(sent.sent, 'task', 'tasks')} handed over: ${[
                    sent.back && `${grouped(sent.back)} came back`, sent.failed && `${grouped(sent.failed)} failed`, sent.running && `${grouped(sent.running)} running`,
                  ].filter(Boolean).join(', ') || 'not waited for'}`
                  : stats ? 'Nothing handed to hrn this session.' : 'hrn has not answered here: this is the session alone.'}
              </Text>
              {sent.backends.length > 0 && <Text size="caption" dimColor>On {sent.backends.join(', ')}</Text>}
              <Text size="caption" dimColor>hrn runs a task on a backend of its choosing and records the run; in a batch each task gets its own branch and gate checks.</Text>
            </Box>
          ))}
        </Box>
      )
    }

    // ---- Repo ----
    const repoView = () => {
      const runs = gh ? state.runs : null
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
          {delivery && section('Delivered here', delivery.week === 0 && delivery.days.every(d => d === 0)
            ? <Text dimColor>Nothing delivered here yet</Text>
            : (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={2} alignItems="center">
                  <Text size="title" mono tabular>{grouped(delivery.week)}</Text>
                  <Box flexDirection="column" flexGrow={1}>
                    <Progress label="This week" value={delivery.week} max={Math.max(1, delivery.total, delivery.week)}
                      valueText={`${grouped(delivery.week)} of ${grouped(delivery.total)}`} color="success" />
                  </Box>
                </Box>
                {terminal
                  ? <Text color="success">{blockRuns(delivery.days.map(xp => ({ tool: '', ms: xp, ok: true }))).map(r => r.text).join('')}</Text>
                  : picture(deliveryStrip(delivery.days), `Delivery here on ${delivery.days.filter(d => d > 0).length} of the last 35 days`)}
                {delivery.kinds.map(k => <Text size="caption" dimColor>{kindLine(k.kind, k.count)}</Text>)}
                {now - state.statsAt > 600000 && <Text size="caption" dimColor>Read {age(now, state.statsAt)}</Text>}
              </Box>
            ))}
          {runs && section('Runs here', runs.length === 0
            ? <Text dimColor>No hrn runs here in the last 14 days</Text>
            : (
              <Box flexDirection="column">
                {runs.filter(r => isLive(r, now)).slice(0, 3).map(r => (
                  <Text size="caption"><Text color="warning">●</Text> {r.backend}, running {duration(now - r.started)}</Text>
                ))}
                {runs.filter(r => !isLive(r, now)).slice(0, 5).map(r => (r.status === 'running'
                  ? <Text size="caption"><Text dimColor>●</Text> {r.backend}, stopped without a result, {age(now, r.started)}</Text>
                  : <Text size="caption"><Text color={r.status === 'ok' ? 'success' : 'error'}>●</Text> {r.backend}, {duration(r.ms)}, {age(now, r.started + r.ms)}</Text>))}
              </Box>
            ))}
          {links && section('Links', (
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              <Link href={links.repository} label="Repository" />
              <Link href={links.pulls} label="Pull requests" />
              <Link href={links.actions} label="Actions" />
              {terminal && watchUrl && state.watch === watchUrl && <Link href={watchUrl} label="Watch" />}
            </Box>
          ))}
          {delivery && delivery.top.length > 0 && section('Top repositories this week', (
            <Box flexDirection="column">
              {delivery.top.map(t => (
                <Text size="caption" dimColor={t.repo.toLowerCase() !== delivery.name.toLowerCase()}
                  weight={t.repo.toLowerCase() === delivery.name.toLowerCase() ? 'semibold' : undefined}>
                  {t.repo}, {grouped(t.week)}{t.repo.toLowerCase() === delivery.name.toLowerCase() ? ' (this one)' : ''}
                </Text>
              ))}
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
        {view === 'session' ? sessionView() : view === 'agent' ? agentView() : view === 'repo' ? repoView() : youView()}
      </Box>
    )
  })
}
