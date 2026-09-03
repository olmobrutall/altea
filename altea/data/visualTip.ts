import { reflect, init } from "./reflection";
import { Entity } from "./entity";
import { Lite } from "./lite";
import { Symbol } from "./symbol";
import { entity, implementedBy, quoted } from "./decorators";
import { Temporal } from "./basics";
import { Clock } from "./utils/clock";
import { msg } from "./utils/localization";
import type { IUserEntity } from "./security";
import type { DeleteSymbol } from "./operations";

// Port of Signum's Basics/VisualTipConsumedEntity.cs — the VISUAL TIP subsystem: a small "?" beside a
// piece of UI that opens an explanation, beats gently until the user has read it once, and then stops.
//
// Two tables, and the split is the whole design: a `VisualTipSymbol` NAMES a tip (declared in code, seeded
// like any symbol — Signum's `basics.visual_tip`), and a `VisualTipConsumedEntity` row records that one
// USER has read one tip. That is why the icon can stop drawing attention per person rather than per
// deployment.
//
// It lives in the FRAMEWORK, as it does in Signum: the SearchControl itself carries four of these tips
// (`SearchVisualTip` below), so an application gets them without installing anything.
//
// altea divergence: `user` declares NO implementations (`@implementedBy(() => [])`) so core needn't
// reference altea-auth; the app overrides it to the concrete user type in its EntityOverrides — the same
// accommodation `ExceptionEntity.user` and `OperationLogEntity.user` already make.

@reflect
@entity("String", "Master", { lowPopulation: true })
export class VisualTipSymbol extends Symbol { }

@reflect
@entity("System", "Transactional")
export class VisualTipConsumedEntity extends Entity {

    visualTip: VisualTipSymbol;

    @implementedBy(() => [])
    user: Lite<IUserEntity>;

    consumedOn: Temporal.PlainDateTime = Clock.now;

    @quoted
    override toString(): string {
        return this.visualTip.key + " - " + this.user.toString();
    }
}

export namespace VisualTipConsumedOperation {
    export const Delete: DeleteSymbol<VisualTipConsumedEntity> = init();
}

/**
 * Signum's `SearchVisualTip` — the four tips the SearchControl itself carries.
 *
 * They are declared here, in core, because the controls that show them are core; `VisualTipLogic.start`
 * registers them, so an application needs no cooperation to get them.
 */
export namespace SearchVisualTip {
    export const SearchHelp: VisualTipSymbol = init();
    export const GroupHelp: VisualTipSymbol = init();
    export const FilterHelp: VisualTipSymbol = init();
    export const ColumnHelp: VisualTipSymbol = init();
}

export const VisualTipMessage = {
    Help: msg("Help"),
};
