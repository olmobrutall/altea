import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { AlertEntity, AlertMessage, AlertState } from "../../data/Alert";
import { AlertsClient } from "../AlertsClient";

// Port of Signum.Alerts' Templates/Alert.tsx. The one interesting bit is the TEXT: a saved alert shows its
// text RENDERED (placeholders expanded into links, through the same `AlertsClient.format` the dropdown uses)
// with an "Edit" affordance that swaps in the raw textarea.
export default function Alert(p: { ctx: TypeContext<AlertEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const [edit, setEdit] = React.useState(false);

    const ctx = p.ctx.subCtx({ labelColumns: { sm: 2 } });

    return (
        <div>
            {!ctx.value.isNew &&
                <div>
                    <EntityLine ctx={ctx.subCtx(e => e.createdBy)} readOnly />
                    <AutoLine ctx={ctx.subCtx(e => e.creationDate)} readOnly />
                </div>}

            <div className="row">
                <div className="col-sm-6">
                    {ctx.value.target && <EntityLine ctx={ctx.subCtx(a => a.target)} readOnly labelColumns={4} />}
                </div>
                <div className="col-sm-6">
                    {ctx.value.linkTarget && <EntityLine ctx={ctx.subCtx(a => a.linkTarget)} readOnly labelColumns={4} />}
                    {ctx.value.groupTarget && <EntityLine ctx={ctx.subCtx(a => a.groupTarget)} readOnly labelColumns={4} />}
                </div>
            </div>

            <EntityLine ctx={ctx.subCtx(a => a.recipient)} />
            <hr />

            <EntityCombo ctx={ctx.subCtx(a => a.alertType)} onChange={forceUpdate} />
            <AutoLine ctx={ctx.subCtx(a => a.alertDate)} />
            <TextBoxLine ctx={ctx.subCtx(a => a.titleField)} label={AlertMessage.Title.niceToString()}
                valueHtmlAttributes={{
                    placeholder: (ctx.value.alertType && AlertsClient.getTitle(null, ctx.value.alertType)) ?? undefined,
                }} />

            {!ctx.value.isNew && !edit
                ? <FormGroup ctx={ctx.subCtx(a => a.titleField)} label={AlertMessage.Text.niceToString()}>
                    {() => <div style={{ whiteSpace: "pre-wrap" }}>
                        {AlertsClient.format(ctx.value.textField || ctx.value.textFromAlertType || "", ctx.value)}
                        <br />
                        <button type="button" className="btn btn-link btn-sm p-0 text-muted"
                            onClick={() => setEdit(true)}>Edit</button>
                    </div>}
                </FormGroup>
                : <TextAreaLine ctx={ctx.subCtx(a => a.textField)} label={AlertMessage.Text.niceToString()}
                    valueHtmlAttributes={{ style: { height: "180px" } }} />}

            {ctx.value.state === AlertState.Attended &&
                <div>
                    <hr />
                    <AutoLine ctx={ctx.subCtx(a => a.attendedDate)} readOnly />
                    <EntityLine ctx={ctx.subCtx(a => a.attendedBy)} readOnly />
                </div>}
        </div>
    );
}
