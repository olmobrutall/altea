import * as React from "react";
import { Button } from "react-bootstrap";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { Operations } from "@altea/altea/client/Operations";
import { Finder } from "@altea/altea/client/Finder";
import type { QueryRulePack, QueryAllowedRule } from "../../data/Rules";
import { QueryAllowed } from "../../data/Rules";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { RoleEntity } from "../../data/Role";
import { ColorRadio, GrayCheckbox } from "./ColoredRadios";

// Port of Signum's QueryRulePackControl (Rules/QueryRulePackControl.tsx). The VIEW for the QueryRulePack
// ModelEntity (per role × type): each row = one query of the type, with Allow (green) / EmbeddedOnly
// (amber) / None (red) coloured radios + the "overridden" checkbox. Same in-place Save/Reset/Switch-to
// flow as the other rule packs.

const LEVELS: { value: QueryAllowed; color: string; label: string }[] = [
    { value: QueryAllowed.Allow, color: "green", label: "Allow" },
    { value: QueryAllowed.EmbeddedOnly, color: "#FFAD00", label: "Embedded only" },
    { value: QueryAllowed.None, color: "red", label: "None" },
];

export default function QueryRulePackControl({ ctx, ref }: { ctx: TypeContext<QueryRulePack>; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

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
        void AuthAdminClient.API.saveQueryRulePack(pack)
            .then(() => AuthAdminClient.API.fetchQueryRulePack(pack.type.toString(), pack.role.id!))
            .then(newPack => { Operations.notifySuccess(); bc.frame.onReload({ entity: newPack, canExecute: {} }); });
    }
    function handleResetClick(bc: ButtonsContext): void {
        void AuthAdminClient.API.fetchQueryRulePack(ctx.value.type.toString(), ctx.value.role.id!)
            .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
    }
    function handleSwitchToClick(bc: ButtonsContext): void {
        void Finder.find(RoleEntity).then(r => {
            if (!r) return;
            void AuthAdminClient.API.fetchQueryRulePack(ctx.value.type.toString(), r.id!)
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
            <QueryRulesTable pack={ctx.value} readOnly={ctx.readOnly} markDirty={markDirty} />
        </div>
    );
}

// Just the per-type query-rules TABLE (no header) — extracted so the stacked part-closure modal
// (AuthClosureModal) can render one table per type. Queries have no conditions, so this is the simplest.
export function QueryRulesTable({ pack, readOnly, markDirty }: { pack: QueryRulePack; readOnly: boolean; markDirty: () => void }): React.JSX.Element {
    const setAllowed = (rule: QueryAllowedRule, v: QueryAllowed): void => {
        if (v > rule.coerced) return;
        rule.allowed = v; markDirty();
    };
    return (
        <table className="table table-sm table-hover sf-auth-rules" style={{ maxWidth: "40rem" }}>
            <thead>
                <tr>
                    <th>Query</th>
                    {LEVELS.map(l => <th key={l.value} className="text-center">{l.label}</th>)}
                    <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                </tr>
            </thead>
            <tbody>
                {pack.rules.map(rule => (
                    <tr key={String(rule.resource.id)}>
                        <td>{rule.resource.toString()}</td>
                        {LEVELS.map(l => <td key={l.value} className="text-center">
                            {rule.coerced >= l.value &&
                                <ColorRadio readOnly={readOnly} checked={rule.allowed === l.value} color={l.color}
                                    onClicked={() => setAllowed(rule, l.value)} />}
                        </td>)}
                        <td className="text-center">
                            <GrayCheckbox readOnly={readOnly} checked={rule.allowed !== rule.allowedBase}
                                onUnchecked={() => setAllowed(rule, rule.allowedBase)} />
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
