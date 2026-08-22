import * as React from "react";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";

// Port of Signum's `@framework/Components/PropertyRouteCombo` — a <select> over every property route of a
// root type. Signum keeps it in the framework; altea has no other consumer, so it lives here until one
// appears (the tour editor is the only place that asks a user to pick a route by hand).
//
// altea divergences: Signum binds a `PropertyRouteEntity` (a row in a routes table); altea has no such
// table — a route is its `propertyString()` (the same key altea-auth's RulePropertyEntity uses), so the
// bound value is a plain string.

export interface PropertyRouteComboProps {
    /** The line's context — its value is the route's `propertyString()`, or null. */
    ctx: TypeContext<string | null>;
    /** The clean name of the root type whose routes are offered. */
    rootTypeName: string | undefined | null;
    onChange?: () => void;
}

export default function PropertyRouteCombo(p: PropertyRouteComboProps): React.JSX.Element {

    const routes = React.useMemo(() => {
        const ti = p.rootTypeName == null ? undefined : tryGetTypeInfo(p.rootTypeName);
        if (ti?.ctor == null)
            return [];
        return PropertyRoute.generateRoutes(ti.ctor)
            .map(pr => pr.propertyString())
            .filter(s => s !== "")
            .orderBy(s => s);
    }, [p.rootTypeName]);

    return (
        <FormGroup ctx={p.ctx}>
            {id => (
                <select id={id} className="form-select form-select-sm" value={p.ctx.value ?? ""}
                    disabled={p.ctx.readOnly}
                    onChange={e => {
                        p.ctx.value = e.currentTarget.value === "" ? null : e.currentTarget.value;
                        p.ctx.frame?.entityComponent?.forceUpdate?.();
                        p.onChange?.();
                    }}>
                    <option value="">-</option>
                    {routes.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
            )}
        </FormGroup>
    );
}
