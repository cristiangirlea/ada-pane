import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import type { AdaState, AdaView, Stats } from '../types'

const initial: AdaState = {
  stats: null, statsAt: 0, statsNote: '', refreshing: false, view: 'now',
  prompts: 0, started: 0, finished: 0, lastTool: '', lastStatus: '',
  reaction: 'Ready when you are.', mood: 'idle', recordingFailed: false,
}

// The tag declines what a version with other fields stored.
const pane = atom({ plugin: 'ada-pane', key: 'pane' } as const, initial, { shape: 'ada-2' })

// hrn reads every run record: a first answer has taken over a minute.
const STATS_TIMEOUT_MS = 180000
const STATS_EVERY_MS = 600000

let lastRefresh = -Infinity
let writes = Promise.resolve()

async function change($: EngineInterface, fn: (s: AdaState) => AdaState) {
  try { await update($, pane, fn) } catch { /* Observation must not affect the session. */ }
}

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
    if (state.refreshing || (!force && now - lastRefresh < STATS_EVERY_MS)) return
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
  } catch { await change($, s => ({ ...s, refreshing: false })) }
}

/** The stats an earlier session kept, shown at once while hrn is asked again. */
async function recall($: EngineInterface) {
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

/** hrn's rule: level n starts at 50 n squared. */
export function levelSpan(level: number, xp: number) {
  const from = 50 * level * level
  const to = 50 * (level + 1) * (level + 1)
  const done = Math.min(to - from, Math.max(0, xp - from))
  return { toGo: to - from - done, percent: Math.round((done / (to - from)) * 100) }
}

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ',')

export function age(now: number, at: number) {
  if (!at) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

const MOOD_EYE: Record<AdaState['mood'], string> = {
  idle: '<circle cx="39" cy="24" r="3.4" fill="#17202c"/><circle cx="40.2" cy="22.8" r="1.1" fill="#fff"/>',
  busy: '<circle cx="39" cy="24" r="3.4" fill="#17202c"/><circle cx="37.8" cy="25" r="1.1" fill="#fff"/>',
  glad: '<path d="M35 25q4-5 8 0" fill="none" stroke="#17202c" stroke-width="2.2" stroke-linecap="round"/>',
  worried: '<circle cx="39" cy="25" r="3" fill="#17202c"/><path d="M34 18l9 3" stroke="#17202c" stroke-width="2" stroke-linecap="round"/>',
}

/** Ada, a scarlet macaw, with the eye her mood gives her. */
export function macaw(mood: AdaState['mood']) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56">'
    + '<title>Ada</title>'
    + '<path d="M14 62c0-22 6-34 14-40C32 8 44 4 52 12c6 6 5 16-1 22-4 4-5 9-5 14v14z" fill="#d83a2e"/>'
    + '<path d="M14 62c0-12 3-22 8-29 3 9 9 14 17 15v14z" fill="#f2c230"/>'
    + '<path d="M14 62c0-8 2-14 5-19 3 6 7 9 12 10v9z" fill="#2a63c9"/>'
    + '<ellipse cx="40" cy="25" rx="10" ry="9.5" fill="#fbf6ee"/>'
    + MOOD_EYE[mood]
    + '<path d="M49 22c8-1 12 5 10 13-1 5-5 8-9 8 3-4 3-8 0-11-2-2-3-6-1-10z" fill="#2b2f36"/>'
    + '<path d="M50 33c2 3 2 6 0 10-3 0-5-2-6-5z" fill="#3d434d"/>'
    + '</svg>'
}

/** The last 35 days as a grid of weeks, a filled square for a day with practice. */
export function dayGrid(days: boolean[]) {
  const cells = days.slice(-35)
  const squares = cells.map((practised, i) =>
    `<rect x="${(i % 7) * 13}" y="${Math.floor(i / 7) * 13}" width="10" height="10" rx="2.5" fill="${practised ? '#2a9d6a' : '#8a94a3'}" fill-opacity="${practised ? 1 : 0.28}"/>`).join('')
  const rows = Math.max(1, Math.ceil(cells.length / 7))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 ${rows * 13 - 3}" width="88" height="${rows * 13 - 3}"><title>Practice in the last ${cells.length} days</title>${squares}</svg>`
}

