import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { AdaState } from '../types'

const pane = atom({ plugin: 'ada-pane', key: 'pane' } as const, {
  stats: 'hrn bot stats unavailable', prompts: 0, started: 0, finished: 0,
  lastTool: 'none', lastStatus: '', reaction: 'Ready when you are.', recordingFailed: false,
} as AdaState)

let lastRefresh = -Infinity
let refreshing = false
let writes = Promise.resolve()


async function change($: EngineInterface, fn: (s: AdaState) => AdaState) {
    try { await update($, pane, fn) } catch { /* Observation must not affect the session. */ }
  }
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// Ledger keys become badge names, so control characters and length are cut before drawing.
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 40)

function weekStart(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined
  return `${days[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

// The JSON form folds new runs in and skips the text form's slow practice step.
export function formatStats(stdout: string): string | undefined {
  let s: any
  try { s = JSON.parse(stdout) } catch { return undefined }
  if (!s || typeof s !== 'object' || s.version !== 1) return undefined
  if (s.enabled === false) return 'The game is off; the ledger keeps recording.'
  if (!count(s.level) || !count(s.xp)) return undefined
  const lines = [`level ${s.level}, ${s.xp} xp (${Math.max(0, 50 * (s.level + 1) ** 2 - s.xp)} more for level ${s.level + 1})`]
  if (count(s.streak)) lines.push(`streak: ${s.streak} days`)
  if (s.week && count(s.week.delivery) && count(s.week.practice)) {
    const from = weekStart(s.week_start)
    lines.push(`this week${from ? `, from ${from} UTC` : ''}: delivery ${s.week.delivery} xp, practice ${s.week.practice} xp`)
  }
  if (s.ada && count(s.ada.level) && count(s.ada.xp_this_week)) lines.push(`Ada: level ${s.ada.level}, ${s.ada.xp_this_week} xp this week`)
  const badges: string[] = Array.isArray(s.badges) ? s.badges.filter((b: unknown) => typeof b === 'string').map(clean).filter(Boolean) : []
  const shown = badges.slice(0, 10).join(', ') + (badges.length > 10 ? `, +${badges.length - 10} more` : '')
  lines.push(`badges: ${badges.length ? shown : 'none yet'}`)
  return lines.join('\n')
}

async function hrnHome($: EngineInterface) {
  const home = await $.env.get('HRN_HOME') || ((await $.env.get('HOME') || await $.env.get('USERPROFILE')) + '/.hrn')
  if (!home || home.startsWith('undefined/')) throw new Error('Home unavailable')
  return home.replace(/[\\/]+$/, '')
}

async function refresh($: EngineInterface, force = false) {
    try {
      const now = await $.clock.now()
      if (refreshing || (!force && now - lastRefresh < 60000)) return
      refreshing = true
      lastRefresh = now
      let stats = 'hrn bot stats unavailable'
      try {
        const result = await $.process.run(['hrn', 'bot', 'stats', '--json'], { timeoutMs: 30000 })
        if (result.exitCode === 0 && !result.isStdoutTruncated) stats = formatStats(result.stdout) ?? stats
      } catch { /* Use the unavailable line. */ }
      await change($, s => ({ ...s, stats }))
      refreshing = false
    } catch { refreshing = false }
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try { await $.command.register({ name: 'ada', description: 'Open Ada’s session pane' }) } catch {}
    try { void $.ui.open({ id: 'ada', title: 'Ada' }).catch(() => {}) } catch {}
    void refresh($)
    try { $.clock.every(60000, () => { void refresh($) }) } catch {}
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
    await change($, s => ({ ...s, prompts: s.prompts + 1, reaction: 'Let’s see what we can do.' }))
    await record($, { kind: 'prompt' })
    return result
  })
  on('tool.call', async ($, e, next) => {
    await change($, s => ({ ...s, started: s.started + 1, lastTool: e.tool, lastStatus: 'running', reaction: 'On it.' }))
    const result = await next(e)
    const error = result.deny !== undefined || result.isError === true
    const tests = e.tool === 'Bash' && /\bgo\s+test\b/.test(e.command)
    await change($, s => ({ ...s, finished: s.finished + 1, lastTool: e.tool, lastStatus: error ? 'error' : 'ok', reaction: error ? 'That one failed; worth a look.' : tests ? 'Tests passed. Nice.' : 'Done. What’s next?' }))
    await record($, { kind: 'tool', tool: e.tool, status: error ? 'error' : 'ok' })
    return result
  })
  on('ui.render', { component: 'Pane', requestId: 'ada' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, pane)
    return (
      <Box flexDirection="column">
        <Text>{state.stats}</Text>
        <Text>Prompts: {state.prompts} | Tools started: {state.started} | finished: {state.finished}</Text>
        <Text>Last tool: {state.lastTool}{state.lastStatus ? ` (${state.lastStatus})` : ''}</Text>
        <Text>{state.reaction}</Text>
        {state.recordingFailed && <Text>Session recording unavailable.</Text>}
      </Box>
    )
  })
}
