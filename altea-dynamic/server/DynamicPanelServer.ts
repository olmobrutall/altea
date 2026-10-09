import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import type { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { EvalPanelPermission } from "@altea/altea-eval/data/EvalPanelPermission";
import {
    DynamicPanelPermission, type DynamicClientModule, type DynamicCompilationStatus, type DynamicCompileResult,
} from "../data/DynamicPanel";
import { DynamicLogic } from "./DynamicLogic";
import { StartParameters } from "@altea/altea/data/utils/startParameters";

// The server half of Signum.Dynamic's DynamicPanelCodeGenPage: the status of what this process loaded,
// an in-memory compile of the definitions as they are now, and the restart.
//
// Signum reports assemblies and their timestamps; altea has none, so the status reports generated FILES,
// and "is a restart needed" is answered by comparing the files the definitions generate now with the ones
// this process loaded (DynamicLogic.pendingChanges).
export namespace DynamicPanelServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/dynamic/compilationStatus",
            { res: CustomType<DynamicCompilationStatus>() },
            async (_req, res) => {
                await assertAuthorized(EvalPanelPermission.ViewDynamicPanel);

                res.jsonTyped({
                    error: DynamicLogic.codeGenError?.message,
                    written: DynamicLogic.lastCompilation?.written ?? [],
                    codeGenDirectory: DynamicLogic.codeGenDirectoryOrNull(),
                    pending: await DynamicLogic.pendingChanges(),
                    databaseMismatches: (StartParameters.ignoredDatabaseMismatches ?? []).map(e => e.message),
                    canRestart: DynamicLogic.restartApplication != null,
                    startedAt: DynamicLogic.startedAt.toISOString(),
                });
            });

        // Every user needs the dynamic types, not only the panel's: they are part of the client's model.
        // Empty when the server came up without them — the client must not have types the server lacks.
        ws.get("/api/dynamic/clientModules",
            { res: CustomType<DynamicClientModule[]>() },
            async (_req, res) => {
                res.jsonTyped(DynamicLogic.codeGenError != null ? [] : DynamicLogic.lastCompilation?.clientModules ?? []);
            });

        ws.post("/api/dynamic/compile",
            { res: CustomType<DynamicCompileResult>() },
            async (_req, res) => {
                await assertAuthorized(EvalPanelPermission.ViewDynamicPanel);

                const { errors, modules } = await DynamicLogic.checkDynamicCode();
                const named = new Set(errors.map(e => e.fileName));
                res.jsonTyped({
                    errors,
                    files: modules
                        .filter(m => named.has(m.fileName))
                        .map(m => ({ fileName: m.fileName, content: m.content })),
                });
            });

        ws.post("/api/dynamic/restartServer", {},
            async (_req, res) => {
                await assertAuthorized(DynamicPanelPermission.RestartApplication);

                const restart = DynamicLogic.restartApplication;
                if (restart == null)
                    throw new Error("This host has no DynamicLogic.restartApplication configured");

                // After the answer has left: the page then polls until the new process answers.
                res.on("finish", () => setTimeout(restart, 100));
                res.status(204).end();
            });
    }

    async function assertAuthorized(permission: PermissionSymbol): Promise<void> {
        if (!(await PermissionLogic.isAuthorized(permission)))
            throw new UnauthorizedAccessException(`Not authorized for '${permission.key}'`);
    }
}
