import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { cleanTypeName, isLegacyMode, resolveCleanType } from "@altea/altea/data/registration";
import { FilterValueResult } from "./IFilterValueConverter";

// Port of Signum.UserAssets' SimpleMemberEvaluator — the member path after "[CurrentEntity]" /
// "[CurrentUser]", evaluated on the entity the expression starts from: `[CurrentUser][UserDepartmentMixin].Department`.
// Each part is a `[Mixin]`, a `(Type)` cast, or a field / parameterless method; an entity result becomes
// its lite.
export namespace SimpleMemberEvaluator {

    /** The member path after `key`, or null when `expression` does not start with it. */
    export function memberPath(expression: string, key: string): string[] | null {
        if (!expression.startsWith(key))
            return null;

        return expression.slice(key.length).trim().split(".").filter(p => p !== "");
    }

    /** Signum's `EvaluateExpression`. */
    export function evaluate(root: BaseEntity, parts: string[]): FilterValueResult<unknown> {
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
}
