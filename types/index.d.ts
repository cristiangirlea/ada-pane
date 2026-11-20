/** What the pane keeps of `hrn bot stats --json`. */
export type Stats = {
  level: number
  xp: number
  /** Null when hrn gives no streak. */
  streak: number | null
  week: { delivery: number; practice: number }
  /** The last 35 days, oldest first: a day with practice. */
  days: boolean[]
  badges: string[]
  ada: { level: number; xpThisWeek: number } | null
  exercise: { kind: string; answered: boolean } | null
}

export type AdaView = 'session' | 'repo' | 'you'

/** One finished tool call, as the strip draws it. */
export type ToolBar = { tool: string; ms: number; ok: boolean }

/** The last test run seen: the runner's name only, never its command. */
export type TestRun = { runner: string; ok: boolean; at: number }

/** What `git status --porcelain=v2 --branch` says of the working tree. */
export type GitStatus = {
  /** The branch, or `detached at <short commit>`. */
  head: string
  detached: boolean
  changed: number
  /** Null when the branch has no upstream. */
  ahead: number | null
  behind: number | null
}

export type CheckState = 'passed' | 'failed' | 'running'

/** What `gh pr view --json ...` says of the branch's pull request. */
export type PullRequest = {
  number: number
  title: string
  state: 'open' | 'merged' | 'closed'
  review: 'approved' | 'changes' | 'required' | 'none'
  checks: CheckState[]
  /** Issues it closes in this repository. */
  issues: number[]
}

export type PrReading =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'found'; pr: PullRequest }
  /** gh is missing or not signed in: one dim line saying which. */
  | { kind: 'note'; note: string }
  /** Any other failure: the section is left out. */
  | { kind: 'hidden' }

/** What `hrn bot stats --json --repo` says of this repository's delivery. */
export type Delivery = {
  /** The repository as asked, `owner/name`. */
  name: string
  week: number
  /** The week's delivery in every repository. */
  total: number
  /** Delivery per UTC day, oldest first, today last. */
  days: number[]
  /** The three kinds with the most events, most first. */
  kinds: { kind: string; count: number }[]
  share: number
  top: { repo: string; week: number }[]
}

/** One hrn run of this repository, from `hrn runs --json --repo`; never its prompt. */
export type HrnRun = {
  id: string
  backend: string
  /** `running` while the run has no result. */
  status: string
  started: number
  ms: number
}

export type AdaState = {
  stats: Stats | null
  /** When the stats were read, in milliseconds; 0 when never. */
  statsAt: number
  /** Why there are none: '' while there are, or none were asked for yet. */
  statsNote: string
  refreshing: boolean
  view: AdaView
  reaction: string
  mood: 'idle' | 'busy' | 'glad' | 'worried'
  recordingFailed: boolean
  lastTool: string
  lastToolAt: number
  lastStatus: '' | 'running' | 'ok' | 'error'
  /** Tool calls started and not finished. */
  running: number
  /** The last 40 finished calls, oldest first. */
  calls: ToolBar[]
  callCount: number
  failedCount: number
  slowest: ToolBar | null
  /** When the running turn started; 0 between turns. */
  turnStartedAt: number
  turnCalls: number
  /** Moved once a second while a turn runs, so the running time redraws. */
  tick: number
  lastTurn: { ms: number; calls: number } | null
  tests: TestRun | null
  editedSinceTests: boolean
  git: GitStatus | null
  pr: PrReading
  /** Null while unknown, or when hrn cannot answer per repository. */
  delivery: Delivery | null
  /** Null while unknown, or when hrn cannot list runs per repository. */
  runs: HrnRun[] | null
  /** The address that answered as an hrn watch; its link is drawn on the terminal only, and only while it is still the configured one. */
  watch?: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'ada-pane': { pane: Shaped<AdaState> }
  }
}
