import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import type { Lite } from "@altea/altea/data/lite";
import { OperationLogEntity } from "@altea/altea/data/operationLog";

// Port of Signum.DiffLog's DiffLogClient.tsx — registers the OperationLog view (which is what makes the diff
// tabs appear) and the two chain-walking calls.
//
// altea divergences:
//  - `Navigator.addSettings(new EntitySettings(…))` → `cb.configure(…).withView(…)`.
//  - `AuthAdminClient.registerQueryAuditorToken(OperationLogEntity, token(a => a.target), FilteringByTarget)`
//    is NOT ported: altea's auth-rules admin has no auditor-token registry, and the type condition it pairs
//    with has no altea counterpart either (see data/DiffLog.ts).
//  - `ChangeLogClient.registerChangeLogModule` is not ported (altea has no change-log module).
export namespace DiffLogClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(OperationLogEntity)
            .withView(() => import("./Templates/OperationLog"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.target),
                    token(a => a.operation),
                    token(a => a.user),
                    token(a => a.start),
                    token(a => a.end),
                    token(a => a.exception),
                ],
            }));
    }

    export namespace API {
        export function getPreviousOperationLog(id: string | number): Promise<PreviousLog | null> {
            return ajaxGet({ url: "/api/diffLog/previous/" + id });
        }

        export function getNextOperationLog(id: string | number): Promise<NextLog> {
            return ajaxGet({ url: "/api/diffLog/next/" + id });
        }
    }

    export interface PreviousLog {
        operationLog: Lite<OperationLogEntity>;
        dump: string | null;
    }

    export interface NextLog {
        operationLog?: Lite<OperationLogEntity>;
        dump: string | null;
    }
}
