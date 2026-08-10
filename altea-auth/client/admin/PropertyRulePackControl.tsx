import * as React from "react";
import { Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { Operations } from "@altea/altea/client/Operations";
import { Finder } from "@altea/altea/client/Finder";
import SelectorModal from "@altea/altea/client/SelectorModal";
import type { Lite } from "@altea/altea/data/lite";
import type { PropertyRulePack, PropertyAllowedRule, PropertyWithConditionsModel } from "../../data/Rules";
import { PropertyAllowed, PropertyConditionRuleModel, PropertyWithConditionsModel as WithConditionsModelClass, TypeConditionSymbol } from "../../data/Rules";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { RoleEntity } from "../../data/Role";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";

// Port of Signum's PropertyRulePackControl (Rules/PropertyRulePackControl.tsx). The VIEW for the
// PropertyRulePack ModelEntity (per role × type): each row = one property route of the type, with Write
// (green) / Read (amber) / None (red) radios bound to the `fallback` + the "overridden" checkbox. A radio
// above the row's `coerced` ceiling (the type's own UI allowance) is hidden — a property can't exceed its
// type. For a type with registered type conditions, a "+" adds a CONDITION sub-row (an AND-ed set of the
// ROOT type's TypeConditionSymbols → its own Write/Read/None), evaluated last-match-wins per instance.

const LEVELS: { value: PropertyAllowed; color: string; label: string }[] = [
    { value: PropertyAllowed.Write, color: "green", label: "Write" },
    { value: PropertyAllowed.Read, color: "#FFAD00", label: "Read" },
    { value: PropertyAllowed.None, color: "red", label: "None" },
];

const shortKey = (l: Lite<TypeConditionSymbol>): string => {
    const s = l.toString();
    const dot = s.indexOf(".");
    return dot >= 0 ? s.substring(dot + 1) : s;
};
const condSetKey = (tcs: Lite<TypeConditionSymbol>[]): string => tcs.map(l => String(l.id)).sort().join("&");

function withConditionsEquals(a: PropertyWithConditionsModel, b: PropertyWithConditionsModel): boolean {
    if (a.fallback !== b.fallback || a.conditionRules.length !== b.conditionRules.length)
        return false;
    return a.conditionRules.every((cr, i) => {
        const bcr = b.conditionRules[i];
        return cr.allowed === bcr.allowed && condSetKey(cr.typeConditions) === condSetKey(bcr.typeConditions);
    });
}
function cloneModel(m: PropertyWithConditionsModel): PropertyWithConditionsModel {
    return WithConditionsModelClass.create({
        fallback: m.fallback,
        conditionRules: m.conditionRules.map(cr => PropertyConditionRuleModel.create({ typeConditions: [...cr.typeConditions], allowed: cr.allowed })),
    });
}

export default function PropertyRulePackControl({ ctx, ref }: { ctx: TypeContext<PropertyRulePack>; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

    const dirty = React.useRef(false);
    React.useEffect(() => { dirty.current = false; }, [ctx.value]);
    const markDirty = (): void => { dirty.current = true; ctx.frame!.frameComponent.forceUpdate(); };

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

    async function addCondition(rule: PropertyAllowedRule): Promise<void> {
        const chosen = await SelectorModal.chooseManyElement(ctx.value.availableConditions, {
            buttonDisplay: shortKey,
            title: "Property rules",
            message: "Select the type condition(s) that must ALL hold for this rule to apply.",
        });
        if (chosen == null || chosen.length === 0)
            return;
        const key = condSetKey(chosen);
        if (rule.allowed.conditionRules.some(cr => condSetKey(cr.typeConditions) === key))
            return;
        rule.allowed.conditionRules.push(PropertyConditionRuleModel.create({ typeConditions: chosen, allowed: PropertyAllowed.None }));
        markDirty();
    }
    function removeCondition(rule: PropertyAllowedRule, cr: PropertyConditionRuleModel): void {
        rule.allowed.conditionRules = rule.allowed.conditionRules.filter(x => x !== cr);
        markDirty();
    }

    // A radio bound to a PropertyAllowed getter/setter, hidden above the row's coerced ceiling.
    const renderRadio = (get: () => PropertyAllowed, set: (v: PropertyAllowed) => void, coerced: PropertyAllowed, level: typeof LEVELS[number]): React.JSX.Element | null =>
        coerced < level.value ? null
            : <ColorRadio readOnly={ctx.readOnly} checked={get() === level.value} color={level.color}
                onClicked={() => { set(level.value); markDirty(); }} />;

    const hasConditions = ctx.value.availableConditions.length > 0;

    return (
        <div>
            <div className="form-compact mb-2">
                <EntityLine ctx={ctx.subCtx(f => f.role)} readOnly={true} />
                <EntityLine ctx={ctx.subCtx(f => f.type)} readOnly={true} />
                <AutoLine ctx={ctx.subCtx(f => f.strategy)} readOnly={true} />
            </div>
            <table className="table table-sm table-hover sf-auth-rules" style={{ maxWidth: "40rem" }}>
                <thead>
                    <tr>
                        <th>Property</th>
                        {LEVELS.map(l => <th key={l.value} className="text-center">{l.label}</th>)}
                        <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {ctx.value.rules.map(rule => [
                        <tr key={rule.path}>
                            <td>
                                {!ctx.readOnly && hasConditions &&
                                    <LinkButton className="me-2" title="Add condition" onClick={() => void addCondition(rule)}>
                                        <FontAwesomeIcon aria-hidden={true} icon="circle-plus" />
                                    </LinkButton>}
                                {rule.path}
                            </td>
                            {LEVELS.map(l => <td key={l.value} className="text-center">
                                {renderRadio(() => rule.allowed.fallback, v => rule.allowed.fallback = v, rule.coerced, l)}
                            </td>)}
                            <td className="text-center">
                                <GrayCheckbox readOnly={ctx.readOnly} checked={!withConditionsEquals(rule.allowed, rule.allowedBase)}
                                    onUnchecked={() => { rule.allowed = cloneModel(rule.allowedBase); markDirty(); }} />
                            </td>
                        </tr>,
                        ...rule.allowed.conditionRules.map((cr, i) => (
                            <tr key={rule.path + "_c" + i} className="table-active">
                                <td className="ps-4">
                                    {!ctx.readOnly &&
                                        <LinkButton className="me-2" title="Remove condition" onClick={() => removeCondition(rule, cr)}>
                                            <FontAwesomeIcon aria-hidden={true} icon="circle-minus" />
                                        </LinkButton>}
                                    <small>{cr.typeConditions.map(shortKey).join(" & ")}</small>
                                </td>
                                {LEVELS.map(l => <td key={l.value} className="text-center">
                                    {renderRadio(() => cr.allowed, v => cr.allowed = v, rule.coerced, l)}
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
