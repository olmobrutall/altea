import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { table, bindAndOptimize } from "@altea/altea/logic/table";
import { buildTranslateResult } from "@altea/altea/logic/linq/translatorBuilder";
import { ProjectionError } from "@altea/altea/logic/linq/ProjectionError";
import { Connector } from "@altea/altea/logic/connection/connector";
import { hasDb, start } from "./setup";
import { NoteWithDateEntity } from "../entities/music";

// altea diverges from Signum on the C# "read a SQL NULL into a non-nullable value type"
// FieldReaderException — TypeScript has no non-nullable value type, so those cases just yield
// null (see the RootMax/MinNull and SelectIntSumNullable tests). But a projector CAN still
// fail for real — e.g. a temporal column whose driver value the Temporal parser rejects — and
// when it does altea raises a ProjectionError carrying the diagnostics Signum attaches: the
// row index, the projector source, and the SQL command.
//
// This is driven against a fake row source (no real DB round-trip) so the malformed value is
// deterministic on any dialect: SQL Server hands temporal columns back as Date objects, so the
// parser's throwing string path is only reachable with a value we inject here.
describe("ProjectionErrorTest", { skip: !hasDb }, () => {
    let connector!: Connector;
    before(async () => { connector = await start(); });

    test("ProjectionError carries row, projector and SQL", async () => {
        // A real query projecting a temporal column; its projector runs the temporal
        // denormaliser per row — the production throw path.
        const q = table(NoteWithDateEntity).map(a => a.creationDate);
        const projection = bindAndOptimize(q.expression, connector.schema, connector.isPostgres);
        const tr = buildTranslateResult(projection, connector.isPostgres);
        const columnName = projection.select.columns[0].name;

        // Row 0 is a valid date; row 1 is a value Temporal.PlainDate.from rejects.
        const rows = [
            { [columnName]: new Date(Date.UTC(2001, 0, 1)) },
            { [columnName]: "not-a-date" },
        ];
        const fakeConnector = {
            isPostgres: connector.isPostgres,
            executeQuery: async () => rows,
        } as unknown as Connector;

        await Connector.withConnector(fakeConnector, async () => {
            await assert.rejects(tr.execute(), (error: unknown) => {
                assert.ok(error instanceof ProjectionError, "expected a ProjectionError");
                const projectionError = error as ProjectionError;
                assert.equal(projectionError.rowIndex, 1);                 // the second (bad) row
                assert.match(projectionError.sql ?? "", /SELECT/i);        // the SQL command
                assert.match(projectionError.projector ?? "", /denormalizeTemporal|row\[/); // the projector source
                // The composed message stitches the diagnostics together (Signum's format).
                assert.match(projectionError.message, /Row: 1/);
                return true;
            });
        });
    });

    // A well-formed value reads cleanly through the same path (no false positives).
    test("valid rows project without a ProjectionError", async () => {
        const q = table(NoteWithDateEntity).map(a => a.creationDate);
        const projection = bindAndOptimize(q.expression, connector.schema, connector.isPostgres);
        const tr = buildTranslateResult(projection, connector.isPostgres);
        const columnName = projection.select.columns[0].name;

        const rows = [{ [columnName]: new Date(Date.UTC(2001, 0, 1)) }];
        const fakeConnector = {
            isPostgres: connector.isPostgres,
            executeQuery: async () => rows,
        } as unknown as Connector;

        const result = await Connector.withConnector(fakeConnector, () => tr.execute()) as unknown[];
        assert.equal(result.length, 1);
        assert.ok(result[0] != null);
    });
});
