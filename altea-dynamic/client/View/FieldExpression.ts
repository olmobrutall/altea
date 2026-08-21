import { PropertyRoute } from "@altea/altea/data/propertyRoute";

// The one thing this package needs out of Signum.Eval: `TypeHelpComponent.getExpression`, which turns a
// stored property PATH into the JavaScript expression that reads it. Signum.Eval is the Roslyn host and does
// not port (see server/DynamicLogic.server.ts), so the function is re-homed here under a name that says what
// it does. It is used in two places: `NodeUtils.asFieldFunction` (the runtime accessor a node's `field`
// resolves to) and `CodeContext.subCtxCode` (the generated source the "Show code" modal prints).
//
// altea divergences:
//  - Signum's `mode` parameter has a "CSharp" branch, for the panel that generates C# from a view. Nothing
//    generates C# here, so the only mode is TypeScript and the parameter is gone.
//  - a MIXIN step (`[SomeMixin]`) becomes `.mixin(SomeMixin)` — altea's mixin accessor, a typed cast, where
//    Signum has `getMixin(e, SomeMixin)` / `e.mixins["SomeMixin"]`. Note this needs the mixin CLASS in
//    scope, which is true inside a generated snippet only when the app's modules expose it; that is the same
//    constraint Signum's `stronglyTypedMixinTS` form has.
//  - Signum lowercases each step (`curr.firstLower()`) because its C# properties are PascalCase and its TS
//    members are camelCase. altea's members are camelCase in BOTH tiers, so a stored path is already correct
//    — but the lowercasing is KEPT, because a path pasted from a Signum view (or typed by someone used to
//    one) would otherwise silently read `undefined`. Lowercasing an already-camelCase name is a no-op.
export function getFieldExpression(initial: string, pr: PropertyRoute | string): string {

    const path = pr instanceof PropertyRoute ? pr.propertyString() : pr;

    return path.split(".").reduce((prev, curr) => {
        if (curr.startsWith("[") && curr.endsWith("]")) {
            const mixin = curr.slice(1, -1);
            return `${prev}.mixin(${mixin})`;
        }

        return `${prev}.${firstLower(curr)}`;
    }, initial);
}

function firstLower(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}
