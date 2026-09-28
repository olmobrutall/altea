import type { Entity } from "@altea/altea/data/entity";
import { CurrentUser } from "@altea/altea/data/security";
import {
    FilterValueResult, type FilterValueTarget, type IFilterValueConverter,
} from "./IFilterValueConverter";
import { SimpleMemberEvaluator } from "./SimpleMemberEvaluator";

// Port of Signum.UserAssets' CurrentUserConverter — "[CurrentUser]", optionally followed by a member path
// evaluated on the logged-in user (see SimpleMemberEvaluator).
//
// The bare form needs only the ambient lite (`CurrentUser`, both tiers). A member path needs the whole
// entity, which only a tier holding one can answer — see `getCurrentUserEntity`.
//
// DIVERGENCE — the toString direction does not turn the current user's lite back into "[CurrentUser]", for
// the reason SmartDateTimeFilterValueConverter gives: the filter editor's value↔expression toggle makes that
// the user's choice, and `stringifyFilterValue` has callers that are not stored filters.

const currentUserKey = "[CurrentUser]";

export const CurrentUserConverter: IFilterValueConverter & {
    /** Signum's `GetCurrentUserEntity`. The client installs `AppContext.currentUser`; while unset, a member
     *  path is an error rather than a filter that silently means something else. */
    getCurrentUserEntity: (() => Entity | undefined) | undefined;
} = {

    getCurrentUserEntity: undefined,

    tryGetExpression(_value: unknown, _target: FilterValueTarget): FilterValueResult<string | null> | null {
        return null;
    },

    tryParseExpression(expression: string, _target: FilterValueTarget): FilterValueResult<unknown> | null {
        const parts = SimpleMemberEvaluator.memberPath(expression, currentUserKey);
        if (parts == null)
            return null;

        if (parts.length == 0)
            return FilterValueResult.success(CurrentUser.current()?.user);

        const getEntity = CurrentUserConverter.getCurrentUserEntity;
        if (getEntity == null)
            return FilterValueResult.error(`'${expression}' needs the current user entity, which this tier does not hold`);

        const user = getEntity();
        return user == null ? FilterValueResult.success(undefined) : SimpleMemberEvaluator.evaluate(user, parts);
    },

    isValidExpression(expression: string, _target: FilterValueTarget): FilterValueResult<string> | null {
        const parts = SimpleMemberEvaluator.memberPath(expression, currentUserKey);
        if (parts == null)
            return null;

        const user = CurrentUserConverter.getCurrentUserEntity?.();
        if (parts.length == 0 || user == null)
            return FilterValueResult.success(expression);

        const r = SimpleMemberEvaluator.evaluate(user, parts);
        return r.ok ? FilterValueResult.success(expression) : FilterValueResult.error(r.error);
    },
};
