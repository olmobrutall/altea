import * as React from "react";
import { Button } from "react-bootstrap";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { Operations } from "@altea/altea/client/Operations";
import { Finder } from "@altea/altea/client/Finder";
import type { OperationRulePack, OperationAllowedRule, TypeConditionSymbol } from "../../data/Rules";
import { OperationAllowed, OperationConditionRuleModel } from "../../data/Rules";
import type { Lite } from "@altea/altea/data/lite";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { RoleEntity } from "../../data/Role";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";
import { type Slice, sliceBinding } from "./AuthSlice";
import { SliceSelector } from "./SliceSelector";

// Port of Signum's OperationRulePackControl. Each row = one operation of the type: Allow (green) / DBOnly
// (amber) / None (red) radios + an "overridden" checkbox. Type conditions are edited via the top-of-pack
// SLICE selector (Signum's TypeConditions <select>): pick "Fallback" or a configured condition SET, and
// every row binds to that slice. `initialTypeConditions` preselects a slice (from a type-condition drill-in).

const LEVELS: { value: OperationAllowed; color: string; label: () => string }[] = [
    { value: OperationAllowed.Allow, color: "green", label: () => AuthAdminMessage.Allow.niceToString() },
    { value: OperationAllowed.DBOnly, color: "#FFAD00", label: () => "DB only" },
    { value: OperationAllowed.None, color: "red", label: () => AuthAdminMessage.Deny.niceToString() },
];

const makeCR = (typeConditions: Lite<TypeConditionSymbol>[], allowed: OperationAllowed): OperationConditionRuleModel =>
    OperationConditionRuleModel.create({ typeConditions, allowed });

export default function OperationRulePackControl({ ctx, initialTypeConditions, ref }: { ctx: TypeContext<OperationRulePack>; initialTypeConditions?: Lite<TypeConditionSymbol>[]; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

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
        void AuthAdminClient.API.saveOperationRulePack(pack)
            .then(() => AuthAdminClient.API.fetchOperationRulePack(pack.type.toString(), pack.role.id!))
            .then(newPack => { Operations.notifySuccess(); bc.frame.onReload({ entity: newPack, canExecute: {} }); });
    }
    function handleResetClick(bc: ButtonsContext): void {
        void AuthAdminClient.API.fetchOperationRulePack(ctx.value.type.toString(), ctx.value.role.id!)
            .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
    }
    function handleSwitchToClick(bc: ButtonsContext): void {
        void Finder.find(RoleEntity).then(r => {
            if (!r) return;
            void AuthAdminClient.API.fetchOperationRulePack(ctx.value.type.toString(), r.id!)
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
            <OperationRulesTable pack={ctx.value} readOnly={ctx.readOnly} markDirty={markDirty} slice={slice} />
        </div>
    );
}

// Just the per-type operation-rules TABLE for one SLICE (no header) — extracted so the stacked part-closure
// modal can render one table per type sharing a single slice.
export function OperationRulesTable({ pack, readOnly, markDirty, slice }: { pack: OperationRulePack; readOnly: boolean; markDirty: () => void; slice: Slice }): React.JSX.Element {

    const renderRadio = (get: () => OperationAllowed, set: (v: OperationAllowed) => void, coerced: OperationAllowed, level: typeof LEVELS[number]): React.JSX.Element | null =>
        coerced < level.value ? null
            : <ColorRadio readOnly={readOnly} checked={get() === level.value} color={level.color}
                onClicked={() => { set(level.value); markDirty(); }} />;

    return (
        <table className="table table-sm table-hover sf-auth-rules" style={{ maxWidth: "40rem" }}>
            <thead>
                <tr>
                    <th>Operation</th>
                    {LEVELS.map(l => <th key={l.value} className="text-center">{l.label()}</th>)}
                    <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                </tr>
            </thead>
            <tbody>
                {pack.rules.map((rule: OperationAllowedRule) => {
                    const b = sliceBinding(rule.allowed, slice, makeCR);
                    const base = sliceBinding(rule.allowedBase, slice, makeCR);
                    return (
                        <tr key={String(rule.operation.id)}>
                            <td>{rule.operation.toString()}</td>
                            {LEVELS.map(l => <td key={l.value} className="text-center">
                                {renderRadio(b.get, b.set, rule.coerced, l)}
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
