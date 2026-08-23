import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { Button, Tab, Tabs } from "react-bootstrap";
import * as AppContext from "@altea/altea/client/AppContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { FormatJson } from "@altea/altea/client/Exceptions/Exception";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { DiffDocument } from "@altea/altea-diff-log/client/Templates/DiffDocument";
import { RestLogMessage, type RestLogEntity } from "../../data/Rest";
import { RestClient } from "../RestClient";

// Port of Signum.Rest's Templates/RestLog.tsx — the logged request, and the replay: send it again to a
// host of the user's choosing and diff the new response against the stored one.
//
// altea divergences:
//  - **the "how long ago" unit is dropped.** Signum decorates `startDate` with luxon's `toRelative()`;
//    altea's dates are `Temporal` and core has no relative formatter, so the absolute value stands alone.
//  - **`queryString` is a `@part` collection** (see data/Rest.ts), so the EntityTable binds rows directly
//    rather than through Signum's MList element wrapper.
export default function RestLog(p: { ctx: TypeContext<RestLogEntity> }): React.JSX.Element {

    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: 4 });

    const [replayResult, setReplayResult] = React.useState<string | undefined>(undefined);
    const [replayUrl, setReplayUrl] = React.useState<string>(() => replayUrlOf(ctx.value));

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(f => f.startDate)} />
            <AutoLine ctx={ctx.subCtx(f => f.endDate)} />
            <EntityLine ctx={ctx.subCtx(f => f.user)} />
            <AutoLine ctx={ctx.subCtx(f => f.url)} unit={ctx.value.httpMethod ?? undefined} />

            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.controller)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.controllerName)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.action)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.machineName)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.applicationName)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.userHostAddress)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.userHostName)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx4.subCtx(f => f.referrer)} /></div>
            </div>

            <EntityLine ctx={ctx.subCtx(f => f.exception)} />

            <AutoLine ctx={ctx.subCtx(f => f.replayDate)} />
            <AutoLine ctx={ctx.subCtx(f => f.changedPercentage)} />

            <EntityTable ctx={ctx.subCtx(f => f.queryString)} avoidFieldSet />

            {ctx.value.allowReplay &&
                <div className="row mt-2">
                    <div className="col-sm-10">
                        <input type="text" className="form-control" value={replayUrl}
                            onChange={e => setReplayUrl(e.currentTarget.value)} />
                    </div>
                    <div className="col-sm-2">
                        <Button variant="info"
                            onClick={() => RestClient.API.replayRestLog(String(ctx.value.id), replayUrl).then(setReplayResult)}>
                            {RestLogMessage.Replay.niceToString()}
                        </Button>
                    </div>
                </div>}

            <fieldset>
                <legend>{ctx.subCtx(f => f.requestBody.text).niceName()}</legend>
                <FormatJson code={ctx.value.requestBody.text} />
            </fieldset>

            <fieldset>
                <legend>{ctx.subCtx(f => f.responseBody).niceName()}</legend>
                <Tabs defaultActiveKey="prev" id="restLogs">
                    <Tab title={RestLogMessage.Previous.niceToString()} eventKey="prev" className="linkTab">
                        <FormatJson code={ctx.value.responseBody.text} />
                    </Tab>
                    {replayResult != undefined &&
                        <Tab title={RestLogMessage.Difference.niceToString()} eventKey="diff" className="linkTab">
                            <DiffDocument first={ctx.value.responseBody.text ?? ""} second={replayResult} />
                        </Tab>}
                    {replayResult != undefined &&
                        <Tab title={RestLogMessage.Current.niceToString()} eventKey="curr" className="linkTab">
                            <FormatJson code={replayResult} />
                        </Tab>}
                </Tabs>
            </fieldset>
        </div>
    );
}

/** The absolute url this request would be re-sent to — the app's own host by default, editable above. */
function replayUrlOf(log: RestLogEntity): string {
    const prefix = AppContext.toAbsoluteUrl("/");
    const query = (log.queryString ?? []).map(q => `${q.key}=${q.value ?? ""}`).join("&");
    const port = window.location.port === "" ? "" : ":" + window.location.port;
    const base = `${window.location.protocol}//${window.location.hostname}${port}${prefix.beforeLast("/")}${log.url}`;
    return query === "" ? base : `${base}?${query}`;
}
