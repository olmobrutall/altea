import { after } from "node:test";
import "@altea/altea/server/context.node"; // register server context storage first
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server"; // installs Entity.prototype.save / delete
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import type { Lite } from "@altea/altea/data/lite";
import { Isolation, IsolationEntity } from "../../data/Isolation";
import { IsolationLogic } from "../../server/IsolationLogic.server";
import { CatalogEntity, ProjectEntity, TagEntity } from "../data/tenancy";

// Shared bootstrap for the isolation suite (the altea-isolation analogue of altea-cache's
// test/server/setup.ts). Southwind does not START Signum.Isolation — it only references it — so this suite
// is where the module is exercised: multi-tenancy is an all-or-nothing, app-wide commitment (EVERY table
// must declare a strategy or startup fails), and eastwind is not multi-tenant.
//
// DB tests are gated on ALTEA_ISOLATION_TEST_DB, so every file still compiles and the DB-free cases (the
// ambient scope, the strategy assertion) still run with no database.

export const hasDb = !!process.env.ALTEA_ISOLATION_TEST_DB;

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

/**
 * The strategy table, declared exactly as an app would: from a module BOTH tiers load, before anything is
 * serialized or the schema is built. Idempotent, so each spawned test process may call it.
 */
export function registerStrategies(): void {
    Isolation.register(ProjectEntity, "Isolated");
    Isolation.register(TagEntity, "Optional");
    Isolation.register(CatalogEntity, "None");
}

// Connect + build the in-memory schema. No DDL, no seed.
export function start(): Promise<Connector> {
    return (started ??= (async () => {
        registerStrategies();

        const sb = new SchemaBuilder();
        const connector = await connectorFor(sb.schema, process.env.ALTEA_ISOLATION_TEST_DB!);
        Connector.default = connector;
        sb.settings.isPostgres = connector.isPostgres;

        IsolationLogic.start(sb);

        sb.include(ProjectEntity).withQuery();
        sb.include(TagEntity).withQuery();
        sb.include(CatalogEntity).withQuery();

        sb.complete();
        await connector.schema.initialize();
        return connector;
    })());
}

// One-shot: drop/recreate the tables and seed the fixture rows. Run via `gen:*` before a test run.
export async function generateIsolationEnvironment(): Promise<Connector> {
    const connector = await start();
    await connector.cleanDatabase();
    await connector.schema.generationScript()?.executeNonQuery();
    await connector.schema.initialize();
    await seed();
    return connector;
}

// ---- The fixture ---------------------------------------------------------------------------------
//
// Two tenants, each with a project of its OWN and a project whose NAME COLLIDES with the other's (which is
// what the per-isolation unique index is asserted with); one tag per tenant plus one GLOBAL tag; two
// catalogs, which no tenant filters.

export const Fixture = {
    acme: "Acme",
    globex: "Globex",
    /** Exists in BOTH tenants — only legal if the unique index carries the isolation column. */
    sharedProjectName: "Website",
    acmeOnlyProject: "Acme intranet",
    globexOnlyProject: "Globex shop",
    acmeTag: "acme-tag",
    globexTag: "globex-tag",
    globalTag: "global-tag",
} as const;

/** The two isolations, by name — resolved once the DB is seeded. */
export async function isolationsByName(): Promise<Map<string, Lite<IsolationEntity>>> {
    const all = await ExecutionMode.global(() => IsolationLogic.isolations.value());
    return new Map(all.map(l => [l.toString(), l]));
}

async function seed(): Promise<void> {
    // The isolations themselves are created in GLOBAL mode: they are not isolated rows.
    const acme = await IsolationEntity.create({ name: Fixture.acme }).save();
    const globex = await IsolationEntity.create({ name: Fixture.globex }).save();

    await IsolationLogic.unsafeOverride(acme.toLite(), async () => {
        await ProjectEntity.create({ name: Fixture.sharedProjectName }).save();
        await ProjectEntity.create({ name: Fixture.acmeOnlyProject }).save();
        await TagEntity.create({ name: Fixture.acmeTag }).save();
    });

    await IsolationLogic.unsafeOverride(globex.toLite(), async () => {
        await ProjectEntity.create({ name: Fixture.sharedProjectName }).save();
        await ProjectEntity.create({ name: Fixture.globexOnlyProject }).save();
        await TagEntity.create({ name: Fixture.globexTag }).save();
    });

    // Global rows: an Optional tag with no isolation (visible from everywhere) and two un-isolated catalogs.
    await TagEntity.create({ name: Fixture.globalTag }).save();
    await CatalogEntity.create({ name: "Spring", mainProject: null }).save();
    await CatalogEntity.create({ name: "Autumn", mainProject: null }).save();
}
