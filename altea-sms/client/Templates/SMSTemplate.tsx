import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import { useForceUpdate, useAPI, useThrottle } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import TemplateControls from "@altea/altea-templating/client/TemplateControls";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import { SMSTemplateMessage, type SMSTemplateEntity, type SMSTemplateEntity_Message } from "../../data/SMS";
import { SMSClient } from "../SMSClient";

// Port of Signum.SMS's Templates/SMSTemplate.tsx — the template editor: what query / model it renders
// against, who it goes to, and the per-culture texts with a live remaining-character count.
//
// altea divergences:
//  - the messages repeater is rendered even WITHOUT a query (Signum gates it on `ctx.value.query`), because a
//    query-less template is a legitimate shape here too — `SMSLogic.createSMSMessage` has a whole branch for
//    it (a per-culture text with no replacements). Signum's gate leaves such a template un-editable.
//  - `EntityTabRepeater` binds `@part` ROWS (see data/SMS.ts), so each tab's ctx is the row entity.
export default function SMSTemplate(p: { ctx: TypeContext<SMSTemplateEntity> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx.subCtx({ labelColumns: 3 });
    const ctx8 = p.ctx.subCtx({ labelColumns: 8 });

    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(a => a.name)} />
            <div className="row">
                <div className="col-sm-8">
                    <AutoLine ctx={ctx.subCtx(a => a.isActive)} />
                    <EntityLine ctx={ctx.subCtx(a => a.query)} onChange={forceUpdate}
                        remove={ctx.value.messages.length > 0 || ctx.value.to != null} />
                    <EntityCombo ctx={ctx.subCtx(a => a.model)} />
                    <AutoLine ctx={ctx.subCtx(a => a.from)} />
                    {ctx.value.query &&
                        <QueryTokenEmbeddedBuilder
                            ctx={ctx.subCtx(a => a.to)}
                            queryKey={ctx.value.query.key}
                            subTokenOptions={SubTokensOptions.CanElement}
                            helpText="Expression pointing to an SMSOwnerData" />}
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx8.subCtx(a => a.messageLengthExceeded)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.certified)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.editableMessage)} />
                    <AutoLine ctx={ctx8.subCtx(a => a.removeNoSMSCharacters)} onChange={forceUpdate} />
                    <AutoLine ctx={ctx8.subCtx(a => a.disableAuthorization)} />
                </div>
            </div>

            <EntityTabRepeater ctx={ctx.subCtx(a => a.messages)} onChange={forceUpdate} getComponent={sc =>
                <SMSTemplateMessageComponent ctx={sc}
                    queryKey={ctx.value.query?.key}
                    removeNoSMSCharacters={ctx.value.removeNoSMSCharacters}
                    invalidate={forceUpdate} />} />
        </div>
    );
}

export interface SMSTemplateMessageComponentProps {
    ctx: TypeContext<SMSTemplateEntity_Message>;
    queryKey: string | undefined;
    removeNoSMSCharacters: boolean;
    invalidate: () => void;
}

export function SMSTemplateMessageComponent(p: SMSTemplateMessageComponentProps): React.JSX.Element {

    const forceUpdate = useForceUpdate();

    // The count is a SERVER call (the GSM rules live there so the two halves cannot disagree), so it is
    // throttled to one per second of typing — Signum's same shape.
    const throttledText = useThrottle(p.ctx.value.message ?? "", 1000);
    const remaining = useAPI(() => SMSClient.API.getRemainingCharacters(throttledText, p.removeNoSMSCharacters),
        [throttledText, p.removeNoSMSCharacters], { avoidReset: true });

    const ec = p.ctx.subCtx({ labelColumns: { sm: 1 } });

    return (
        <div className="sf-sms-template-message">
            <EntityCombo ctx={ec.subCtx(e => e.culture)} onChange={p.invalidate} valueColumns={3} />
            <div>
                <TemplateControls queryKey={p.queryKey} forHtml={false} />
                <AutoLine ctx={ec.subCtx(a => a.message)} onChange={forceUpdate}
                    formGroupStyle="SrOnly" formGroupHtmlAttributes={{ className: "pt-2" }}
                    helpText={
                        <span className={remaining == null ? "" : remaining < 0 ? "text-danger" : remaining < 20 ? "text-warning" : "text-success"}>
                            {SMSTemplateMessage._0CharactersRemainingBeforeReplacements.niceToString(remaining == null ? "…" : String(remaining))}
                        </span>} />
            </div>
        </div>
    );
}
