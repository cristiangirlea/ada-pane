export type AdaState = {
  stats: string
  prompts: number
  started: number
  finished: number
  lastTool: string
  lastStatus: string
  reaction: string
  recordingFailed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ada-pane': { pane: AdaState }
  }
}
