import * as React from "react";
import { Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { Operations } from "@altea/altea/client/Operations";
import { Finder } from "@altea/altea/client/Finder";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { isGraphModified } from "@altea/altea/data/changes";
import type { Lite } from "@altea/altea/data/lite";
import {
    TypeAllowed, TypeAllowedBasic, TypeAllowedRule, ConditionRuleModel, WithConditionsModel,
    TypeConditionSymbol, typeAllowedDB, typeAllowedUI, typeAllowedCreate,
} from "./Rules.data";
import type { TypeRulePack } from "./Rules.data";
import { AuthAdminMessage } from "./AuthMessages.data";
import { AuthAdminClient } from "./AuthAdminClient";
import { RoleEntity } from "./Role.data";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";

// Port of Signum's TypeRulePackControl (Rules/TypeRulePackControl.tsx). The VIEW component for the
// TypeRulePack ModelEntity, opened as a FrameModal via Navigator.view from the Role QuickLink. Each type
// row shows the FALLBACK Write/Read/None radios (driving `rule.allowed.fallback`) + the "overridden"
// checkbox; below it, one sub-row per CONDITION rule (an AND-ed set of TypeConditionSymbols → its own
// Write/Read/None radios). A type with registered `availableConditions` gets a "+" to add a condition
// (a multi-select of its symbols); each condition sub-row has a "×" to remove it. Save posts the pack,
// refetches, and reloads the frame (Signum's IRenderButtons in-place Save).
//
// Deferred vs Signum: drag-reorder of condition rules (order still comes from add order; last matches
// win), the namespace grouping + filter box, and the property/operation/query thumbnail drill-down links.

const BASICS: { basic: TypeAllowedBasic; color: string; label: string }[] = [
    { basic: TypeAllowedBasic.Write, color: "green", label: "Write" },
    { basic: TypeAllowedBasic.Read, color: "#FFAD00", label: "Read" },
    { basic: TypeAllowedBasic.None, color: "red", label: "None" },
];

function isActive(allowed: TypeAllowed, basic: TypeAllowedBasic): boolean {
    return typeAllowedDB(allowed) === basic || typeAllowedUI(allowed) === basic;
}
function combine(a: TypeAllowedBasic, b: TypeAllowedBasic): TypeAllowed {
    return typeAllowedCreate(Math.max(a, b) as TypeAllowedBasic, Math.min(a, b) as TypeAllowedBasic);
}
// A plain click sets both DB+UI; shift/ctrl-click toggles one level to build/collapse a mixed DBxUIy value.
function select(current: TypeAllowed, basic: TypeAllowedBasic, e: React.MouseEvent<unknown>): TypeAllowed {
    if (!(e.shiftKey || e.ctrlKey))
        return typeAllowedCreate(basic, basic);
    const db = typeAllowedDB(current), ui = typeAllowedUI(current);
    if (db !== ui) {
        if (basic === ui) return typeAllowedCreate(db, db);
        if (basic === db) return typeAllowedCreate(ui, ui);
        return current;
    }
    return basic !== db ? combine(db, basic) : current;
}

const shortKey = (l: Lite<TypeConditionSymbol>): string => {
    const s = l.toString();
    const dot = s.indexOf(".");
    return dot >= 0 ? s.substring(dot + 1) : s;
};
const condSetKey = (tcs: Lite<TypeConditionSymbol>[]): string => tcs.map(l => String(l.id)).sort().join("&");

// Structural fallback+conditions equality (Signum's withConditionsEquals) — drives the "overridden" flag.
function withConditionsEquals(a: WithConditionsModel, b: WithConditionsModel): boolean {
    if (a.fallback !== b.fallback || a.conditionRules.length !== b.conditionRules.length)
        return false;
    return a.conditionRules.every((cr, i) => {
        const bcr = b.conditionRules[i];
        return cr.allowed === bcr.allowed && condSetKey(cr.typeConditions) === condSetKey(bcr.typeConditions);
    });
}
function cloneModel(m: WithConditionsModel): WithConditionsModel {
    return WithConditionsModel.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => ConditionRuleModel.create({ typeConditions: [...cr.typeConditions], allowed: cr.allowed })),
    });
}

