import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import type { FileTypeSymbol } from "@altea/altea-files/data/Files";
import type { ProcessEntity } from "@altea/altea-processes/data/Processes";
import { PrintPermission, type PrintStat } from "../data/Printing";
import { PrintingLogic } from "./PrintingLogic.server";

// Port of Signum.Printing's PrintController.cs — the two routes the print panel calls.
//
// ALTEA: both are gated by `PrintPermission.ViewPrintPanel`. Signum gates only the panel's omnibox entry and
// leaves the endpoints open to any authenticated user, which is a gap rather than a decision: `createProcess`
// packages and QUEUES work.
export namespace PrintingServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/printing/stats",
            { res: CustomType<PrintStat[]>() },
            async (_req, res) => {
                await assertAuthorized();
                return res.jsonTyped(await PrintingLogic.getReadyToPrintStats());
            });

        ws.post("/api/printing/createProcess",
            { req: CustomType<FileTypeSymbol | null>(), res: CustomType<ProcessEntity | null>() },
            async (req, res) => {
                await assertAuthorized();
                const fileType = await req.jsonTyped();
                return res.jsonTyped(await PrintingLogic.createProcess(fileType));
            });
    }

    async function assertAuthorized(): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(PrintPermission.ViewPrintPanel)))
            throw new UnauthorizedAccessException(`Not authorized for '${PrintPermission.ViewPrintPanel.key}'`);
    }
}
