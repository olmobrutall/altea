import * as React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { StyleContext, TypeContext } from '../TypeContext';
import { EntityControlMessage } from '../../data/uiMessages';
import { Entity, EmbeddedEntity } from '../../data/entity';
import { Lite } from '../../data/lite';
import { Enum } from '../../data/enum';

// Port of Signum's Lines/TimeMachineIcon.tsx — the little coloured dot every Line renders beside its
// value when the TypeContext carries a `previousVersion`, telling the reader at a glance whether that
// value was added, removed, changed, moved, or left alone between the two versions being compared.
//
// It lives in CORE (as it does in Signum) even though the feature it serves is the optional
// @altea/altea-time-machine module: the Lines are the ones that have to render it, and all the module
// does is fill `ctx.previousVersion` (TimeMachinePage's RenderEntityVersion) so the dots light up. With
// no module started nothing ever sets `previousVersion`, so every call below returns null and the icon
// costs nothing.
//
// altea divergences from Signum's file:
//  - **no `translateX`.** No altea Line passes one (Signum only used it to nudge the EntityTabRepeater
//    tab icon, and altea's tab markup does not need it), so the prop is dropped rather than carried dead.
//  - `is(previous, current, false, false)` becomes `.is()` on the Lite/Entity itself (altea has no free
//    `is` function), guarded by an instanceof so a non-entity value never reaches it.
//  - the checkbox variant reads `oldCtx.value` DIRECTLY where Signum reads `oldCtx.value.element`: altea
//    has no MListElement wrapper, so an enum-checkbox list ctx holds the value itself.
//  - `p.type` is the ENUM OBJECT (what `ctx.memberType!.getEnum()` hands back and what EnumCheckboxList
//    already has), not Signum's TypeInfo — so the label comes from `Enum.niceName`, not `members[…]`.

type ChangeType = "New" | "Removed" | "Changed" | "Moved" | "NoChange";

export interface TimeMachineIconProps {
  ctx: StyleContext;
  isContainer?: boolean;
  translateY?: string;
}

export function getTimeMachineIcon(p: TimeMachineIconProps): React.ReactElement | null {
  if (!(p.ctx as TypeContext<unknown>).previousVersion)
    return null;

  return <TimeMachineIcon ctx={p.ctx} isContainer={p.isContainer} translateY={p.translateY} />;
}

function TimeMachineIcon(p: TimeMachineIconProps): React.ReactElement | null {
  const ctx = p.ctx as TypeContext<unknown>;

  if (!ctx.previousVersion)
    return null;

  const previous = ctx.previousVersion.value;
  const current = ctx.value;

  // Signum's ladder, in order: appeared / disappeared / reordered / identical / same entity by id /
  // an embedded is never itself "changed" (its own members carry their own icons) / changed.
  const change: ChangeType =
    previous == null && current != null ? "New" :
      previous != null && current == null ? "Removed" :
        ctx.previousVersion.isMoved ? "Moved" :
          previous === current ? "NoChange" :
            sameValue(previous, current) ? "NoChange" :
              sameEntity(previous, current) ? "NoChange" :
                ctx.memberType?.is(EmbeddedEntity) && previous != null && current != null ? "NoChange" :
                  "Changed";

  const color = change == "Changed" || change == "Moved" ? TimeMachineColors.changed :
    change == "New" ? TimeMachineColors.created :
      change == "Removed" ? TimeMachineColors.removed :
        TimeMachineColors.noChange;

  const title = change == "Changed" ? EntityControlMessage.PreviousValueWas0.niceToString(`${previous}`) :
    change == "Moved" ? EntityControlMessage.Moved.niceToString() :
      change == "New" ? EntityControlMessage.Added.niceToString() :
        change == "Removed" ? EntityControlMessage.Removed0.niceToString(p.isContainer ? "" : `${previous}`) :
          EntityControlMessage.NoChanges.niceToString();

  return (
    <FontAwesomeIcon
      aria-hidden={true}
      icon="circle"
      title={title}
      fontSize={14}
      style={{
        position: p.isContainer ? undefined : 'absolute',
        zIndex: p.isContainer ? undefined : 2,
        minWidth: "14px",
        minHeight: "14px",
        transform: p.isContainer && !p.translateY ? undefined : `translate(-40%, ${p.translateY ?? "-40%"})`,
        color: color,
      }}
    />
  );
}

