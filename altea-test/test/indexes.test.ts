import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { reflect } from "@altea/altea/entities/reflection";
import { Entity } from "@altea/altea/entities/entity";
import { Lite } from "@altea/altea/entities/lite";
import { include, index, uniqueIndex } from "@altea/altea/entities/decorators";
import { type int, toInt } from "@altea/altea/entities/basics";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import type { FluentTable } from "@altea/altea/logic/schema/table";
import { Connector } from "@altea/altea/logic/connection/connector";

// Index support: automatic FK indexes, field-level @index / @uniqueIndex, class-level
// composite @uniqueIndex(e => [..]) lambda, the fluent include().withIndex(...), and the
// CREATE INDEX SQL. DB-free — builds the schema in memory and inspects table.indexes.

@reflect
class IdxTarget extends Entity {
    name: string = "";
}

// Class-level composite unique index via a selector lambda.
@uniqueIndex((c: IdxCustomer) => [c.code, c.name])
@reflect
class IdxCustomer extends Entity {
    @uniqueIndex code: string = "";      // field-level unique index
    name: string = "";
    @index age: int = toInt(0);          // field-level non-unique index
    @include(() => IdxTarget)
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

function build(): { customer: FluentTable<IdxCustomer>; sb: SchemaBuilder } {
    const sb = new SchemaBuilder();
    sb.include(IdxTarget);
    const customer = sb.include(IdxCustomer);
    sb.complete();
    return { customer, sb };
}

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
        customer.withIndex(c => c.name);
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
            customer.withIndex(c => c.name);                            // plain index on name
            const plain = customer.indexes.at(-1)!;
            customer.withIndex(c => c.name, c => c.target != null);     // filtered on a nullable FK, via a predicate lambda
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
