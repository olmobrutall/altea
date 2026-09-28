import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Statics, type IContextVariable } from "@altea/altea/data/utils/context";
import {
    FilterValueResult, type FilterValueTarget, type IFilterValueConverter,
} from "./IFilterValueConverter";
import { SimpleMemberEvaluator } from "./SimpleMemberEvaluator";

// Port of Signum.UserAssets' CurrentEntityConverter — "[CurrentEntity]", optionally followed by a member path
// (see SimpleMemberEvaluator), evaluated on the entity a stored query / chart is being RUN FOR: the one a
// quick-link or a dashboard scopes it to.
//
// That entity is an AMBIENT value, as in Signum (`SetCurrentEntity` over a thread variable): whoever parses
// a stored filter tree for an entity wraps the parse in `withCurrentEntity`. It may be a thin lite — enough
// for the bare form; a member path needs the entity itself (the entity, or a fat lite).
//
// DIVERGENCE — the toString direction does not turn the current entity back into "[CurrentEntity]", for the
// reason CurrentUserConverter gives.

const currentEntityKey = "[CurrentEntity]";

let currentEntityVar: IContextVariable<Entity | Lite<Entity>> | undefined;
function currentEntityVariable(): IContextVariable<Entity | Lite<Entity>> {
    return currentEntityVar ??= Statics.newContextVariable<Entity | Lite<Entity>>();
}

export const CurrentEntityConverter: IFilterValueConverter & {
    /** Signum's `SetCurrentEntity`: run `fn` with "[CurrentEntity]" meaning `entity`. `fn` must be synchronous
     *  on the browser (see IContextVariable). With no entity, `fn` simply runs. */
    withCurrentEntity<R>(entity: Entity | Lite<Entity> | null | undefined, fn: () => R): R;
} = {

    withCurrentEntity<R>(entity: Entity | Lite<Entity> | null | undefined, fn: () => R): R {
        return entity == null ? fn() : currentEntityVariable().withValue(entity, fn);
    },

    tryGetExpression(_value: unknown, _target: FilterValueTarget): FilterValueResult<string | null> | null {
        return null;
    },

    tryParseExpression(expression: string, _target: FilterValueTarget): FilterValueResult<unknown> | null {
        const parts = SimpleMemberEvaluator.memberPath(expression, currentEntityKey);
        if (parts == null)
            return null;

        const current = currentEntityVariable().getValue();
        if (current == null)
            return FilterValueResult.success(undefined);

        if (parts.length == 0)
            return FilterValueResult.success(current instanceof Lite ? current : current.toLite());

        if (!(current instanceof Lite))
            return SimpleMemberEvaluator.evaluate(current, parts);

        const entity = current.entityOrNull;
        if (entity == null)
            return FilterValueResult.error(`'${expression}' needs the current entity, but only its lite (${current.key()}) is known`);

        return SimpleMemberEvaluator.evaluate(entity, parts);
    },

    isValidExpression(expression: string, _target: FilterValueTarget): FilterValueResult<string> | null {
        return SimpleMemberEvaluator.memberPath(expression, currentEntityKey) == null
            ? null
            : FilterValueResult.success(expression);
    },
};
