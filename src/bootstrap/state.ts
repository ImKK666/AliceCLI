// Barrel re-export — all 291+ importers of 'src/bootstrap/state.js' continue
// to work unchanged. The actual implementations live in domain modules.
export type {
  ChannelEntry,
  AttributedCounter,
  SessionCronTask,
  InvokedSkillInfo,
} from './_state.js'
export * from './session.js'
export * from './tokens.js'
export * from './model.js'
export * from './permissions.js'
export * from './telemetry.js'
export * from './features.js'
export * from './ui.js'
export * from './misc.js'

// resetStateForTests lives in the barrel because it must reset cross-module
// state: the STATE singleton (_state.ts), module-level token vars (tokens.ts),
// and the session-switched signal (_state.ts).
import { STATE, getInitialState, sessionSwitched } from './_state.js'
import { _resetTokenVarsForTests } from './tokens.js'

// Only used in tests
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    ;(STATE as Record<string, unknown>)[key] = value
  })
  _resetTokenVarsForTests()
  sessionSwitched.clear()
}