// altea divergence: Signum's Date / DateOnly / decimal are C# VALUE types, so its `previous == current`
// settles them. altea's counterparts (Temporal.*, decimal.js Decimal) are OBJECTS — two instances holding
// the same instant are `!==`, and every date and money line would read as "changed" on every comparison.
// Both expose a canonical `toString()`, so that is the value comparison.
function sameValue(previous: unknown, current: unknown): boolean {
  if (previous == null || current == null || typeof previous !== "object" || typeof current !== "object")
    return false;
  if (previous instanceof Entity || previous instanceof Lite || current instanceof Entity || current instanceof Lite)
    return false;   // an entity is compared by IDENTITY, below
  return previous.constructor === current.constructor && String(previous) === String(current);
}

// Two values that are the same row: Signum's `is(previous, current, false, false)`. Anything that is
// not an Entity/Lite falls through to the plain `!==` the caller already applied.
function sameEntity(previous: unknown, current: unknown): boolean {
  if (previous instanceof Lite || previous instanceof Entity)
    return previous.is(current as Entity | Lite<Entity> | null);
  return false;
}

// Signum's TimeMachineColors. SearchValue also reads `changed` / `noChange` for its history dot.
export const TimeMachineColors = {
  changed: "orange",
  created: "#2ECC71",
  removed: "red",
  noChange: "#ddd",
};

export interface TimeMachineIconCheckboxProps {
  newCtx: TypeContext<unknown> | null;
  oldCtx: TypeContext<unknown> | null;
  translateX?: string;
  translateY?: string;
  /** The enum object the list edits (`ctx.memberType!.getEnum()`), for the "Removed {0}" label. */
  type?: Record<string, string | number>;
}

export function getTimeMachineCheckboxIcon(p: TimeMachineIconCheckboxProps): React.ReactElement | null {
  if ((p.newCtx == null && p.oldCtx == null) || (p.newCtx != null && !p.newCtx.previousVersion))
    return null;

  return <TimeMachineCheckboxIcon {...p} />;
}

function TimeMachineCheckboxIcon(p: TimeMachineIconCheckboxProps): React.ReactElement {

  const change: ChangeType =
    p.oldCtx == null && p.newCtx == null ? "NoChange" :
      p.oldCtx == null && p.newCtx != null ? "New" :
        p.oldCtx != null && p.newCtx == null ? "Removed" :
          p.oldCtx === p.newCtx ? "NoChange" : "Changed";

  const color = change == "Changed" ? TimeMachineColors.changed :
    change == "New" ? TimeMachineColors.created :
      change == "Removed" ? TimeMachineColors.removed :
        TimeMachineColors.noChange;

  const title = change == "Changed" ? EntityControlMessage.RemovedAndSelectedAgain.niceToString() :
    change == "New" ? EntityControlMessage.Selected.niceToString() :
      change == "Removed" ? EntityControlMessage.Removed0.niceToString(removedLabel(p)) :
        EntityControlMessage.NoChanges.niceToString();

  return (
    <FontAwesomeIcon aria-hidden={true} icon="circle" title={title}
      fontSize={14}
      style={{
        position: 'absolute',
        zIndex: 2,
        minWidth: "14px",
        minHeight: "14px",
        transform: `translate(${p.translateX ?? "-70%"}, ${p.translateY ?? "0%"})`,
        color: color,
      }}
    />
  );
}

function removedLabel(p: TimeMachineIconCheckboxProps): string {
  const value = p.oldCtx?.value;
  if (value == null)
    return "";
  return p.type != null ? Enum.niceName(p.type, value as never) : `${value}`;
}
