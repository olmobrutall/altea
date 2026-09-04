import { WebBuilder, CustomType } from "./webApi";
import { ChangeLogLogic } from "./changeLogLogic";

// Port of Signum's Basics/ChangeLogController.cs — the two calls the navbar's change-log button makes.
//
// Mounted by the framework's own server, where Signum's controller lives.
//
// altea divergences:
//  - the date crosses the wire as an ISO STRING (`Temporal.PlainDateTime.toString()`), which is what
//    Signum's `DateTime?` serializes to anyway — and the client compares it as a PlainDateTime.
//  - `updateLastDate` answers null rather than void, because altea's typed route wrapper describes every
//    response by a shape.
//  - both are AUTHENTICATED (the default), and both no-op for an anonymous caller rather than failing —
//    the navbar renders on the login screen too (see ChangeLogLogic).
export namespace ChangeLogServer {
    export function start(ws: WebBuilder): void {

        ws.get("/api/changelog/getLastDate",
            { res: CustomType<string | null>() },
            async (_req, res) => {
                const date = await ChangeLogLogic.getLastDate();
                res.jsonTyped(date == undefined ? null : date.toString());
            });

        ws.post("/api/changelog/updateLastDate",
            { req: CustomType<null>(), res: CustomType<null>() },
            async (_req, res) => {
                await ChangeLogLogic.updateLastDate();
                res.jsonTyped(null);
            });
    }
}
