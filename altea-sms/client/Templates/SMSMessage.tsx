import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { SMSMessageState, type SMSMessageEntity } from "../../data/SMS";

// Port of Signum.SMS's Templates/SMSMessage.tsx. Once a message has left `Created` almost everything is
// read-only — it is a record of what was sent, not a draft.
export default function SMSMessage(p: { ctx: TypeContext<SMSMessageEntity> }): React.JSX.Element {

    const ctx4 = p.ctx.subCtx({ labelColumns: 4, formSize: "xs" });
    const isCreated = p.ctx.value.state === SMSMessageState.Created;

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx4.subCtx(a => a.from)} readOnly={!isCreated} />
                    <AutoLine ctx={ctx4.subCtx(a => a.destinationNumber)} readOnly={!isCreated} />
                    <AutoLine ctx={ctx4.subCtx(a => a.certified)} readOnly={!isCreated} />
                    <EntityLine ctx={ctx4.subCtx(a => a.referred)} readOnly={true} />
                </div>
                <div className="col-sm-6">
                    <AutoLine ctx={ctx4.subCtx(a => a.messageID)} readOnly={true} />
                    <EntityLine ctx={ctx4.subCtx(a => a.template)} readOnly={true} />
                    {!isCreated &&
                        <div>
                            <AutoLine ctx={ctx4.subCtx(a => a.sendDate)} readOnly={true} />
                            <AutoLine ctx={ctx4.subCtx(a => a.state)} readOnly={true} />
                        </div>}
                </div>
            </div>

            <AutoLine ctx={p.ctx.subCtx(a => a.message)}
                readOnly={!(p.ctx.value.editableMessage || isCreated)}
                formGroupHtmlAttributes={{ className: "sf-sms-msg-text" }} />
        </div>
    );
}
