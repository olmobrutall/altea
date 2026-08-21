import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import {
    EmailMasterTemplateEntity, EmailMasterTemplateEntity_Message, EmailTemplateMessage, EmailTemplateViewMessage,
} from "../../data/EmailTemplate";
import HtmlCodeMirror from "@altea/altea-codemirror/client/HtmlCodeMirror";
import IFrameRenderer from "./IframeRenderer";

// Port of Signum.Mailing's Templates/EmailMasterTemplate.tsx — the shared chrome a template's body is
// spliced into at `@[content]`.
export default function EmailMasterTemplate(p: { ctx: TypeContext<EmailMasterTemplateEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(f => f.name)} />
            <AutoLine ctx={ctx.subCtx(f => f.isDefault)} />
            <Tabs id={ctx.prefix + "tabs"}>
                <Tab eventKey="messages" title={ctx.niceName(a => a.messages)}>
                    {/* One TAB per culture (Signum's EntityTabRepeater): the messages are alternatives the
                        user reads one at a time, and each carries a whole HTML editor + preview. */}
                    <EntityTabRepeater ctx={ctx.subCtx(a => a.messages)} avoidFieldSet onChange={forceUpdate}
                        onCreate={() => Promise.resolve(EmailMasterTemplateEntity_Message.create({}))}
                        getComponent={ctxMsg => <EmailMasterTemplateMessageComponent ctx={ctxMsg} invalidate={forceUpdate} />} />
                </Tab>
                <Tab eventKey="attachments" title={ctx.niceName(a => a.attachments)}>
                    {/* The row holds the attachment RULE in its @valueField (see data/EmailTemplate.ts). */}
                    <EntityRepeater ctx={ctx.subCtx(e => e.attachments)} avoidFieldSet onChange={forceUpdate}
                        getComponent={actx => <EntityDetail ctx={actx.subCtx(a => a.attachment)} />} />
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
            <HtmlCodeMirror ctx={ec.subCtx(e => e.text)}
                onChange={() => { if (showPreview) forceUpdate(); }} />
            <br />
            <button type="button" className="btn btn-link p-0" onClick={() => setShowPreview(!showPreview)}>
                {showPreview ? EmailTemplateMessage.HidePreview.niceToString() : EmailTemplateMessage.ShowPreview.niceToString()}
            </button>
            {showPreview && <IFrameRenderer style={{ width: "100%", minHeight: "800px" }} html={ec.value.text} />}
        </div>
    );
}
