import { after } from "node:test";
import "@altea/altea/server/context.node"; // register server context storage first
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server"; // installs Entity.prototype.save / delete
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { toInt, Decimal, Temporal } from "@altea/altea/data/basics";
import { CacheLogic } from "../../server/CacheLogic";
import "../../server/CacheLogic"; // FluentInclude.withCache
import {
    CountryEntity, CountryEntity_Region, CurrencyEntity, DepartmentEntity, EmployeeEntity, OrderEntity,
    GeoEmbedded, ContinentEnum,
} from "../data/shop";

// Shared bootstrap for the cache suite (the altea-cache analogue of altea-auth-test/server/setup.ts). A
// DB-backed test `start()`s (connect + build the in-memory schema + register the cache); the schema and the
// row fixture are generated ONCE out of band by `generateCacheEnvironment()` (the gen:* scripts).
// DB tests are gated on ALTEA_CACHE_TEST_DB, so every file still compiles with no database.

export const hasDb = !!process.env.ALTEA_CACHE_TEST_DB;

after(async () => { await Connector.default?.closeConnection(); });

let started: Promise<Connector> | undefined;

async function connectorFor(schema: SchemaBuilder["schema"], connStr: string): Promise<Connector> {
    if (connStr.startsWith("postgres")) {
        const { PostgresConnector } = await import("@altea/altea/server/connection/postgresConnector");
        return new PostgresConnector(schema, connStr);
    }
    const { SqlServerConnector } = await import("@altea/altea/server/connection/sqlServerConnector");
    return new SqlServerConnector(schema, connStr);
}

// Connect + build the in-memory schema + register the cache. No DDL, no seed.
export function start(): Promise<Connector> {
    return (started ??= (async () => {
        const sb = new SchemaBuilder();
        const connector = await connectorFor(sb.schema, process.env.ALTEA_CACHE_TEST_DB!);
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;

        // CacheLogic FIRST: it swaps the global-lazy invalidation strategy, which must happen before any
        // `sb.globalLazy` registration — exactly as eastwind's Starter does it. No broadcast: a single
        // process, so its own events cover everything.
        CacheLogic.start(sb);

        // The two Master tables the suite caches. `withCache()` pulls their dependency closure in with
        // them — which is the point of the registration test: Employee/Order become SEMI, and Department
        // (reachable only THROUGH a semi type) must stay out.
        sb.include(CountryEntity)
            .withCache()
            .withQuery();
        sb.include(CurrencyEntity)
            .withCache()
            .withQuery();
        // Registered, not cached: the suite reads them straight from the database to seed/assert.
        sb.include(EmployeeEntity).withQuery();
        sb.include(OrderEntity).withQuery();
        sb.include(DepartmentEntity).withQuery();

        sb.complete();
        await connector.schema.initialize();
        return connector;
    })());
}

// One-shot: drop/recreate the tables and seed the fixture rows. Run via `gen:*` before a test run.
export async function generateCacheEnvironment(): Promise<Connector> {
    const connector = await start();
    await connector.cleanDatabase();
    await connector.schema.generationScript()?.executeNonQuery();
    await connector.schema.initialize();
    await seed();
    return connector;
}

// ---- The fixture ---------------------------------------------------------------------------------
//
// 2 currencies · 1 department · 3 employees (only TWO of them referenced by a country) · 2 orders (only
// ONE referenced) · 2 countries, one with regions and both semi references set, one with neither.
// The "only referenced rows" counts are what the semi-cached lite table's `count` is asserted against.

export const Fixture = {
    euro: "EUR",
    dollar: "USD",
    spain: "ES",
    france: "FR",
    /** Referenced by Spain — so its lite IS cached. */
    referencedEmployee: "Ada Lovelace",
    /** Referenced by France. */
    otherEmployee: "Grace Hopper",
    /** Referenced by NOBODY — its lite must never be cached. */
    unreferencedEmployee: "Alan Turing",
    referencedOrder: "A-1",
    unreferencedOrder: "A-2",
} as const;

async function seed(): Promise<void> {
    const dept = await DepartmentEntity.create({ name: "Sales" }).save();

    const eur = await CurrencyEntity.create({ isoCode: "EUR", symbol: "€" }).save();
    await CurrencyEntity.create({ isoCode: "USD", symbol: "$" }).save();

    const ada = await EmployeeEntity.create({
        name: Fixture.referencedEmployee, email: "ada@example.com",
        secretNotes: "MUST NOT BE CACHED", department: dept.toLite(),
    }).save();
    const grace = await EmployeeEntity.create({
        name: Fixture.otherEmployee, email: "grace@example.com",
        secretNotes: "MUST NOT BE CACHED", department: dept.toLite(),
    }).save();
    await EmployeeEntity.create({
        name: Fixture.unreferencedEmployee, email: "alan@example.com",
        secretNotes: "MUST NOT BE CACHED", department: dept.toLite(),
    }).save();

    const order = await OrderEntity.create({ number: Fixture.referencedOrder, total: new Decimal("123.45") }).save();
    await OrderEntity.create({ number: Fixture.unreferencedOrder, total: new Decimal("9.99") }).save();

    await CountryEntity.create({
        isoCode: Fixture.spain,
        name: "Spain",
        population: toInt(48000000),
        area: new Decimal("505990.50"),
        independenceDay: Temporal.PlainDate.from("1492-01-02"),
        continent: ContinentEnum.Europe,
        center: GeoEmbedded.create({ latitude: new Decimal("40.42"), longitude: new Decimal("-3.70") }),
        currency: eur.toLite(),
        salesRep: ada.toLite(),
        lastOrder: order.toLite(),
        // Deliberately NOT in alphabetical order, so `@rowOrder` is what the assertion sees.
        regions: [
            CountryEntity_Region.create({ name: "Galicia" }),
            CountryEntity_Region.create({ name: "Andalusia" }),
            CountryEntity_Region.create({ name: "Catalonia" }),
        ],
    }).save();

    await CountryEntity.create({
        isoCode: Fixture.france,
        name: "France",
        population: toInt(68000000),
        area: new Decimal("551695.00"),
        continent: ContinentEnum.Europe,
        currency: eur.toLite(),
        salesRep: grace.toLite(),
        lastOrder: null,
        regions: [],
    }).save();
}

// ---- Test helpers --------------------------------------------------------------------------------

/** Counts the SQL statements `fn` issues (Signum's Connector.CurrentLogger). */
export async function countSql<R>(fn: () => Promise<R>): Promise<{ result: R, sql: string[] }> {
    const sql: string[] = [];
    const previous = Connector.currentLogger;
    Connector.currentLogger = { log: s => sql.push(s.replace(/\s+/g, " ")) };
    try {
        return { result: await fn(), sql };
    } finally {
        Connector.currentLogger = previous;
    }
}

/** The statistics row of one cached table, by type name (`Lite<X>` for a semi-cached lite table). */
export function statsOf(typeName: string): { count: number | null, hits: number, invalidations: number, loads: number } | undefined {
    for (const t of CacheLogic.statistics()) {
        if (t.typeName === typeName)
            return t;
        for (const st of t.subTables)
            if (st.typeName === typeName)
                return st;
    }
    return undefined;
}