const VIEWS: { id: AdaView; label: string }[] = [
  { id: 'now', label: 'Now' }, { id: 'progress', label: 'Progress' }, { id: 'badges', label: 'Badges' },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try { await $.command.register({ name: 'ada', description: 'Open Ada’s session pane' }) } catch {}
    try { void $.ui.open({ id: 'ada', title: 'Ada' }).catch(() => {}) } catch {}
    void recall($).then(() => refresh($))
    try { $.clock.every(STATS_EVERY_MS, () => { void refresh($) }) } catch {}
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
    await change($, s => ({ ...s, prompts: s.prompts + 1, reaction: 'Let’s see what we can do.', mood: 'busy' }))
    await record($, { kind: 'prompt' })
    return result
  })
  on('tool.call', async ($, e, next) => {
    await change($, s => ({ ...s, started: s.started + 1, lastTool: e.tool, lastStatus: 'running', reaction: 'On it.', mood: 'busy' }))
    const result = await next(e)
    const error = result.deny !== undefined || result.isError === true
    const tests = e.tool === 'Bash' && /\bgo\s+test\b/.test(e.command)
    await change($, s => ({
      ...s, finished: s.finished + 1, lastTool: e.tool, lastStatus: error ? 'error' : 'ok',
      reaction: error ? 'That one failed; worth a look.' : tests ? 'Tests passed. Nice.' : 'Done. What’s next?',
      mood: error ? 'worried' : tests ? 'glad' : 'idle',
    }))
    await record($, { kind: 'tool', tool: e.tool, status: error ? 'error' : 'ok' })
    return result
  })
  on('ui.render', { component: 'Pane', requestId: 'ada' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, pane)
    const now = await $.clock.now()
    const stats = state.stats
    const drawn = e.surface !== 'terminal'
    const picture = (source: string, alt: string) => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={source} alt={alt} />
    }
    const show = (view: AdaView) => () => { void change($, s => ({ ...s, view })) }
    const ask = (text: string) => () => { void $.prompt.fill({ text, mode: 'insert' }) }
    const card = (title: string, children: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={0}>
        <Text size="caption" dimColor>{title.toUpperCase()}</Text>
        {children}
      </Box>
    )
    const figure = (value: string, label: string, color?: string) => (
      <Box flexDirection="column" flexGrow={1}>
        <Text size="heading" weight="semibold" tabular color={color}>{value}</Text>
        <Text size="caption" dimColor>{label}</Text>
      </Box>
    )
    const span = stats ? levelSpan(stats.level, stats.xp) : null
    const statusColor = state.lastStatus === 'error' ? 'error' : state.lastStatus === 'ok' ? 'success' : 'warning'
    const statsLine = state.refreshing
      ? (stats ? `Asking hrn again; last read ${age(now, state.statsAt)}` : 'Asking hrn for your stats; the first answer can take a minute')
      : state.statsNote || (stats ? `Read ${age(now, state.statsAt)}` : 'No stats yet')

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {picture(macaw(state.mood), `Ada the macaw, ${state.mood}`)}
          <Box flexDirection="column" flexGrow={1}>
            <Text size="heading" weight="semibold">{state.reaction}</Text>
            <Text size="caption" dimColor>{statsLine}</Text>
          </Box>
        </Box>

        <Box flexDirection="row" gap={1}>
          {VIEWS.map(view => (
            <Button key={`view-${view.id}`} label={view.label} variant={state.view === view.id ? 'primary' : 'secondary'} onPress={show(view.id)} />
          ))}
          <Button key="refresh" label={state.refreshing ? 'Asking…' : 'Refresh'} dimColor={state.refreshing} onPress={() => { void refresh($, true) }} />
        </Box>

        {state.view === 'now' && card('This session', (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={2}>
              {figure(String(state.prompts), state.prompts === 1 ? 'prompt' : 'prompts')}
              {figure(String(state.finished), 'tool calls done')}
              {figure(String(Math.max(0, state.started - state.finished)), 'running', state.started > state.finished ? 'warning' : undefined)}
            </Box>
            {state.lastTool
              ? <Text>Last tool <Text weight="semibold">{state.lastTool}</Text> <Text color={statusColor}>{state.lastStatus}</Text></Text>
              : <Text dimColor>No tool calls yet.</Text>}
            {state.lastStatus === 'error' && (
              <Button key="ask-why" label="Ask why it failed" variant="primary"
                onPress={ask('Look at the last tool call that failed and tell me why it failed and what to change.')} />
            )}
            {state.recordingFailed && <Text color="warning">Session recording unavailable.</Text>}
          </Box>
        ))}

        {state.view === 'now' && stats && span && card(`Level ${stats.level}`, (
          <Box flexDirection="column">
            <Box flexDirection="row" width="100%">
              {span.percent > 0 && <Box flexGrow={span.percent} backgroundColor="claude"><Text> </Text></Box>}
              {span.percent < 100 && <Box flexGrow={100 - span.percent} backgroundColor="subtle"><Text> </Text></Box>}
            </Box>
            <Text size="caption" dimColor>{grouped(stats.xp)} XP, {grouped(span.toGo)} to level {stats.level + 1}</Text>
          </Box>
        ))}

        {state.view === 'progress' && !stats && card('Progress', <Text dimColor>{statsLine}.</Text>)}
        {state.view === 'progress' && stats && span && (
          <Box flexDirection="column" gap={1}>
            {card(`Level ${stats.level}`, (
              <Box flexDirection="column">
                <Box flexDirection="row" width="100%">
                  {span.percent > 0 && <Box flexGrow={span.percent} backgroundColor="claude"><Text> </Text></Box>}
                  {span.percent < 100 && <Box flexGrow={100 - span.percent} backgroundColor="subtle"><Text> </Text></Box>}
                </Box>
                <Text size="caption" dimColor>{grouped(stats.xp)} XP, {grouped(span.toGo)} to level {stats.level + 1} ({span.percent}%)</Text>
              </Box>
            ))}
            {card('This week', (
              <Box flexDirection="row" gap={2}>
                {figure(grouped(stats.week.delivery), 'delivery XP')}
                {figure(grouped(stats.week.practice), 'practice XP')}
                {stats.ada && figure(String(stats.ada.xpThisWeek), `Ada, level ${stats.ada.level}`)}
              </Box>
            ))}
            {card('Practice', (
              <Box flexDirection="row" gap={2} alignItems="center">
                {drawn
                  ? picture(dayGrid(stats.days), `${stats.days.filter(Boolean).length} of the last ${stats.days.length} days with practice`)
                  : <Text>{stats.days.map(practised => (practised ? '■' : '□')).join('')}</Text>}
                <Box flexDirection="column" flexGrow={1}>
                  <Text size="heading" weight="semibold" tabular>{stats.streak === null ? '–' : String(stats.streak)}</Text>
                  <Text size="caption" dimColor>{stats.streak === 1 ? 'day streak' : 'days streak'}</Text>
                </Box>
              </Box>
            ))}
            {stats.exercise && card('Today’s exercise', (
              <Box flexDirection="column" gap={1}>
                <Text>{stats.exercise.kind} <Text color={stats.exercise.answered ? 'success' : 'warning'}>{stats.exercise.answered ? 'answered' : 'waiting'}</Text></Text>
                {!stats.exercise.answered && (
                  <Button key="exercise" label="Open it" variant="primary"
                    onPress={ask('Run `hrn bot practice` and show me today’s exercise.')} />
                )}
              </Box>
            ))}
          </Box>
        )}

        {state.view === 'badges' && card('Badges', (
          !stats ? <Text dimColor>{statsLine}.</Text>
            : stats.badges.length === 0 ? <Text dimColor>None yet. They come from real outcomes.</Text>
              : <Box flexDirection="column">{stats.badges.map(badge => <Text>★ {badge}</Text>)}</Box>
        ))}
      </Box>
    )
  })
}