export default function TypeRulePackControl({ ctx, ref }: { ctx: TypeContext<TypeRulePack>; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

    const dirty = React.useRef(false);
    React.useEffect(() => { dirty.current = false; }, [ctx.value]);
    const markDirty = (): void => { dirty.current = true; ctx.frame!.frameComponent.forceUpdate(); };

    function renderButtons(bc: ButtonsContext): ButtonBarElement[] {
        const hasChanges = dirty.current || isGraphModified(bc.pack.entity);
        return [
            { button: <Button type="button" variant="primary" disabled={!hasChanges || ctx.readOnly} onClick={() => handleSaveClick(bc)}>{AuthAdminMessage.Save.niceToString()}</Button> },
            { button: <Button type="button" variant="warning" disabled={!hasChanges || ctx.readOnly} onClick={() => handleResetClick(bc)}>{AuthAdminMessage.ResetChanges.niceToString()}</Button> },
            { button: <Button type="button" variant="info" disabled={hasChanges} onClick={() => handleSwitchToClick(bc)}>{AuthAdminMessage.SwitchTo.niceToString()}</Button> },
        ];
    }
    React.useImperativeHandle(ref, () => ({ renderButtons }), [ctx.value]);

    function handleSaveClick(bc: ButtonsContext): void {
        const pack = ctx.value;
        void AuthAdminClient.API.saveTypeRulePack(pack)
            .then(() => AuthAdminClient.API.fetchTypeRulePack(pack.role.id!))
            .then(newPack => { Operations.notifySuccess(); bc.frame.onReload({ entity: newPack, canExecute: {} }); });
    }
    function handleResetClick(bc: ButtonsContext): void {
        void AuthAdminClient.API.fetchTypeRulePack(ctx.value.role.id!)
            .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
    }
    function handleSwitchToClick(bc: ButtonsContext): void {
        void Finder.find(RoleEntity).then(r => {
            if (!r) return;
            void AuthAdminClient.API.fetchTypeRulePack(r.id!)
                .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
        });
    }

    async function addCondition(rule: TypeAllowedRule): Promise<void> {
        const chosen = await SelectorModal.chooseManyElement(rule.availableConditions, {
            buttonDisplay: shortKey,
            title: AuthAdminMessage.TypeRules.niceToString(),
            message: "Select the type condition(s) that must ALL hold for this rule to apply.",
        });
        if (chosen == null || chosen.length === 0)
            return;
        const key = condSetKey(chosen);
        if (rule.allowed.conditionRules.some(cr => condSetKey(cr.typeConditions) === key))
            return; // repeated condition set — ignore (Signum shows an error modal)
        rule.allowed.conditionRules.push(ConditionRuleModel.create({ typeConditions: chosen, allowed: TypeAllowed.None }));
        markDirty();
    }
    function removeCondition(rule: TypeAllowedRule, cr: ConditionRuleModel): void {
        rule.allowed.conditionRules = rule.allowed.conditionRules.filter(x => x !== cr);
        markDirty();
    }

    // A Write/Read/None radio bound to a TypeAllowed getter/setter (the fallback, or a condition's allowed).
    const renderRadio = (get: () => TypeAllowed, set: (v: TypeAllowed) => void, basic: TypeAllowedBasic, color: string): React.JSX.Element => {
        const allowed = get();
        const active = isActive(allowed, basic);
        const dbEq = typeAllowedDB(allowed) === basic, uiEq = typeAllowedUI(allowed) === basic;
        const niceName = TypeAllowedBasic[basic];
        const title = !active || (dbEq && uiEq) ? niceName
            : dbEq ? AuthAdminMessage._0InDB.niceToString(niceName) : AuthAdminMessage._0InUI.niceToString(niceName);
        const icon: IconProp | undefined = !active || (dbEq && uiEq) ? undefined : dbEq ? "database" : "window-restore";
        return <ColorRadio checked={active} title={title} color={color} icon={icon} readOnly={ctx.readOnly}
            onClicked={e => { set(select(get(), basic, e)); markDirty(); }} />;
    };

    return (
        <div>
            <div className="form-compact mb-2">
                <EntityLine ctx={ctx.subCtx(f => f.role)} readOnly={true} />
                <AutoLine ctx={ctx.subCtx(f => f.strategy)} readOnly={true} />
            </div>
            <table className="table table-sm table-hover sf-auth-rules" style={{ maxWidth: "44rem" }}
                aria-label={AuthAdminMessage.TypePermissionOverview.niceToString()}>
                <thead>
                    <tr>
                        <th>Type</th>
                        {BASICS.map(b => <th key={b.label} className="text-center">{b.label}</th>)}
                        <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {ctx.value.rules.map(rule => [
                        <tr key={String(rule.resource.id)}>
                            <td>
                                {!ctx.readOnly && rule.availableConditions.length > 0 &&
                                    <LinkButton className="me-2" title="Add condition" onClick={() => void addCondition(rule)}>
                                        <FontAwesomeIcon aria-hidden={true} icon="circle-plus" />
                                    </LinkButton>}
                                {rule.resource.toString()}
                            </td>
                            {BASICS.map(b => <td key={b.label} className="text-center">
                                {renderRadio(() => rule.allowed.fallback, v => rule.allowed.fallback = v, b.basic, b.color)}
                            </td>)}
                            <td className="text-center">
                                <GrayCheckbox readOnly={ctx.readOnly} checked={!withConditionsEquals(rule.allowed, rule.allowedBase)}
                                    onUnchecked={() => { rule.allowed = cloneModel(rule.allowedBase); markDirty(); }} />
                            </td>
                        </tr>,
                        ...rule.allowed.conditionRules.map((cr, i) => (
                            <tr key={String(rule.resource.id) + "_c" + i} className="table-active">
                                <td className="ps-4">
                                    {!ctx.readOnly &&
                                        <LinkButton className="me-2" title="Remove condition" onClick={() => removeCondition(rule, cr)}>
                                            <FontAwesomeIcon aria-hidden={true} icon="circle-minus" />
                                        </LinkButton>}
                                    <small>{cr.typeConditions.map(shortKey).join(" & ")}</small>
                                </td>
                                {BASICS.map(b => <td key={b.label} className="text-center">
                                    {renderRadio(() => cr.allowed, v => cr.allowed = v, b.basic, b.color)}
                                </td>)}
                                <td />
                            </tr>
                        )),
                    ])}
                </tbody>
            </table>
        </div>
    );
}
