import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { ValidationMessage } from "@altea/altea/data/validators";
import type { QueryEntity } from "@altea/altea/data/queryEntity";
import TemplateControls from "@altea/altea-templating/client/TemplateControls";
import QueryTokenEmbeddedBuilder from "@altea/altea-user-assets/client/Templates/QueryTokenEmbeddedBuilder";
import FilterBuilderEmbedded from "@altea/altea-user-queries/client/Templates/FilterBuilderEmbedded";
import {
    EmailAddressSourceEnum, EmailMessageFormatEnum, EmailTemplateEntity, EmailTemplateEntity_From, EmailTemplateEntity_Message,
    EmailTemplateEntity_Recipient, EmailTemplateMessage, EmailTemplateViewMessage,
} from "../../data/EmailTemplate";
import IFrameRenderer from "./IframeRenderer";

// Port of Signum.Mailing's Templates/EmailTemplate.tsx — the template editor: recipients, attachments, the
// query (filters / orders), applicability, and one message per culture.
//
// altea divergences, documented inline:
//  - `HtmlCodeMirror` / `HtmlEditor` (Signum.CodeMirror / Signum.HtmlEditor) are not ported: BOTH html
//    formats author into a plain <TextAreaLine/>, with the same live <IFrameRenderer/> preview beside it.
//  - The APPLICABLE tab edited a C# script through CSharpCodeMirror; altea's applicable is a
//    TemplateApplicableSymbol, so it is an EntityLine on the main form instead of a tab.
//  - `EntityAccordion` is not ported, so the recipients use `EntityRepeater`. The per-culture MESSAGES keep
//    Signum's `EntityTabRepeater` — it is ported into altea core as part of this module's work.
//  - `ctx.value.query!.key` guards are unchanged — a token editor needs a query.

