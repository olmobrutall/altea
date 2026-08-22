import type * as React from 'react';
import type { PseudoType } from './Reflection';
import type { Entity } from '../data/entity';
import type { Lite } from '../data/lite';
import { Symbol } from '../data/symbol';
import { TourTriggerSymbol } from '../data/tourTrigger';

// Port of Signum's `TourButton` (Signum/React/TourButton.tsx) — the framework-level EXTENSION POINT for
// tour buttons.
//
// A module (or an application page) can place a `<TourButton trigger={…} />` next to any section and
// declare a {@link TourTriggerSymbol} for it, without depending on the optional @altea/altea-tour package.
// altea-tour installs the real renderer in `TourClient.start`; with the module absent the button renders
// nothing, which is why the seam is worth having in core at all.
export function TourButton(p: { trigger: PseudoType | Symbol | Lite<Entity>; className?: string }): React.ReactNode {

    if (TourButtonOptions.renderer == null)
        return null;

    // A trigger symbol that never made it into the symbol table (the module is not started, or the
    // trigger was never registered) has no id and cannot be a filter value — so there is no tour to find.
    if (p.trigger instanceof TourTriggerSymbol && p.trigger.id == null)
        return null;

    return TourButtonOptions.renderer(p.trigger, p.className);
}

export const TourButtonOptions = {
    renderer: null as ((trigger: PseudoType | Symbol | Lite<Entity>, className?: string) => React.ReactNode) | null,
};
