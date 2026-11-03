import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Temporal } from "@altea/altea/data/basics";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { MusicLogic } from "../MusicLogic";
import { seedTypeCachesForTest } from "../seedTypeCaches";
import { NoteWithDateEntity } from "../../data/note";

// `date.toShortDateString()` (Signum's ToShortDateString, what `$"{date}"` prints in .NET): the current
// culture's short date, in memory and in SQL. Offline: binding never executes SQL.

class FakeConnector extends Connector {
    constructor(schema: any, isPostgres: boolean) { super(schema, isPostgres, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

function schemaFor(isPostgres: boolean): SchemaBuilder {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    MusicLogic.start(sb);
    sb.complete();
    seedTypeCachesForTest(sb.schema);
    return sb;
}

function formatted(isPostgres: boolean, culture: string): { sql: string } {
    const sb = schemaFor(isPostgres);
    const query = table(NoteWithDateEntity).map(n => n.creationDate.toShortDateString());
    const old = CultureInfo.defaultCulture();
    CultureInfo.setDefaultCulture(culture);
    try {
        const proj = Connector.withConnector(new FakeConnector(sb.schema, isPostgres), () => bindAndOptimize(query.expression, sb.schema, isPostgres));
        return QueryFormatter.format(proj.select, isPostgres);
    } finally {
        CultureInfo.setDefaultCulture(old);
    }
}

describe("toShortDateString", () => {

    test("in memory: the culture's short pattern, four-digit year", () => {
        const d = Temporal.PlainDate.from("2027-01-18");
        const old = CultureInfo.defaultCulture();
        try {
            CultureInfo.setDefaultCulture("de-DE");
            assert.equal(d.toShortDateString(), "18.01.2027");
            CultureInfo.setDefaultCulture("en-GB");
            assert.equal(d.toShortDateString(), "18/01/2027");
        } finally {
            CultureInfo.setDefaultCulture(old);
        }
    });

    test("SQL Server: FORMAT(date, 'd', culture)", () => {
        const f = formatted(false, "de-DE");
        assert.match(f.sql, /FORMAT\([^)]*'d',\s*'de-DE'\)/i);
    });

    test("Postgres: to_char with the culture's pattern", () => {
        const f = formatted(true, "de-DE");
        assert.match(f.sql, /to_char\([^)]*'DD\.MM\.YYYY'\)/i);
    });
});