export default function EmailTemplate(p: { ctx: TypeContext<EmailTemplateEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const ctx3 = ctx.subCtx({ labelColumns: { sm: 3 } });
    const ecXs = ctx.subCtx({ labelColumns: { sm: 2 }, formSize: "xs" });
    const canAggregate = ctx.value.groupResults ? SubTokensOptions.CanAggregate : 0;

    return (
        <div>
            <AutoLine ctx={ctx3.subCtx(e => e.name)} />
            <EntityCombo ctx={ctx3.subCtx(e => e.model)} />
            <EntityLine ctx={ctx3.subCtx(e => e.query)} mandatory="warning" onChange={forceUpdate}
                remove={ctx.value.from == undefined
                    && ctx.value.recipients.length === 0
                    && ctx.value.messages.length === 0} />
            <EntityLine ctx={ctx3.subCtx(e => e.applicable)} onChange={forceUpdate}
                helpText={EmailTemplateApplicableHelp} />

            <div className="mb-4">
                <Tabs id={ctx.prefix + "tabs"}>
                    <Tab eventKey="recipients" title={ctx.niceName(a => a.recipients)}>
                        <EntityDetail ctx={ecXs.subCtx(e => e.from)} onChange={forceUpdate}
                            onCreate={() => Promise.resolve(EmailTemplateEntity_From.create({}))}
                            getComponent={fctx => <EmailTemplateFrom ctx={fctx} query={ctx.value.query} />} />

                        <h3 className="text-muted h5">{ecXs.niceName(s => s.recipients)}</h3>
                        <EntityRepeater ctx={ecXs.subCtx(s => s.recipients)} avoidFieldSet onChange={forceUpdate}
                            onCreate={() => Promise.resolve(EmailTemplateEntity_Recipient.create({}))}
                            getComponent={rctx => <EmailTemplateRecipient ctx={rctx} query={ctx.value.query} />} />
                    </Tab>

                    <Tab eventKey="attachments" title={
                        <span style={{ fontWeight: ctx.value.attachments.length > 0 ? "bold" : undefined }}>
                            {ctx.niceName(a => a.attachments)}
                        </span>}>
                        {/* Each row holds the attachment RULE in its @valueField (altea has no MList of a
                            polymorphic reference — see data/EmailTemplate.ts), so the row renders its value. */}
                        <EntityRepeater ctx={ecXs.subCtx(e => e.attachments)} avoidFieldSet onChange={forceUpdate}
                            getComponent={actx => <EntityDetail ctx={actx.subCtx(a => a.attachment)} />} />
                    </Tab>

                    {ctx.value.query != null &&
                        <Tab eventKey="query" title={
                            <span style={{ fontWeight: ctx.value.groupResults || ctx.value.filters.length > 0 || ctx.value.orders.length > 0 ? "bold" : undefined }}>
                                {ctx.niceName(a => a.query)}
                            </span>}>
                            <div className="row">
                                <div className="col-sm-4">
                                    <CheckboxLine ctx={ctx3.subCtx(e => e.disableAuthorization)} inlineCheckbox />
                                </div>
                                <div className="col-sm-4">
                                    <CheckboxLine ctx={ctx3.subCtx(e => e.groupResults)} inlineCheckbox onChange={forceUpdate} />
                                </div>
                            </div>

                            <FilterBuilderEmbedded ctx={ctx.subCtx(e => e.filters)} onChanged={forceUpdate}
                                subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | canAggregate}
                                queryKey={ctx.value.query.key} />

                            <EntityTable ctx={ctx.subCtx(e => e.orders)} onChange={forceUpdate} columns={[
                                {
                                    property: a => a.token,
                                    template: octx => <QueryTokenEmbeddedBuilder
                                        ctx={octx.subCtx(a => a.token, { formGroupStyle: "SrOnly" })}
                                        queryKey={ctx.value.query!.key}
                                        subTokenOptions={SubTokensOptions.CanElement | canAggregate} />,
                                },
                                { property: a => a.orderType },
                            ]} />
                        </Tab>}
                </Tabs>
            </div>

            <div className="row mb-3">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx3.subCtx(e => e.messageFormat, { labelColumns: 4 })} onChange={forceUpdate} />
                </div>
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx3.subCtx(e => e.editableMessage)} inlineCheckbox />
                </div>
            </div>

            <EntityLine ctx={ctx.subCtx(e => e.masterTemplate, { labelColumns: 2 })} />

            <div className="sf-email-replacements-container">
                <EntityTabRepeater ctx={ctx.subCtx(a => a.messages, { labelColumns: { sm: 2 } })} onChange={forceUpdate}
                    onCreate={() => Promise.resolve(EmailTemplateEntity_Message.create({}))}
                    getComponent={ctxMsg =>
                        <EmailTemplateMessageComponent ctx={ctxMsg} queryKey={ctx.value.query?.key}
                            messageFormat={ctx.value.messageFormat} invalidate={forceUpdate} />} />
            </div>
        </div>
    );
}

const EmailTemplateApplicableHelp = "A code-registered predicate (TemplatingLogic.registerApplicable) that decides whether this template applies to a given entity. Leave empty to apply always.";

function EmailTemplateFrom(p: { ctx: TypeContext<EmailTemplateEntity_From>; query: QueryEntity | null }): React.JSX.Element {
    const sc = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const forceUpdate = useForceUpdate();

    return (
        <div className="row">
            <div className="col-sm-2">
                <FormGroup label={nicePropertyNameOf("from")} ctx={sc}>
                    {() => <span className={sc.formControlClass}>{nicePropertyNameOf("from")}</span>}
                </FormGroup>
            </div>
            <div className="col-sm-2">
                <AutoLine ctx={sc.subCtx(a => a.addressSource)} onChange={() => {
                    sc.value.token = null; sc.value.emailAddress = null; sc.value.displayName = null; forceUpdate();
                }} />
            </div>
            <div className="col-sm-8">
                <AddressBody ctx={sc} query={p.query} onChange={forceUpdate} extraHardcoded={
                    <AutoLine ctx={sc.subCtx(c => c.azureUserId)} onChange={forceUpdate} />} />
            </div>
        </div>
    );
}

function EmailTemplateRecipient(p: { ctx: TypeContext<EmailTemplateEntity_Recipient>; query: QueryEntity | null }): React.JSX.Element {
    const sc = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const forceUpdate = useForceUpdate();

    return (
        <div className="row">
            <div className="col-sm-2">
                <AutoLine ctx={sc.subCtx(a => a.kind)} />
            </div>
            <div className="col-sm-2">
                <AutoLine ctx={sc.subCtx(a => a.addressSource)} onChange={() => {
                    sc.value.token = null; sc.value.emailAddress = null; sc.value.displayName = null; forceUpdate();
                }} />
            </div>
            <div className="col-sm-8">
                <AddressBody ctx={sc} query={p.query} onChange={forceUpdate} />
            </div>
        </div>
    );
}

