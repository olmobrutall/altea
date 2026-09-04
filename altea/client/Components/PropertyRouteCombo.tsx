import * as React from "react";
import { PropertyRoute } from "../../data/propertyRoute";
import { tryGetTypeInfo } from "../Reflection";
import { PropertyRouteEntity } from "../../data/propertyRouteEntity";
import type { TypeEntity } from "../../data/typeEntity";
import type { TypeContext } from "../TypeContext";
import { FormGroup } from "../Lines/FormGroup";

// Port of Signum's `@framework/Components/PropertyRouteCombo` — a <select> over the property routes of a
// root type. Two consumers ask a user to pick a route by hand: the tour editor's "Property" css step and
// the dynamic-validation designer's sub-entity.
//
// The bound value is a `PropertyRouteEntity`, and the one this builds is deliberately NEW: a client cannot
// know the row's id, so the server's `AfterDeserialization` hook snaps it onto the row that already exists
// (and leaves it new when there is none, which is what creates the row on demand). Hence the `type` prop —
// a route row references its root TypeEntity, so the type's NAME alone is not enough.

export interface PropertyRouteComboProps {
    ctx: TypeContext<PropertyRouteEntity | null>;
    /** The root type whose routes are offered (Signum's same prop). */
    type: TypeEntity | undefined | null;
    /** Restrict the offered routes (Signum's same prop). Default: every route of the type. */
    routes?: PropertyRoute[];
    onChange?: () => void;
}

export default function PropertyRouteCombo(p: PropertyRouteComboProps): React.JSX.Element {

    const paths = React.useMemo(() => {
        if (p.routes != null)
            return p.routes.map(pr => pr.propertyString()).filter(s => s !== "").orderBy(s => s);

        const ti = p.type == null ? undefined : tryGetTypeInfo(p.type.cleanName);
        if (ti?.ctor == null)
            return [];
        return PropertyRoute.generateRoutes(ti.ctor)
            .map(pr => pr.propertyString())
            .filter(s => s !== "")
            .orderBy(s => s);
    }, [p.type, p.routes]);

    return (
        <FormGroup ctx={p.ctx}>
            {id => (
                <select id={id} className="form-select form-select-sm" value={p.ctx.value?.path ?? ""}
                    disabled={p.ctx.readOnly}
                    onChange={e => {
                        const path = e.currentTarget.value;
                        p.ctx.value = path === "" || p.type == null ? null
                            : PropertyRouteEntity.create({ path, rootType: p.type });
                        p.ctx.frame?.entityComponent?.forceUpdate?.();
                        p.onChange?.();
                    }}>
                    <option value="">-</option>
                    {paths.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
            )}
        </FormGroup>
    );
}
