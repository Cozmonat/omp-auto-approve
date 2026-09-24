/**
 * Host-only OMP modules loaded at runtime by native-judge.ts.  The plugin
 * ships no copy (the build marks `@oh-my-pi/*` external; the host remaps
 * plugin imports to its own graph), so exports are `unknown` here and
 * native-judge.ts validates each one before use.
 */
declare module "@oh-my-pi/pi-coding-agent/judgment" {
  export const hasNativeJudge: unknown;
  export const resolveJudge: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/config/settings" {
  export const Settings: unknown;
}
