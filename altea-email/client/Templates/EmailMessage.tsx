import * as React from "react";
import { Tabs, Tab } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import HtmlCodeMirror from "@altea/altea-codemirror/client/HtmlCodeMirror";
import { EmailMessageEntity, EmailMessageStateEnum } from "../../data/EmailMessage";
import { EmailTemplateMessage } from "../../data/EmailTemplate";
import IFrameRenderer from "./IframeRenderer";

// Port of Signum.Mailing's Templates/EmailMessage.tsx — the produced message: read-only unless it is still
// Created / Draft.
//
// An HTML body is edited in <HtmlCodeMirror/> (altea-codemirror), a plain body in <TextAreaLine/>, with the
// live <IFrameRenderer/> preview below — as in Signum.
export default function EmailMessage(p: { ctx: TypeContext<EmailMessageEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const editable = p.ctx.value.state === EmailMessageStateEnum.Created || p.ctx.value.state === EmailMessageStateEnum.Draft;
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic", readOnly: editable ? undefined : true });

    return (
        <Tabs id={ctx.prefix + "emailTabs"}>
            <Tab title={EmailMessageEntity.niceName()} eventKey="mainTab">
                <fieldset>
                    <legend>{EmailMessageEntity.niceName()}</legend>
                    <div className="row">
                        <div className="col-sm-2">
                            <AutoLine ctx={ctx.subCtx(f => f.state)} />
                            <AutoLine ctx={ctx.subCtx(f => f.creationDate)} />
                        </div>
                        <div className="col-sm-2">
                            <AutoLine ctx={ctx.subCtx(f => f.sent)} hideIfNull />
                            <AutoLine ctx={ctx.subCtx(f => f.receptionNotified)} hideIfNull />
                        </div>
                        <div className="col-sm-2">
                            <AutoLine ctx={ctx.subCtx(f => f.uniqueIdentifier)} />
                            <AutoLine ctx={ctx.subCtx(f => f.bodyHash)} hideIfNull />
                        </div>
                        <div className="col-sm-2">
                            <EntityLine ctx={ctx.subCtx(f => f.sentBy)} hideIfNull />
                            <EntityLine ctx={ctx.subCtx(f => f.exception)} hideIfNull />
                        </div>
                        <div className="col-sm-4">
                            <EntityLine ctx={ctx.subCtx(f => f.target, { labelColumns: 2 })} />
                            <EntityLine ctx={ctx.subCtx(f => f.template)} />
                        </div>
                    </div>
                </fieldset>

                <EntityDetail ctx={ctx.subCtx(f => f.from)} />
                <EntityRepeater ctx={ctx.subCtx(s => s.recipients)} avoidFieldSet onChange={forceUpdate} />

                <EntityTable ctx={ctx.subCtx(e => e.attachments)} hideIfNull columns={[
                    { property: a => a.file },
                    { property: a => a.type },
                    { property: a => a.contentId },
                ]} />

                <AutoLine ctx={ctx.subCtx(f => f.subject, { labelColumns: 1 })} />
                <CheckboxLine ctx={ctx.subCtx(f => f.isBodyHtml)} inlineCheckbox onChange={forceUpdate} />
                {ctx.value.isBodyHtml
                    ? <div className="code-container">
                        <HtmlCodeMirror ctx={ctx.subCtx(f => f.body.text)} onChange={forceUpdate} />
                    </div>
                    : <TextAreaLine ctx={ctx.subCtx(f => f.body.text)} formGroupStyle="SrOnly"
                        valueHtmlAttributes={{ style: { height: "180px" } }} onChange={forceUpdate} />}

                <EmailMessageBodyPreview ctx={ctx} />
            </Tab>
        </Tabs>
    );
}

function EmailMessageBodyPreview(p: { ctx: TypeContext<EmailMessageEntity> }): React.JSX.Element {
    const [showPreview, setShowPreview] = React.useState(true);

    if (!p.ctx.value.isBodyHtml)
        return <></>;

    return (
        <div className="sf-email-template-message">
            <br />
            <button type="button" className="btn btn-link p-0" onClick={() => setShowPreview(!showPreview)}>
                {showPreview ? EmailTemplateMessage.HidePreview.niceToString() : EmailTemplateMessage.ShowPreview.niceToString()}
            </button>
            {showPreview && <IFrameRenderer style={{ width: "100%", height: "800px" }} html={p.ctx.value.body.text} />}
        </div>
    );
}
