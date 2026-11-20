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

export type AdaView = 'now' | 'progress' | 'badges'

export type AdaState = {
  stats: Stats | null
  /** When the stats were read, in milliseconds; 0 when never. */
  statsAt: number
  /** Why there are none: '' while there are, or none were asked for yet. */
  statsNote: string
  refreshing: boolean
  view: AdaView
  prompts: number
  started: number
  finished: number
  lastTool: string
  lastStatus: string
  reaction: string
  mood: 'idle' | 'busy' | 'glad' | 'worried'
  recordingFailed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ada-pane': { pane: Shaped<AdaState> }
  }
}
