import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { Connector } from "@altea/altea/server/connection/connector";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { retrieve } from "@altea/altea/server/Database";
import { table } from "@altea/altea/server/table";
import { Decimal, Temporal, toInt } from "@altea/altea/data/basics";
import { CacheLogic } from "../../server/CacheLogic";
import {
    CountryEntity, CountryEntity_Region, CurrencyEntity, DepartmentEntity, EmployeeEntity, EmployeeLite,
    OrderEntity,
} from "../data/shop";
import { Fixture, countSql, hasDb, start, statsOf } from "./setup";

// The cache suite. Each case goes through the real engine (no HTTP): `Database.retrieve` under a cache
// controller, the completer, the semi-cached lite tables, and the invalidation events.

describe("altea-cache", { skip: hasDb ? false : "set ALTEA_CACHE_TEST_DB (and run gen) to enable" }, () => {

    before(async () => { await start(); });

    const spain = (): Promise<CountryEntity> => byIsoCode(Fixture.spain);
    const france = (): Promise<CountryEntity> => byIsoCode(Fixture.france);

    async function byIsoCode(isoCode: string): Promise<CountryEntity> {
        // Deliberately through the QUERY (not the cache) to get the id: the cache is what we then test.
        const id = await table(CountryEntity).filter(c => c.isoCode == isoCode).map(c => c.id).single();
        return await retrieve(CountryEntity, id);
    }

    describe("registration (which types the closure pulls in)", () => {
        test("a Master type marked withCache is Cached, and so is its @part child", () => {
            assert.equal(CacheLogic.getCacheType(CountryEntity), "Cached");
            assert.equal(CacheLogic.getCacheType(CurrencyEntity), "Cached");
            assert.equal(CacheLogic.getCacheType(CountryEntity_Region), "Cached", "a @part child of a cached type is cached with it");
        });

        test("a Transactional type referenced by a cached one is SEMI (its lites only)", () => {
            assert.equal(CacheLogic.getCacheType(EmployeeEntity), "Semi");
            assert.equal(CacheLogic.getCacheType(OrderEntity), "Semi");
        });

        // The transitive-containment guard, and the reason the walk stops at a semi type: Department is
        // referenced by Employee, which is only ever semi-cached. Following a semi type's own references is
        // how caching ONE Master type ends up pulling most of the database into memory.
        test("a type reachable only THROUGH a semi type is not cached at all", () => {
            assert.equal(CacheLogic.getCacheType(DepartmentEntity), "None");
        });
    });

    describe("loading and reading", () => {
        test("the first read loads the table, the second issues no SQL at all", async () => {
            await Transaction.create(async () => {
                const first = await countSql(() => spain());
                assert.ok(first.sql.length > 0, "the first read must hit the database");

                const second = await countSql(() => spain());
                // `byIsoCode` still runs its id query; what must vanish is the entity read itself.
                assert.equal(second.sql.length, 1, `expected only the id query, got:\n${second.sql.join("\n")}`);
            });
        });

        test("every read hands out a FRESH, clean instance (the cache holds rows, not entities)", async () => {
            await Transaction.create(async () => {
                const a = await spain();
                const b = await spain();
                assert.notEqual(a, b, "two reads must not share one instance");
                assert.equal(a.isNew, false);
                assert.equal(a.isDirty(), false, "a freshly materialised entity is not dirty");

                // Mutating what the cache handed out must not affect the next read.
                a.name = "MUTATED";
                assert.equal((await spain()).name, "Spain");
            });
        });

        test("value columns materialise exactly as a query would", async () => {
            await Transaction.create(async () => {
                const c = await spain();
                assert.equal(c.name, "Spain");
                assert.equal(Number(c.population), 48000000);
                assert.ok(c.area instanceof Decimal, "a numeric column is a decimal.js Decimal");
                assert.equal(c.area.toString(), "505990.5");
                assert.ok(c.independenceDay instanceof Temporal.PlainDate, "a date column is a Temporal.PlainDate");
                assert.equal(c.independenceDay.toString(), "1492-01-02");
                assert.equal(c.continent, 0, "an enum field holds its underlying value, as in a query");
                assert.ok(c.center != null, "the embedded is materialised");
                assert.equal(c.center.latitude.toString(), "40.42");
                assert.equal((await france()).center, null, "a null embedded stays null (hasValue = false)");
            });
        });

        test("a @part collection comes back in @rowOrder, from the child's own cached table", async () => {
            await Transaction.create(async () => {
                const c = await spain();
                assert.deepEqual(c.regions.map(r => r.name), ["Galicia", "Andalusia", "Catalonia"]);
                assert.deepEqual(c.regions.map(r => Number(r.rowOrder)), [0, 1, 2]);
                assert.equal(c.regions[0].isDirty(), false);
                assert.deepEqual((await france()).regions, [], "an owner with no children gets an empty array");
            });
        });

        test("a Lite of a CACHED type is built from that type's own cached rows", async () => {
            await Transaction.create(async () => {
                const c = await spain();
                // Currency's toString() is hand-written; the cached row carries every column, so running it
                // over the materialised entity produces the real display string.
                assert.equal(c.currency.toString(), "EUR (€)");
            });
        });
    });

    describe("semi-cached lites (only the display columns, only the referenced rows)", () => {
        test("a custom lite is built from its own columns — and nothing else is cached", async () => {
            await Transaction.create(async () => {
                const c = await spain();
                const lite = c.salesRep;
                assert.ok(lite instanceof EmployeeLite, "the FIELD's registered custom lite is what gets built");
                assert.equal(lite.toString(), Fixture.referencedEmployee);
                assert.equal(lite.email, "ada@example.com", "the custom lite's own column is cached too");

                // THE point of the trimmed table: only what the lite reads.
                const cached = cachedColumnsOf("Lite<EmployeeEntity>");
                assert.deepEqual(cached.sort(), ["email", "id", "name"].map(expectedColumnName).sort(),
                    `expected only the lite's columns, got [${cached.join(", ")}]`);
                assert.ok(!cached.some(c2 => /secret/i.test(c2)), "`secretNotes` must never be cached");
                assert.ok(!cached.some(c2 => /department/i.test(c2)), "the reference column must not be cached either");
            });
        });

        test("a hand-written toString() on a semi type caches the ToStr column only", async () => {
            await Transaction.create(async () => {
                const c = await spain();
                assert.ok(c.lastOrder != null);
                assert.equal(c.lastOrder.toString(), `Order ${Fixture.referencedOrder}`);

                const cached = cachedColumnsOf("Lite<OrderEntity>");
                assert.equal(cached.length, 2, `expected id + ToStr, got [${cached.join(", ")}]`);
                assert.ok(!cached.some(c2 => /total/i.test(c2)), "`total` is not part of the display string");
            });
        });

        test("only the ROWS a cached table references are held", async () => {
            await Transaction.create(async () => {
                await spain();
                await france();
                const employees = await table(EmployeeEntity).count();
                assert.equal(employees, 3, "the fixture has three employees…");
                assert.equal(statsOf("Lite<EmployeeEntity>")?.count, 2, "…but only the two referenced ones are cached");
                assert.equal(statsOf("Lite<OrderEntity>")?.count, 1, "one of the two orders is referenced");
            });
        });

        test("a null reference yields null without touching the lite table", async () => {
            await Transaction.create(async () => {
                assert.equal((await france()).lastOrder, null);
            });
        });
    });

    describe("invalidation", () => {
        test("saving a cached entity drops its rows; the next read reloads them", async () => {
            const before = statsOf("CountryEntity");
            assert.ok(before?.count != null, "loaded by the earlier cases");

            await Transaction.create(async () => {
                const c = await spain();
                c.population = toInt(Number(c.population) + 1);
                await c.save();
            });

            assert.equal(statsOf("CountryEntity")?.count, null, "the rows are gone after the commit");
            assert.ok((statsOf("CountryEntity")?.invalidations ?? 0) > 0);

            await Transaction.create(async () => {
                const after = await countSql(() => spain());
                assert.ok(after.sql.length > 1, "the table is read again");
                assert.equal(Number(after.result.population), 48000001);
            });

            // Put the fixture back.
            await Transaction.create(async () => {
                const c = await spain();
                c.population = toInt(Number(c.population) - 1);
                await c.save();
            });
        });

        test("a set-based UPDATE invalidates too (no entity involved)", async () => {
            await Transaction.create(async () => { await spain(); });
            assert.ok(statsOf("CountryEntity")?.count != null);

            await Transaction.create(async () => {
                await table(CountryEntity).filter(c => c.isoCode == Fixture.spain).executeUpdate(c => ({ name: c.name }));
            });

            assert.equal(statsOf("CountryEntity")?.count, null, "the DML hooks drop the rows as a save does");
        });

        test("saving a SEMI type drops the lite tables that hold its rows", async () => {
            await Transaction.create(async () => { await spain(); });
            assert.ok(statsOf("Lite<EmployeeEntity>")?.count != null);

            await Transaction.create(async () => {
                const ada = await table(EmployeeEntity).filter(e => e.name == Fixture.referencedEmployee).single();
                ada.email = ada.email;                       // touch, then a real change so the save writes
                ada.secretNotes = `updated ${Date.now()}`;
                await ada.save();
            });

            assert.equal(statsOf("Lite<EmployeeEntity>")?.count, null, "the semi lite table is dropped");

            await Transaction.create(async () => {
                const c = await spain();
                assert.equal(c.salesRep!.toString(), Fixture.referencedEmployee, "and reloads correctly");
            });
        });
    });

    describe("globallyDisabled (the panel's Disable button)", () => {
        test("a disabled cache reads straight from the database", async () => {
            await Transaction.create(async () => { await spain(); });          // warm
            CacheLogic.globallyDisabled = true;
            try {
                await Transaction.create(async () => {
                    const r = await countSql(() => spain());
                    assert.ok(r.sql.length > 1, "the entity itself is queried again");
                    assert.equal(r.result.name, "Spain");
                });
            } finally {
                CacheLogic.globallyDisabled = false;
            }
        });
    });

    // The columns a trimmed lite table actually holds — read off the live table so the assertion is about
    // what is IN MEMORY, not about the SQL text.
    function cachedColumnsOf(typeName: string): string[] {
        for (const t of CacheLogic.statistics())
            for (const st of t.subTables)
                if (st.typeName === typeName)
                    return (st as unknown as { cachedColumnNames: string[] }).cachedColumnNames;
        throw new Error(`No cached lite table '${typeName}' — has the owner been read yet?`);
    }

    // Physical column names are dialect-shaped (Postgres snake-cases them), so compare through the schema.
    function expectedColumnName(field: string): string {
        const t = Connector.current().schema.table(EmployeeEntity);
        if (field === "id")
            return t.primaryKey.column.name;
        return t.fields[field].field.columns()[0].name;
    }
});
