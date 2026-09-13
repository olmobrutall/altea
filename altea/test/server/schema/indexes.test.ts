import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection"; // anchor for the transformer's @field injection
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, index, uniqueIndex } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Table } from "@altea/altea/server/schema/table";
import { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import { Connector } from "@altea/altea/server/connection/connector";

// Index support: automatic FK indexes, field-level @index / @uniqueIndex, class-level
// composite @uniqueIndex(e => [..]) lambda, the fluent include().withIndex(...), and the
// CREATE INDEX SQL. DB-free — builds the schema in memory and inspects table.indexes.

@entity("Main", "Master")
class IdxTarget extends Entity {
    name: string = "";
}

// Class-level composite unique index via a selector lambda.
@uniqueIndex((c: IdxCustomer) => [c.code, c.name])
@entity("Main", "Master")
class IdxCustomer extends Entity {
    @uniqueIndex code: string = "";      // field-level unique index
    name: string = "";
    @index age: int = toInt(0);          // field-level non-unique index
    target: Lite<IdxTarget> | null = null; // FK → automatic non-unique index
}

// A fake connector purely to reach the dialect SqlBuilder (SQL Server).
class FakeConnector extends Connector {
    constructor(schema: any) { super(schema, false, 128); }
    executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

function build(): { customer: Table; sb: SchemaBuilder } {
    const sb = new SchemaBuilder();
    sb.include(IdxTarget);
    const customer = sb.include(IdxCustomer).table;
    sb.complete();
    return { customer, sb };
}

// The fluent handle itself (Signum's FluentInclude<T>): sb.include(T) returns a FluentInclude
// wrapping the Table, and withIndex chains on it.
test("include(T) returns a FluentInclude with .table and chainable withIndex", () => {
    const sb = new SchemaBuilder();
    const fi = sb.include(IdxCustomer);
    assert.ok(fi instanceof FluentInclude);
    const before = fi.table.indexes.length;
    const chained = fi.withIndex(c => c.name);
    assert.equal(chained, fi, "withIndex returns the FluentInclude for chaining");
    assert.equal(fi.table.indexes.length, before + 1);
});

// Does `table` have an index over exactly `columnNames` (order-sensitive) with the given unique flag?
function hasIndex(table: any, columnNames: string[], unique: boolean): boolean {
    return table.indexes.some((ix: any) =>
        ix.unique === unique &&
        ix.columns.length === columnNames.length &&
        ix.columns.every((c: any, i: number) => c.name === columnNames[i]));
}
const col = (table: any, field: string): string => table.columnsFromFields([field])[0].name;

describe("Index generation", () => {
    test("field @uniqueIndex → unique single-column index", () => {
        const { customer } = build();
        assert.ok(hasIndex(customer, [col(customer, "code")], true), "unique index on code");
    });

    test("field @index → non-unique single-column index", () => {
        const { customer } = build();
        assert.ok(hasIndex(customer, [col(customer, "age")], false), "non-unique index on age");
    });

    test("class @uniqueIndex(e => [..]) → composite unique index", () => {
        const { customer } = build();
        assert.ok(hasIndex(customer, [col(customer, "code"), col(customer, "name")], true), "composite unique on (code, name)");
    });

    test("foreign-key column gets an automatic non-unique index", () => {
        const { customer } = build();
        assert.ok(hasIndex(customer, [col(customer, "target")], false), "default FK index on target");
    });

    test("include(...).withIndex(...) adds an index", () => {
        const { customer } = build();
        const before = customer.indexes.length;
        customer.addIndex(c => c.name);
        assert.equal(customer.indexes.length, before + 1);
        assert.ok(hasIndex(customer, [col(customer, "name")], false), "non-unique index on name via withIndex");
    });

    test("CREATE INDEX SQL (SQL Server)", () => {
        const { customer, sb } = build();
        const fake = new FakeConnector(sb.schema);
        Connector.withConnector(fake, () => {
            const uniqueOnCode = customer.indexes.find((ix: any) => ix.unique && ix.columns.length === 1 && ix.columns[0].name === col(customer, "code"))!;
            const sql = fake.sqlBuilder.createIndex(uniqueOnCode).plainSql();
            assert.match(sql, /CREATE UNIQUE INDEX/i);
            assert.match(sql, /UIX_/);
            assert.match(sql, /\bCode\b/);
        });
    });

    test("filtered index (where lambda) emits WHERE and a WhereSignature-suffixed name", () => {
        const { customer, sb } = build();
        const fake = new FakeConnector(sb.schema);
        Connector.withConnector(fake, () => {
            const targetCol = col(customer, "target");
            customer.addIndex(c => c.name);                            // plain index on name
            const plain = customer.indexes.at(-1)!;
            customer.addIndex(c => c.name, c => c.target != null);     // filtered on a nullable FK, via a predicate lambda
            const filtered = customer.indexes.at(-1)!;

            // The predicate lambda is translated to SQL (Signum's IndexWhereExpressionVisitor):
            // a nullable reference `!= null` → `<col> IS NOT NULL`.
            const sql = fake.sqlBuilder.createIndex(filtered).plainSql();
            assert.match(sql, / WHERE /, "emits a WHERE clause");
            assert.match(sql, new RegExp(`${targetCol} IS NOT NULL`), "translates c.target != null to IS NOT NULL");

            // The WhereSignature: "__" + a 7-char base-32 hash, so a filtered index never
            // collides with a plain index over the same column.
            const filteredName = fake.sqlBuilder.indexName(filtered);
            const plainName = fake.sqlBuilder.indexName(plain);
            assert.match(filteredName, /__[0-9A-Za-z]{7}$/, "name carries a __<hash> suffix");
            assert.notEqual(filteredName, plainName, "distinct from the unfiltered same-column index");
        });
    });

    test("index name is chop-hashed to the identifier length limit", () => {
        const { customer, sb } = build();
        // A tiny name limit forces the chop-hash path (Signum's ChopHash): the emitted name
        // stays within the limit even though the raw prefix_table_columns string is longer.
        const smallLimit = 20;
        const fake = new (class extends FakeConnector {
            constructor() { super(sb.schema); (this as any).maxNameLength = smallLimit; }
        })();
        Connector.withConnector(fake, () => {
            const composite = customer.indexes.find((ix: any) => ix.columns.length === 2)!;
            const name = fake.sqlBuilder.indexName(composite);
            assert.ok(name.length <= smallLimit, `chopped name '${name}' (${name.length}) within ${smallLimit}`);
        });
    });
});

// ---- Signum-compatible unique-index filtering + literal spelling -------------------------------------
//
// Two rules that decide whether a Signum-generated database and an altea one agree on their indexes.
// Both were wrong before, and both showed up the same way: a `terminal sync` against a Southwind
// database dropped an index and created "another" one with the same columns under a different name.

@entity("Main", "Master")
class IdxFiltered extends Entity {
    // Signum gives EVERY [UniqueIndex] the filter `IsNull(field, equals: false)`, so an OPTIONAL
    // unique field may be left empty by many rows. A nullable STRING excludes '' as well as NULL.
    @uniqueIndex nickName: string | null = null;
    // …a nullable non-string gets the NULL half only.
    @uniqueIndex rank: int | null = null;
    // …and a REQUIRED one needs no filter at all.
    @uniqueIndex code: string = "";
}

// A boolean column named `is_default` under a filtered unique index — Southwind's
// `scheduler.holiday_calendar`, whose index name the hashes below are taken from.
@uniqueIndex<IdxDefaultable>(c => c.isDefault, c => c.isDefault)
@entity("Main", "Master")
class IdxDefaultable extends Entity {
    isDefault: boolean = false;
}

// The Postgres twin of FakeConnector (the names above are snake_case, and the boolean literal only
// differs on Postgres — SQL Server writes 1/0 in both modes).
class FakePostgresConnector extends Connector {
    constructor(schema: any) { super(schema, true, 63); }
    executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

function buildPostgres(legacyMode: boolean): { filtered: Table; defaultable: Table; sb: SchemaBuilder } {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = true;
    sb.settings.legacyMode = legacyMode;
    const filtered = sb.include(IdxFiltered).table;
    const defaultable = sb.include(IdxDefaultable).table;
    sb.complete();
    return { filtered, defaultable, sb };
}

// The unique index over `field`, whatever its filter.
function uniqueOn(table: Table, field: string): any {
    const name = table.columnsFromFields([field])[0].name;
    return table.indexes.find((ix: any) => ix.unique && ix.columns.length === 1 && ix.columns[0].name === name)!;
}

describe("Field-level @uniqueIndex filtering (Signum's Field.GenerateUniqueIndex)", () => {
    test("a nullable STRING column excludes NULL and '' — so many rows may leave it empty", () => {
        const { filtered } = buildPostgres(false);
        assert.equal(uniqueOn(filtered, "nickName").where, "nick_name IS NOT NULL AND nick_name <> ''");
    });

    test("a nullable non-string column excludes NULL only", () => {
        const { filtered } = buildPostgres(false);
        assert.equal(uniqueOn(filtered, "rank").where, "rank IS NOT NULL");
    });

    test("a REQUIRED column is unfiltered, so its name carries no WHERE signature", () => {
        const { filtered, sb } = buildPostgres(false);
        const fake = new FakePostgresConnector(sb.schema);
        Connector.withConnector(fake, () => {
            const ix = uniqueOn(filtered, "code");
            assert.equal(ix.where, undefined, "no predicate: the test would be a tautology");
            assert.equal(fake.sqlBuilder.indexName(ix), "uix_idx_filtered_code");
        });
    });

    // The filter is NOT parenthesised, because the rendered text is what the name's hash is computed
    // over: Southwind's `auth.uix_user_external_id__7y2e8fy` is the hash of exactly this string shape.
    test("the filter is unparenthesised, as Signum's is (the hash is computed over the text)", () => {
        const { filtered } = buildPostgres(false);
        assert.doesNotMatch(uniqueOn(filtered, "nickName").where, /^\(/, "no wrapping parentheses");
    });
});

describe("Boolean literal in a filtered index's name hash (legacyMode)", () => {
    // Signum renders a Postgres boolean through .NET's `bool.ToString()` — "True". Postgres stores the
    // predicate identically either way, so ONLY the name differs: Southwind has
    // `uix_holiday_calendar_is_default__q3ba1w0`, and altea's own spelling ("TRUE") hashes to
    // `__q0f7g6y`. Same index, two names, and every sync swapping one for the other.
    test("legacyMode spells it Signum's way, so the name matches a Signum-generated database", () => {
        const { defaultable, sb } = buildPostgres(true);
        const fake = new FakePostgresConnector(sb.schema);
        Connector.withConnector(fake, () => {
            const ix = uniqueOn(defaultable, "isDefault");
            assert.equal(ix.where, "is_default = True");
            assert.match(fake.sqlBuilder.indexName(ix), /__q3ba1w0$/);
        });
    });

    test("without legacyMode it stays altea's own spelling", () => {
        const { defaultable, sb } = buildPostgres(false);
        const fake = new FakePostgresConnector(sb.schema);
        Connector.withConnector(fake, () => {
            const ix = uniqueOn(defaultable, "isDefault");
            assert.equal(ix.where, "is_default = TRUE");
            assert.match(fake.sqlBuilder.indexName(ix), /__q0f7g6y$/);
        });
    });
});
