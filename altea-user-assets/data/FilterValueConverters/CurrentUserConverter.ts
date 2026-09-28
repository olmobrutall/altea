import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { cleanTypeName, isLegacyMode, resolveCleanType } from "@altea/altea/data/registration";
import { CurrentUser } from "@altea/altea/data/security";
import {
    FilterValueResult, type FilterValueTarget, type IFilterValueConverter,
} from "./IFilterValueConverter";

// Port of Signum.UserAssets' CurrentUserConverter — "[CurrentUser]", optionally followed by a member path
// evaluated on the logged-in user: `[CurrentUser][UserCareerMixin].OrganizationalUnit`. Each part is a
// `[Mixin]`, a `(Type)` cast, or a field / parameterless method; an entity result becomes its lite.
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
        const parts = memberPath(expression);
        if (parts == null)
            return null;

        if (parts.length == 0)
            return FilterValueResult.success(CurrentUser.current()?.user);

        const getEntity = CurrentUserConverter.getCurrentUserEntity;
        if (getEntity == null)
            return FilterValueResult.error(`'${expression}' needs the current user entity, which this tier does not hold`);

        const user = getEntity();
        return user == null ? FilterValueResult.success(undefined) : evaluate(user, parts);
    },

    isValidExpression(expression: string, _target: FilterValueTarget): FilterValueResult<string> | null {
        const parts = memberPath(expression);
        if (parts == null)
            return null;

        const user = CurrentUserConverter.getCurrentUserEntity?.();
        if (parts.length == 0 || user == null)
            return FilterValueResult.success(expression);

        const r = evaluate(user, parts);
        return r.ok ? FilterValueResult.success(expression) : FilterValueResult.error(r.error);
    },
};

/** The member path after "[CurrentUser]", or null when the expression is not one. */
function memberPath(expression: string): string[] | null {
    if (!expression.startsWith(currentUserKey))
        return null;

    return expression.slice(currentUserKey.length).trim().split(".").filter(p => p !== "");
}

// Signum's SimpleMemberEvaluator.EvaluateExpression.
function evaluate(root: Entity, parts: string[]): FilterValueResult<unknown> {
    let result: unknown = root;

    for (const part of parts) {
        if (result == null)
            return FilterValueResult.success(undefined);

        const owner = result as BaseEntity;
        if (part.startsWith("[") && part.endsWith("]")) {
            // A mixin's fields are inlined on its owner, so this only checks the declaration.
            const mixinName = part.slice(1, -1);
            const mixin = MixinDeclarations.getMixins(owner.getType()).find(m => m.name === mixinName || cleanTypeName(m) === mixinName);
            if (mixin == null)
                return FilterValueResult.error(`Mixin ${mixinName} not found on ${owner.getType().name}`);
            result = owner.mixin(mixin);
        } else if (part.startsWith("(") && part.endsWith(")")) {
            const typeName = part.slice(1, -1);
            const asType = resolveCleanType(typeName) as Type<BaseEntity> | undefined;
            if (asType == null)
                return FilterValueResult.error(`Type ${typeName} not found`);
            if (!(result instanceof asType))
                return FilterValueResult.error(`Type ${typeName} is not assignable from ${owner.getType().name}`);
        } else {
            const member = memberName(owner, part);
            if (member == null)
                return FilterValueResult.error(`Property or Method ${part} not found on ${owner.getType?.().name ?? typeof result}`);

            const v = (owner as unknown as Record<string, unknown>)[member];
            result = typeof v === "function" ? (v as () => unknown).call(owner) : v;
        }
    }

    return FilterValueResult.success(result instanceof Entity ? result.toLite() : result ?? undefined);
}

/** The member `part` names on `obj`. In legacy mode a Signum (PascalCase) name also finds its camelCase field. */
function memberName(obj: object, part: string): string | null {
    if (part in obj)
        return part;

    if (isLegacyMode()) {
        const camel = part[0].toLowerCase() + part.slice(1);
        if (camel in obj)
            return camel;
    }

    return null;
}
