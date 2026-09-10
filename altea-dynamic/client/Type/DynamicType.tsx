import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals/helpers";
import { DynamicTypeDefinitionComponent } from "./DynamicTypeDefinitionComponent";
import { DynamicBaseType, type DynamicTypeDefinition, type DynamicTypeEntity } from "../../data/DynamicType";
import { DynamicIsolationMixin } from "../../data/DynamicIsolation";

// Port of Signum.Dynamic's Type/DynamicType.tsx — the type designer's outer frame: the base type, the
// name, the database-mapping toggle, and the definition editor.
//
// altea divergences:
//  - a FUNCTION component with a ref-held parsed definition, where Signum uses a class with state and an
//    `IHasChanges` implementation. altea tracks changes with a SNAPSHOT of the entity graph, so the only
//    thing that has to happen is that `typeDefinition` carries the edited JSON before a save — which
//    `beforeSave` does, hung off the component handle the same way Signum's Save override calls it.
//  - an `entityHasChanges()` check (compare the serialized definition against the stored string) is
//    therefore unnecessary: writing the JSON on every edit is cheap and makes the ordinary dirty check
//    see it.

export interface DynamicTypeHandle {
    /** Flush the edited definition onto the entity. */
    beforeSave: () => void;
}

export default function DynamicTypeComponent(p: {
    ctx: TypeContext<DynamicTypeEntity>;
    ref?: React.Ref<DynamicTypeHandle>;
}): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    const [showDatabaseMapping, setShowDatabaseMapping] = React.useState(false);

    // Parsed ONCE per entity: the editor mutates this object, and `flush` writes it back.
    const definition = React.useMemo<DynamicTypeDefinition>(() => {
        if (ctx.value.typeDefinition == null || ctx.value.typeDefinition === "")
            return { entityKind: "Main", entityData: "Transactional", properties: [], queryFields: [] };

        return JSON.parse(ctx.value.typeDefinition) as DynamicTypeDefinition;
    }, [ctx.value]);

    React.useEffect(() => {
        setShowDatabaseMapping(definition.tableName != null
            || definition.properties.some(a => a.columnName != null || a.columnType != null));
    }, [definition]);

    const flush = React.useCallback(() => {
        ctx.value.typeDefinition = JSON.stringify(definition, undefined, 2);
    }, [ctx.value, definition]);

    React.useImperativeHandle(p.ref, () => ({ beforeSave: flush }), [flush]);

    // Every edit writes the JSON straight back, so the ordinary dirty check sees it and a save needs no
    // cooperation from the operation (Signum's Save override has to call beforeSave; the handle above keeps
    // that path working for a caller that wants it).
    const dc = React.useMemo(() => ({
        refreshView: () => { flush(); forceUpdate(); },
    }), [flush, forceUpdate]);

    const suffix = ctx.value.baseType === DynamicBaseType.MixinEntity ? "Mixin"
        : ctx.value.baseType === DynamicBaseType.EmbeddedEntity ? "Embedded"
            : ctx.value.baseType === DynamicBaseType.ModelEntity ? "Model" : "Entity";

    return (
        <div>
            <div className="row">
                <div className="col-sm-8">
                    <EnumLine ctx={ctx.subCtx(dt => dt.baseType)} labelColumns={3}
                        onChange={forceUpdate} readOnly={!ctx.value.isNew} />
                    <AutoLine ctx={ctx.subCtx(dt => dt.typeName)} labelColumns={3}
                        onChange={forceUpdate} unit={suffix} />

                    {/* Signum's DynamicIsolationClient does this with an `overrideView` +
                        `insertAfterLine(a => a.baseType, …)`, because the line lives in a different
                        assembly. Here it is the same package, so the line is written where it belongs —
                        and shown only when the APP declared the mixin, which is what decides whether the
                        field (and its column) exists at all. Note the MIXIN STEP in the route: altea
                        flattens a mixin's columns onto the owner, but a PropertyRoute still models the
                        step (the accommodation @altea/altea-diff-log documents). */}
                    {DynamicIsolationMixin.isDeclared() &&
                        <AutoLine labelColumns={3}
                            ctx={ctx.subCtx(dt => dt.mixin(DynamicIsolationMixin)).subCtx(m => m.isolationStrategy)} />}
                </div>
                <div className="col-sm-4">
                    <button type="button"
                        className={classes("btn btn-sm btn-success float-end", showDatabaseMapping && "active")}
                        onClick={() => setShowDatabaseMapping(!showDatabaseMapping)}>
                        Show Database Mapping
                    </button>
                </div>
            </div>

            <DynamicTypeDefinitionComponent dc={dc} dynamicType={ctx.value}
                definition={definition} showDatabaseMapping={showDatabaseMapping} />
        </div>
    );
}
