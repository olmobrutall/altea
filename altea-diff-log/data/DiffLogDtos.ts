import type { Lite } from "@altea/altea/data/lite";
import type { OperationLogEntity } from "@altea/altea/data/operationLog";

export interface PreviousLog {
    operationLog: Lite<OperationLogEntity>;
    dump: string | null;
}

export interface NextLog {
    operationLog?: Lite<OperationLogEntity>;
    dump: string | null;
}
