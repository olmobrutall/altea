// TODO(port): Signum's TimeMachineIcon (Lines/TimeMachineIcon.tsx) shows a version-diff icon when a
// TypeContext carries `previousVersion` (Time Machine / system-versioning UI). It depends on
// EntityControlMessage / getToString / EnumEntity which aren't ported yet, and it's an orthogonal
// feature to the Lines value editors, so it's stubbed to render nothing for now. Restore by copying
// the Signum component once those deps land.
import type { StyleContext } from '../TypeContext';

export function getTimeMachineIcon(p: { ctx: StyleContext; isContainer?: boolean; translateY?: string }): null {
  return null;
}
