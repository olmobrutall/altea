import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import type { Lite } from "@altea/altea/data/lite";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { planLiteColumns } from "../../server/LiteColumnsFinder";
import {
    CountryEntity, CurrencyEntity, DepartmentEntity, EmployeeEntity, EmployeeLite, OrderEntity,
} from "../data/shop";

// The column planner in isolation — NO DATABASE. It decides how few columns a semi-cached `Lite<T>` needs,
// which is what keeps a cached `Country → Lite<Employee>` from dragging Employee (and Employee's own
// references, and theirs…) into memory. Signum does this with ToStringColumnsFinderVisitor +
// LiteModelExpressionVisitor; altea walks the custom lite's / `@quoted toString()`'s expression tree.

// An offline schema: `include` + `complete` need no connector, so the Tables (and therefore the columns)
// are available without touching a database.
const sb = new SchemaBuilder();
sb.include(CountryEntity);
sb.include(CurrencyEntity);
sb.include(EmployeeEntity);
sb.include(OrderEntity);
sb.include(DepartmentEntity);
sb.complete();

const columnNames = (type: Parameters<typeof planLiteColumns>[0]): string[] =>
    planLiteColumns(type, sb.schema.table(type), undefined).columns.map(c => c.name).sort();

describe("LiteColumnsFinder", () => {

    test("a @quoted toString() over one member needs exactly that column", () => {
        const table = sb.schema.table(CountryEntity);
        assert.deepEqual(columnNames(CountryEntity), [table.fields["name"].field.columns()[0].name]);
    });

    test("a HAND-WRITTEN toString() needs the ToStr column, and nothing else", () => {
        const plan = planLiteColumns(CurrencyEntity, sb.schema.table(CurrencyEntity), undefined);
        assert.equal(plan.usesToStrColumn, true);
        assert.deepEqual(plan.columns.map(c => c.name), [sb.schema.table(CurrencyEntity).toStrColumn!.name]);
    });

    test("a custom lite needs its own columns plus whatever its toString() reads", () => {
        const table = sb.schema.table(EmployeeEntity);
        // `e => new EmployeeLite(e.id, e.toString(), e.email)` — toString() is @quoted over `name`, so the
        // set is {id, name, email}: NOT secretNotes, NOT the department FK.
        assert.deepEqual(columnNames(EmployeeEntity), [
            table.primaryKey.column.name,
            table.fields["email"].field.columns()[0].name,
            table.fields["name"].field.columns()[0].name,
        ].sort());
    });

    test("a semi type with a hand-written toString() caches only its ToStr column", () => {
        const plan = planLiteColumns(OrderEntity, sb.schema.table(OrderEntity), undefined);
        assert.equal(plan.usesToStrColumn, true);
        assert.deepEqual(plan.columns.map(c => c.name), [sb.schema.table(OrderEntity).toStrColumn!.name]);
        assert.ok(!plan.columns.some(c => /total/i.test(c.name)));
    });

    describe("refusals (loud at startup, never a silently wrong lite)", () => {
        // A second, NON-default custom lite that navigates a reference. Registering it is harmless (nothing
        // asks for it); planning it must fail.
        class NavigatingLite extends LiteImp<EmployeeEntity> {
            constructor(id: PrimaryKey, toStr: string, readonly department: string) {
                super(id, EmployeeEntity, toStr);
            }
            static isCompatible(): boolean { return false; }
            static fromJson(json: Record<string, unknown>): Lite<EmployeeEntity> {
                return new NavigatingLite(json.id as PrimaryKey, "", "");
            }
        }
        registerCustomLite(EmployeeEntity, NavigatingLite,
            e => new NavigatingLite(e.id, e.toString(), e.department.entity.name), false);

        test("navigating a reference is refused", () => {
            assert.throws(
                () => planLiteColumns(EmployeeEntity, sb.schema.table(EmployeeEntity), NavigatingLite),
                /Cannot cache the Lite of 'EmployeeEntity'[\s\S]*department/,
            );
        });
    });
});
