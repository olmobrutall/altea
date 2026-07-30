// TODO(port): Signum's TimeMachineIcon (Lines/TimeMachineIcon.tsx) shows a version-diff icon when a
// TypeContext carries `previousVersion` (Time Machine / system-versioning UI). It depends on
// EntityControlMessage / getToString / EnumEntity which aren't ported yet, and it's an orthogonal
// feature to the Lines value editors, so it's stubbed to render nothing for now. Restore by copying
// the Signum component once those deps land.
import type { StyleContext } from '../TypeContext';

export function getTimeMachineIcon(p: { ctx: StyleContext; isContainer?: boolean; translateY?: string }): null {
  return null;
}

// Checkbox-list variant of the same stub (Signum's getTimeMachineCheckboxIcon): renders the version-
// diff marker next to a checkbox element. Null until the Time Machine UI is ported (see note above).
export function getTimeMachineCheckboxIcon(p: { newCtx: unknown; oldCtx: unknown; type: unknown }): null {
  return null;
}

// Signum's TimeMachineColors (Lines/TimeMachineIcon.tsx): the colours the version-diff icon uses to
// mark changed vs unchanged values in the Time Machine UI.
export const TimeMachineColors = {
  changed: "#FF9800",
  noChange: "#B0BEC5",
};
