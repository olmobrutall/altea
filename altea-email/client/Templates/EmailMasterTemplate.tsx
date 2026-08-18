import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import {
    EmailMasterTemplateEntity, EmailMasterTemplateEntity_Message, EmailTemplateMessage, EmailTemplateViewMessage,
} from "../../data/EmailTemplate";
import IFrameRenderer from "./IframeRenderer";

// Port of Signum.Mailing's Templates/EmailMasterTemplate.tsx — the shared chrome a template's body is
// spliced into at `@[content]`. altea divergence: HtmlCodeMirror → a plain <TextAreaLine/> + the preview.
export default function EmailMasterTemplate(p: { ctx: TypeContext<EmailMasterTemplateEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(f => f.name)} />
            <AutoLine ctx={ctx.subCtx(f => f.isDefault)} />
            <Tabs id={ctx.prefix + "tabs"}>
                <Tab eventKey="messages" title={ctx.niceName(a => a.messages)}>
                    <EntityRepeater ctx={ctx.subCtx(a => a.messages)} avoidFieldSet onChange={forceUpdate}
                        onCreate={() => Promise.resolve(EmailMasterTemplateEntity_Message.create({}))}
                        getComponent={ctxMsg => <EmailMasterTemplateMessageComponent ctx={ctxMsg} invalidate={forceUpdate} />} />
                </Tab>
                <Tab eventKey="attachments" title={ctx.niceName(a => a.attachments)}>
                    <EntityRepeater ctx={ctx.subCtx(e => e.attachments)} avoidFieldSet onChange={forceUpdate} />
                </Tab>
            </Tabs>
        </div>
    );
}

export function EmailMasterTemplateMessageComponent(p: {
    ctx: TypeContext<EmailMasterTemplateEntity_Message>;
    invalidate: () => void;
}): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const [showPreview, setShowPreview] = React.useState(false);
    const ec = p.ctx;

    return (
        <div className="sf-email-template-message">
            <AutoLine ctx={ec.subCtx(e => e.culture)} label={EmailTemplateViewMessage.Language.niceToString()}
                onChange={p.invalidate} />
            <TextAreaLine ctx={ec.subCtx(e => e.text)} formGroupStyle="SrOnly"
                valueHtmlAttributes={{ className: "sf-email-htmlbody" }}
                onChange={() => { if (showPreview) forceUpdate(); }} />
            <br />
            <button type="button" className="btn btn-link p-0" onClick={() => setShowPreview(!showPreview)}>
                {showPreview ? EmailTemplateMessage.HidePreview.niceToString() : EmailTemplateMessage.ShowPreview.niceToString()}
            </button>
            {showPreview && <IFrameRenderer style={{ width: "100%", minHeight: "800px" }} html={ec.value.text} />}
        </div>
    );
}
