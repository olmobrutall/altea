import * as React from "react";
import { Button } from "react-bootstrap";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { Operations } from "@altea/altea/client/Operations";
import { Finder } from "@altea/altea/client/Finder";
import type { PropertyRulePack, PropertyAllowedRule, TypeConditionSymbol } from "../../data/Rules";
import { PropertyAllowed, PropertyConditionRuleModel } from "../../data/Rules";
import type { Lite } from "@altea/altea/data/lite";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { RoleEntity } from "../../data/Role";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";
import { type Slice, sliceBinding } from "./AuthSlice";
import { SliceSelector } from "./SliceSelector";

// Port of Signum's PropertyRulePackControl. Each row = one property route of the type, with Write (green)
// / Read (amber) / None (red) radios + an "overridden" checkbox. A radio above the row's `coerced` ceiling
// (the type's own UI allowance) is hidden — a property can't exceed its type. Type conditions are edited
// via the top-of-pack SLICE selector (Signum's TypeConditions <select>): pick "Fallback" or a configured
// condition SET, and every row binds to that slice (fallback value, or the matching condition rule which
// is created on first edit). `initialTypeConditions` preselects a slice (from a type-condition drill-in).

const LEVELS: { value: PropertyAllowed; color: string; label: string }[] = [
    { value: PropertyAllowed.Write, color: "green", label: "Write" },
    { value: PropertyAllowed.Read, color: "#FFAD00", label: "Read" },
    { value: PropertyAllowed.None, color: "red", label: "None" },
];

const makeCR = (typeConditions: Lite<TypeConditionSymbol>[], allowed: PropertyAllowed): PropertyConditionRuleModel =>
    PropertyConditionRuleModel.create({ typeConditions, allowed });

export default function PropertyRulePackControl({ ctx, initialTypeConditions, ref }: { ctx: TypeContext<PropertyRulePack>; initialTypeConditions?: Lite<TypeConditionSymbol>[]; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

    const dirty = React.useRef(false);
    React.useEffect(() => { dirty.current = false; }, [ctx.value]);
    const markDirty = (): void => { dirty.current = true; ctx.frame!.frameComponent.forceUpdate(); };
    const [slice, setSlice] = React.useState<Slice>(initialTypeConditions);

    function renderButtons(bc: ButtonsContext): ButtonBarElement[] {
        const hasChanges = dirty.current;
        return [
            { button: <Button type="button" variant="primary" disabled={!hasChanges || ctx.readOnly} onClick={() => handleSaveClick(bc)}>{AuthAdminMessage.Save.niceToString()}</Button> },
            { button: <Button type="button" variant="warning" disabled={!hasChanges || ctx.readOnly} onClick={() => handleResetClick(bc)}>{AuthAdminMessage.ResetChanges.niceToString()}</Button> },
            { button: <Button type="button" variant="info" disabled={hasChanges} onClick={() => handleSwitchToClick(bc)}>{AuthAdminMessage.SwitchTo.niceToString()}</Button> },
        ];
    }
    React.useImperativeHandle(ref, () => ({ renderButtons }), [ctx.value]);

    function handleSaveClick(bc: ButtonsContext): void {
        const pack = ctx.value;
        void AuthAdminClient.API.savePropertyRulePack(pack)
            .then(() => AuthAdminClient.API.fetchPropertyRulePack(pack.type.toString(), pack.role.id!))
            .then(newPack => { Operations.notifySuccess(); bc.frame.onReload({ entity: newPack, canExecute: {} }); });
    }
    function handleResetClick(bc: ButtonsContext): void {
        void AuthAdminClient.API.fetchPropertyRulePack(ctx.value.type.toString(), ctx.value.role.id!)
            .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
    }
    function handleSwitchToClick(bc: ButtonsContext): void {
        void Finder.find(RoleEntity).then(r => {
            if (!r) return;
            void AuthAdminClient.API.fetchPropertyRulePack(ctx.value.type.toString(), r.id!)
                .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
        });
    }

    return (
        <div>
            <div className="form-compact mb-2">
                <EntityLine ctx={ctx.subCtx(f => f.role)} readOnly={true} />
                <EntityLine ctx={ctx.subCtx(f => f.type)} readOnly={true} />
                <AutoLine ctx={ctx.subCtx(f => f.strategy)} readOnly={true} />
            </div>
            {ctx.value.availableTypeConditions.length > 0 &&
                <div className="mb-2 d-flex align-items-center gap-2">
                    <span className="text-muted small">Type conditions</span>
                    <SliceSelector available={ctx.value.availableTypeConditions} slice={slice} onChange={setSlice} />
                </div>}
            <PropertyRulesTable pack={ctx.value} readOnly={ctx.readOnly} markDirty={markDirty} slice={slice} />
        </div>
    );
}

// Just the per-type property-rules TABLE for one SLICE (no header / no slice picker) — extracted so the
// stacked part-closure modal (AuthClosureModal) can render one table per type sharing a single slice.
export function PropertyRulesTable({ pack, readOnly, markDirty, slice }: { pack: PropertyRulePack; readOnly: boolean; markDirty: () => void; slice: Slice }): React.JSX.Element {

    // A radio bound to a PropertyAllowed getter/setter, hidden above the row's coerced ceiling.
    const renderRadio = (get: () => PropertyAllowed, set: (v: PropertyAllowed) => void, coerced: PropertyAllowed, level: typeof LEVELS[number]): React.JSX.Element | null =>
        coerced < level.value ? null
            : <ColorRadio readOnly={readOnly} checked={get() === level.value} color={level.color}
                onClicked={() => { set(level.value); markDirty(); }} />;

    return (
        // Fixed layout + colgroup so every table has identical column geometry — when AuthClosureModal
        // stacks one table per type (owner + parts), the Property / Write / Read / None / Overridden columns
        // line up vertically instead of each table auto-sizing to its own property-name lengths.
        <table className="table table-sm table-hover sf-auth-rules" style={{ width: "40rem", tableLayout: "fixed" }}>
            <colgroup>
                <col style={{ width: "40%" }} />
                {LEVELS.map(l => <col key={l.value} style={{ width: "12%" }} />)}
                <col style={{ width: "16%" }} />
            </colgroup>
            <thead>
                <tr>
                    <th>Property</th>
                    {LEVELS.map(l => <th key={l.value} className="text-center">{l.label}</th>)}
                    <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                </tr>
            </thead>
            <tbody>
                {pack.rules.map((rule: PropertyAllowedRule) => {
                    const b = sliceBinding(rule.allowed, slice, makeCR);
                    const base = sliceBinding(rule.allowedBase, slice, makeCR);
                    // Per-slice ceiling: a None slice on the type caps this slice's radios at None.
                    const coerced = sliceBinding(rule.coerced, slice, makeCR).get();
                    return (
                        <tr key={rule.path}>
                            <td style={{ overflowWrap: "anywhere" }}>{rule.path}</td>
                            {LEVELS.map(l => <td key={l.value} className="text-center">
                                {renderRadio(b.get, b.set, coerced, l)}
                            </td>)}
                            <td className="text-center">
                                <GrayCheckbox readOnly={readOnly} checked={b.get() !== base.get()}
                                    onUnchecked={() => { b.set(base.get()); markDirty(); }} />
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}