/** The half of a From / Recipient row that depends on its `addressSource` (the shared part of Signum's two
 *  nearly identical components). */
function AddressBody(p: {
    ctx: TypeContext<EmailTemplateEntity_From | EmailTemplateEntity_Recipient>;
    query: QueryEntity | null;
    onChange: () => void;
    extraHardcoded?: React.ReactNode;
}): React.JSX.Element {
    const sc = p.ctx;

    return (
        <>
            {sc.value.addressSource === EmailAddressSourceEnum.QueryToken && (p.query == null
                ? <p className="text-danger">{ValidationMessage._0IsNotSet.niceToString(nicePropertyNameOf("query"))}</p>
                : <div>
                    <QueryTokenEmbeddedBuilder
                        ctx={sc.subCtx(a => a.token)}
                        queryKey={p.query.key}
                        subTokenOptions={SubTokensOptions.CanElement}
                        onTokenChanged={p.onChange} />
                    <div className="row">
                        <div className="col-sm-6">
                            <AutoLine ctx={sc.subCtx(c => (c as EmailTemplateEntity_Recipient).whenNone)} />
                        </div>
                        <div className="col-sm-6">
                            <AutoLine ctx={sc.subCtx(c => (c as EmailTemplateEntity_Recipient).whenMany)} />
                        </div>
                    </div>
                </div>)}

            {sc.value.addressSource === EmailAddressSourceEnum.HardcodedAddress && <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={sc.subCtx(c => c.emailAddress)} onChange={p.onChange} />
                    {p.extraHardcoded}
                </div>
                <div className="col-sm-6">
                    <AutoLine ctx={sc.subCtx(c => c.displayName)} onChange={p.onChange} />
                </div>
            </div>}
        </>
    );
}

export interface EmailTemplateMessageComponentProps {
    ctx: TypeContext<EmailTemplateEntity_Message>;
    queryKey: string | null | undefined;
    messageFormat: EmailMessageFormatEnum;
    invalidate: () => void;
}

export function EmailTemplateMessageComponent(p: EmailTemplateMessageComponentProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const [showPreview, setShowPreview] = React.useState(false);

    const isHtml = p.messageFormat !== EmailMessageFormatEnum.PlainText;
    const ec = p.ctx.subCtx({ labelColumns: { sm: 2 } });

    return (
        <div className="sf-email-template-message">
            <AutoLine ctx={ec.subCtx(e => e.culture)} label={EmailTemplateViewMessage.Language.niceToString()}
                onChange={p.invalidate} />
            <br />
            <div>
                <TemplateControls queryKey={p.queryKey} forHtml={isHtml} />
                <AutoLine ctx={ec.subCtx(e => e.subject)} formGroupStyle="SrOnly" placeholderLabels />
                <TextAreaLine ctx={ec.subCtx(e => e.text)} formGroupStyle="SrOnly"
                    valueHtmlAttributes={{ className: "sf-email-htmlbody" }}
                    onChange={() => { if (showPreview) forceUpdate(); }} />
                <br />
                {isHtml &&
                    <button type="button" className="btn btn-link p-0" onClick={e => { e.preventDefault(); setShowPreview(!showPreview); }}>
                        {showPreview
                            ? EmailTemplateMessage.HidePreview.niceToString()
                            : EmailTemplateMessage.ShowPreview.niceToString()}
                    </button>}
                {showPreview && <IFrameRenderer style={{ width: "100%", minHeight: "800px" }} html={ec.value.text} />}
            </div>
        </div>
    );
}

/** The localized label of an EmailTemplate property (altea has no `nicePropertyName` static: the label comes
 *  from the reflection registry's member descriptions, with the de-camelCased name as the fallback). */
function nicePropertyNameOf(member: "query" | "from"): string {
    return EmailTemplateEntity.nicePropertyName(member);
}
