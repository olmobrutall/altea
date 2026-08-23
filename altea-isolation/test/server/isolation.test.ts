import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import type { Lite } from "@altea/altea/data/lite";
import { IsolationEntity } from "../../data/Isolation";
import { IsolationLogic } from "../../server/IsolationLogic.server";
import { CatalogEntity, ProjectEntity, TagEntity } from "../data/tenancy";
import { Fixture, hasDb, isolationsByName, start } from "./setup";

// What the module is FOR, against a real database: an isolation scope decides which rows a query returns and
// which rows a save may write. Skipped without ALTEA_ISOLATION_TEST_DB (see .env.example).

describe("row isolation", { skip: hasDb ? false : "set ALTEA_ISOLATION_TEST_DB to run" }, () => {

    let acme: Lite<IsolationEntity>;
    let globex: Lite<IsolationEntity>;

    before(async () => {
        await start();
        const byName = await isolationsByName();
        acme = byName.get(Fixture.acme)!;
        globex = byName.get(Fixture.globex)!;
        assert.ok(acme != undefined && globex != undefined, "the fixture isolations must exist — run gen:postgres");
    });

    // ---- reading ---------------------------------------------------------------------------------

    test("an Isolated type returns ONLY the current isolation's rows", async () => {
        const mine = await IsolationLogic.unsafeOverride(acme, () =>
            table(ProjectEntity).map(p => p.name).toArray());

        assert.deepEqual([...mine].sort(), [Fixture.acmeOnlyProject, Fixture.sharedProjectName].sort());
        assert.ok(!mine.includes(Fixture.globexOnlyProject));
    });

    test("…and the other isolation sees exactly its own", async () => {
        const theirs = await IsolationLogic.unsafeOverride(globex, () =>
            table(ProjectEntity).map(p => p.name).toArray());

        assert.deepEqual([...theirs].sort(), [Fixture.globexOnlyProject, Fixture.sharedProjectName].sort());
    });

    test("GLOBAL mode (no isolation) sees every row", async () => {
        const all = await table(ProjectEntity).map(p => p.name).toArray();
        assert.equal(all.length, 4);
    });

    test("ExecutionMode.global suppresses the filter even inside an isolation", async () => {
        const all = await IsolationLogic.unsafeOverride(acme, () =>
            ExecutionMode.global(() => table(ProjectEntity).map(p => p.name).toArray()));
        assert.equal(all.length, 4);
    });

    test("an Optional type returns the current isolation's rows PLUS the global ones", async () => {
        const mine = await IsolationLogic.unsafeOverride(acme, () =>
            table(TagEntity).map(t => t.name).toArray());

        assert.deepEqual([...mine].sort(), [Fixture.acmeTag, Fixture.globalTag].sort());
    });

    test("a None type is not filtered at all", async () => {
        const inAcme = await IsolationLogic.unsafeOverride(acme, () => table(CatalogEntity).count());
        const global = await table(CatalogEntity).count();
        assert.equal(inAcme, global);
        assert.equal(global, 2);
    });

    test("the filter applies to an AGGREGATE, not just to a row list", async () => {
        const inAcme = await IsolationLogic.unsafeOverride(acme, () => table(ProjectEntity).count());
        assert.equal(inAcme, 2);
    });

    test("IsolationEntity itself is filtered down to the current isolation", async () => {
        const visible = await IsolationLogic.unsafeOverride(acme, () =>
            table(IsolationEntity).map(i => i.name).toArray());
        assert.deepEqual(visible, [Fixture.acme]);

        const all = await table(IsolationEntity).count();
        assert.equal(all, 2);
    });

    // ---- writing ---------------------------------------------------------------------------------

    test("a NEW row is stamped with the current isolation", async () => {
        const created = await IsolationLogic.unsafeOverride(acme, async () => {
            const p = await ProjectEntity.create({ name: `stamped-${Date.now()}` }).save();
            return p;
        });

        const reread = await ExecutionMode.global(() => table(ProjectEntity)
            .filter(p => p.id == created.id).single()) as ProjectEntity;
        assert.equal((reread as unknown as { isolation: Lite<IsolationEntity> }).isolation.key(), acme.key());
    });

    test("saving a row that belongs to ANOTHER isolation throws", async () => {
        const theirs = await ExecutionMode.global(() => IsolationLogic.unsafeOverride(globex, () =>
            table(ProjectEntity).filter(p => p.name == Fixture.globexOnlyProject).single())) as ProjectEntity;

        await assert.rejects(
            () => IsolationLogic.unsafeOverride(acme, async () => {
                theirs.name = `${Fixture.globexOnlyProject} (edited)`;
                await theirs.save();
            }),
            /has isolation .* but current isolation is/);
    });

    test("an Isolated row cannot be saved with NO isolation — the field is required", async () => {
        // Global mode does not stamp, so the required-field validator is what stops it.
        await assert.rejects(() => ProjectEntity.create({ name: `unstamped-${Date.now()}` }).save());
    });

    test("an Optional row may be saved global, and is then visible from every isolation", async () => {
        const name = `global-tag-${Date.now()}`;
        await TagEntity.create({ name }).save();

        for (const iso of [acme, globex]) {
            const visible = await IsolationLogic.unsafeOverride(iso, () =>
                table(TagEntity).filter(t => t.name == name).count());
            assert.equal(visible, 1, `the global tag must be visible from ${iso.toString()}`);
        }
    });

    // ---- unique indexes --------------------------------------------------------------------------

    test("a UNIQUE index on an Isolated type is unique PER ISOLATION", async () => {
        // Both tenants already hold a project named "Website" (the seed). That row pair only exists if the
        // index carries the isolation column — otherwise seeding would have failed.
        const count = await ExecutionMode.global(() =>
            table(ProjectEntity).filter(p => p.name == Fixture.sharedProjectName).count());
        assert.equal(count, 2);

        // And WITHIN one isolation the index still bites.
        await assert.rejects(() => IsolationLogic.unsafeOverride(acme, () =>
            ProjectEntity.create({ name: Fixture.sharedProjectName }).save()));
    });

    // ---- set-based DML ---------------------------------------------------------------------------

    test("a set-based executeInsert stamps the current isolation", async () => {
        const marker = `bulk-${Date.now()}`;
        const inserted = await IsolationLogic.unsafeOverride(acme, () =>
            table(CatalogEntity).filter(c => c.name == "Spring")
                .executeInsert(ProjectEntity, () => ({ name: marker })));

        assert.equal(inserted, 1);

        const row = await ExecutionMode.global(() =>
            table(ProjectEntity).filter(p => p.name == marker).single()) as ProjectEntity;
        assert.equal((row as unknown as { isolation: Lite<IsolationEntity> }).isolation.key(), acme.key(),
            "PreUnsafeInsert must have rewritten the constructor — a set-based insert never reaches the save pipeline");
    });

    // ---- the helpers -----------------------------------------------------------------------------

    test("getOnlyIsolation returns the shared isolation, and null when they disagree", async () => {
        const acmeProjects = await ExecutionMode.global(() => IsolationLogic.unsafeOverride(acme, () =>
            table(ProjectEntity).map(p => p.toLite()).toArray())) as Lite<ProjectEntity>[];
        const globexProjects = await ExecutionMode.global(() => IsolationLogic.unsafeOverride(globex, () =>
            table(ProjectEntity).map(p => p.toLite()).toArray())) as Lite<ProjectEntity>[];

        const same = await ExecutionMode.global(() => IsolationLogic.getOnlyIsolation(acmeProjects));
        assert.equal(same?.key(), acme.key());

        const mixed = await ExecutionMode.global(() =>
            IsolationLogic.getOnlyIsolation([...acmeProjects, ...globexProjects]));
        assert.equal(mixed, null);
    });

    test("a None type contributes no isolation to getOnlyIsolation", async () => {
        const catalogs = await table(CatalogEntity).map(c => c.toLite()).toArray() as Lite<CatalogEntity>[];
        assert.equal(await IsolationLogic.getOnlyIsolation(catalogs), null);
    });

    // ---- ExecutionMode.withIsolationOf -----------------------------------------------------------

    test("withIsolationOf adopts the row's own isolation — what a background runner does", async () => {
        const row = await ExecutionMode.global(() => IsolationLogic.unsafeOverride(globex, () =>
            table(ProjectEntity).filter(p => p.name == Fixture.globexOnlyProject).single())) as ProjectEntity;

        const seen = ExecutionMode.withIsolationOf(row, () => IsolationLogic.current());
        assert.equal(seen?.key(), globex.key());
    });

    test("withIsolationOf takes the FIRST candidate that has one (Signum's `?? `)", async () => {
        const unIsolated = await table(CatalogEntity).filter(c => c.name == "Spring").single() as CatalogEntity;
        const isolated = await ExecutionMode.global(() => IsolationLogic.unsafeOverride(acme, () =>
            table(ProjectEntity).filter(p => p.name == Fixture.acmeOnlyProject).single())) as ProjectEntity;

        const seen = ExecutionMode.withIsolationOf([unIsolated, isolated], () => IsolationLogic.current());
        assert.equal(seen?.key(), acme.key());
    });
});
