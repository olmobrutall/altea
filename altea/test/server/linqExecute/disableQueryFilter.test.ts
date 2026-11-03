import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { Expression } from "@altea/altea/server/linq/expressions";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import type { Quoted } from "quote-transformer/quoted";
import { MusicLogic } from "../MusicLogic";
import { seedTypeCachesForTest } from "../seedTypeCaches";
import { AlbumEntity } from "../../data/music";

// `.disableQueryFilter()` (Signum's DisableQueryFilter): the row-level queryFilter is not spliced into the
// table sources under it, while the rest of the query stays filtered. Offline: binding never executes SQL.

class FakeConnector extends Connector {
    constructor(schema: any) { super(schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();
seedTypeCachesForTest(sb.schema);
const fake = new FakeConnector(sb.schema);

function sqlOf(query: { expression: any }): string {
    const proj = Connector.withConnector(fake, () => bindAndOptimize(query.expression, sb.schema, false));
    const f = QueryFormatter.format(proj.select, false);
    // The marker constant goes out as ONE reused parameter (`@pN`), so put it back in the text to count it.
    return f.parameters.reduce<string>((sql, v, i) => v === 4242 ? sql.split(new RegExp(`@p${i}(?!\\d)`)).join("4242") : sql, f.sql);
}

function asQuoted<T>(q: Quoted<(e: T) => boolean>): Quoted<(e: T) => boolean> { return q; }

/** Runs `fn` with an AlbumEntity queryFilter of `id = 4242`, a marker easy to count in the SQL. */
function withAlbumFilter<R>(fn: () => R): R {
    const predicate = asQuoted<AlbumEntity>(a => a.id == 4242);
    const hooks = sb.schema.entityEvents(AlbumEntity).queryFilter;
    hooks.push(({ elementType }) => Expression.fromQuotedLambda(predicate as never, [elementType]));
    try {
        return fn();
    } finally {
        hooks.pop();
    }
}

const markers = (sql: string): number => sql.split("4242").length - 1;

describe("disableQueryFilter", () => {

    test("a filtered table source gets the queryFilter", () => {
        withAlbumFilter(() => assert.equal(markers(sqlOf(table(AlbumEntity))), 1));
    });

    test("disableQueryFilter leaves it out", () => {
        withAlbumFilter(() => assert.equal(markers(sqlOf(table(AlbumEntity).disableQueryFilter())), 0));
    });

    test("after a filter, as Signum's `.Where(...).DisableQueryFilter().Count()` is written", () => {
        withAlbumFilter(() => assert.equal(markers(sqlOf(table(AlbumEntity).filter(a => a.year != 0).disableQueryFilter())), 0));
    });

    // The SM case: an expression column counting everybody's rows inside a search that stays filtered.
    test("a nested unfiltered count keeps the outer query filtered", () => {
        withAlbumFilter(() => {
            const sql = sqlOf(table(AlbumEntity).map(a => ({
                id: a.id,
                all: table(AlbumEntity).disableQueryFilter().count().$v,
                visible: table(AlbumEntity).count().$v,
            })));
            assert.equal(markers(sql), 2, "the outer source and the filtered count, not the disabled one");
        });
    });
});
