import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { EvalPanelPermission } from "@altea/altea-eval/data/EvalPanelPermission";
import type { DynamicCompilationStatus } from "../data/DynamicPanel";
import { DynamicLogic } from "./DynamicLogic";

// The server half of Signum.Dynamic's DynamicPanelCodeGenPage — "did the dynamic code compile, and if not
// why", which is the one thing an author cannot work without: a definition that fails to compile leaves the
// server running WITHOUT its dynamic types (see DynamicLogic.codeGenError), and the diagnostics only exist
// in the process that tried.
//
// Signum reads the same state through its EvalPanel controller (`GetCompilationErrors`,
// `GetLastCodeGenAssemblyFileInfo`, …). altea has no assembly, so what is worth reporting is the generated
// FILES and the diagnostics, which is what this answers.
export namespace DynamicPanelServer {

    export function start(ws: WebBuilder): void {

        ws.get("/api/dynamic/compilationStatus",
            { res: CustomType<DynamicCompilationStatus>() },
            async (_req, res) => {
                await assertAuthorized();

                res.jsonTyped({
                    error: DynamicLogic.codeGenError?.message,
                    written: DynamicLogic.lastCompilation?.written ?? [],
                    // The code-gen directory, so the page can say where the source is. An author reading a
                    // diagnostic wants the file it names.
                    codeGenDirectory: DynamicLogic.codeGenDirectoryOrNull(),
                });
            });
    }

    async function assertAuthorized(): Promise<void> {
        if (!(await PermissionLogic.isAuthorized(EvalPanelPermission.ViewDynamicPanel)))
            throw new UnauthorizedAccessException(
                `Not authorized for '${EvalPanelPermission.ViewDynamicPanel.key}'`);
    }
}
