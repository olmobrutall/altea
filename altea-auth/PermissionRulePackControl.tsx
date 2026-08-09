import * as React from "react";
import { Button } from "react-bootstrap";
import { TypeContext } from "@altea/altea/client/TypeContext";
import type { IRenderButtons, ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { Operations } from "@altea/altea/client/Operations";
import { Finder } from "@altea/altea/client/Finder";
import { isGraphModified } from "@altea/altea/data/changes";
import type { PermissionRulePack, PermissionAllowedRule } from "./Rules.data";
import { AuthAdminMessage } from "./AuthMessages.data";
import { AuthAdminClient } from "./AuthAdminClient";
import { RoleEntity } from "./Role.data";
import { GrayCheckbox } from "./ColoredRadios";

// Port of Signum's PermissionRulePackControl (Rules/PermissionRulePackControl.tsx). The VIEW component for
// the PermissionRulePack ModelEntity, opened as a FrameModal via Navigator.view from the Role QuickLink —
// the same in-place-Save flow as TypeRulePackControl (renderButtons Save/Reset/Switch-to via IRenderButtons;
// Save posts the pack, refetches, reloads the frame). The permission dimension has no DB/UI split and no
// conditions, so each row is a single Allowed checkbox + the "overridden" indicator.

export default function PermissionRulePackControl({ ctx, ref }: { ctx: TypeContext<PermissionRulePack>; ref?: React.Ref<IRenderButtons> }): React.JSX.Element {

    const dirty = React.useRef(false);
    React.useEffect(() => { dirty.current = false; }, [ctx.value]);
    const updateFrame = (): void => { ctx.frame!.frameComponent.forceUpdate(); };
    const setAllowed = (rule: PermissionAllowedRule, v: boolean): void => { rule.allowed = v; dirty.current = true; updateFrame(); };

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
        void AuthAdminClient.API.savePermissionRulePack(pack)
            .then(() => AuthAdminClient.API.fetchPermissionRulePack(pack.role.id!))
            .then(newPack => { Operations.notifySuccess(); bc.frame.onReload({ entity: newPack, canExecute: {} }); });
    }
    function handleResetClick(bc: ButtonsContext): void {
        void AuthAdminClient.API.fetchPermissionRulePack(ctx.value.role.id!)
            .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
    }
    function handleSwitchToClick(bc: ButtonsContext): void {
        void Finder.find(RoleEntity).then(r => {
            if (!r) return;
            void AuthAdminClient.API.fetchPermissionRulePack(r.id!)
                .then(newPack => bc.frame.onReload({ entity: newPack, canExecute: {} }));
        });
    }

    return (
        <div>
            <div className="form-compact mb-2">
                <EntityLine ctx={ctx.subCtx(f => f.role)} readOnly={true} />
                <AutoLine ctx={ctx.subCtx(f => f.strategy)} readOnly={true} />
            </div>
            <table className="table table-sm table-hover sf-auth-rules" style={{ maxWidth: "40rem" }}>
                <thead>
                    <tr>
                        <th>Permission</th>
                        <th className="text-center">{AuthAdminMessage.Allowed.niceToString()}</th>
                        <th className="text-center">{AuthAdminMessage.Overriden.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {ctx.value.rules.map(rule => (
                        <tr key={String(rule.resource.id)}>
                            <td>{rule.resource.toString()}</td>
                            <td className="text-center">
                                <input type="checkbox" className="form-check-input" checked={rule.allowed} disabled={ctx.readOnly}
                                    onChange={e => setAllowed(rule, e.currentTarget.checked)} />
                            </td>
                            <td className="text-center">
                                <GrayCheckbox readOnly={ctx.readOnly} checked={rule.allowed !== rule.allowedBase}
                                    onUnchecked={() => setAllowed(rule, rule.allowedBase)} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
