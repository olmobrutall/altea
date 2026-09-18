import { test, describe, afterEach } from "vitest";
import assert from "node:assert/strict";
import { Temporal, type int } from "@altea/altea/data/basics";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { Clock } from "@altea/altea/data/utils/clock";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { DeleteLogParametersEmbedded, DeleteLogsTypeOverridesEmbedded } from "@altea/altea/data/deleteLogs";

// The RETENTION ARITHMETIC of the log cleanup, which is the half a DB test would never reach: which
// types are swept at all, how a per-type override answers, and what "0 days" means. DB-free by
// construction — the cut-off is a pure function of the clock and the rows.

function typeEntity(id: number, cleanName: string): TypeEntity {
    const type = TypeEntity.create({ tableName: cleanName, cleanName, className: cleanName });
    type.id = id as PrimaryKey;
    return type;
}

const operationLog = typeEntity(1, "OperationLog");
const viewLog = typeEntity(2, "ViewLog");

function parameters(...overrides: DeleteLogsTypeOverridesEmbedded[]): DeleteLogParametersEmbedded {
    return DeleteLogParametersEmbedded.create({ deleteLogs: overrides });
}

function override(type: TypeEntity, olderThan: number | null, withExceptionsOlderThan: number | null): DeleteLogsTypeOverridesEmbedded {
    return DeleteLogsTypeOverridesEmbedded.create({
        type: type.toLite(),
        deleteLogsOlderThan: olderThan as int | null,
        deleteLogsWithExceptionsOlderThan: withExceptionsOlderThan as int | null,
    });
}

describe("DeleteLogParametersEmbedded", () => {

    afterEach(() => { Clock.overridenNow = undefined; });

    test("a type with no override is never swept", () => {
        const p = parameters(override(viewLog, 30, 10));

        assert.equal(p.getDateLimitDelete(operationLog), null);
        assert.equal(p.getDateLimitDeleteWithExceptions(operationLog), null);
    });

    test("the cut-off is midnight N days back, so it does not drift between chunks", () => {
        Clock.overridenNow = Temporal.PlainDateTime.from("2026-03-20T14:35:12");
        const p = parameters(override(operationLog, 180, 60));

        assert.equal(p.getDateLimitDelete(operationLog)!.toString(), "2025-09-21T00:00:00");
        assert.equal(p.getDateLimitDeleteWithExceptions(operationLog)!.toString(), "2026-01-19T00:00:00");
    });

    test("0 days means the start of THIS hour, not this instant", () => {
        Clock.overridenNow = Temporal.PlainDateTime.from("2026-03-20T14:35:12");
        const p = parameters(override(operationLog, 0, 0));

        assert.equal(p.getDateLimitDelete(operationLog)!.toString(), "2026-03-20T14:00:00");
        assert.equal(p.getDateLimitDeleteWithExceptions(operationLog)!.toString(), "2026-03-20T14:00:00");
    });

    test("a null limit on one half leaves that half alone", () => {
        Clock.overridenNow = Temporal.PlainDateTime.from("2026-03-20T14:35:12");
        const p = parameters(override(operationLog, 30, null));

        assert.equal(p.getDateLimitDelete(operationLog)!.toString(), "2026-02-18T00:00:00");
        assert.equal(p.getDateLimitDeleteWithExceptions(operationLog), null);
    });

    test("each type reads its OWN override", () => {
        Clock.overridenNow = Temporal.PlainDateTime.from("2026-03-20T00:00:00");
        const p = parameters(override(operationLog, 10, 5), override(viewLog, 2, 1));

        assert.equal(p.getDateLimitDelete(operationLog)!.toString(), "2026-03-10T00:00:00");
        assert.equal(p.getDateLimitDelete(viewLog)!.toString(), "2026-03-18T00:00:00");
    });

    test("two overrides for the same type are a validation error", () => {
        const p = parameters(override(operationLog, 30, 10), override(operationLog, 5, 1));

        assert.match(String(entityIntegrityCheck(p, "Saving")?.errors["deleteLogs"]), /repeated/i);
    });

    test("keeping exception rows LONGER than ordinary ones is a validation error", () => {
        const o = override(operationLog, 10, 20);

        assert.match(String(entityIntegrityCheck(o, "Saving")?.errors["deleteLogsOlderThan"]), /greater than/i);
    });
});
