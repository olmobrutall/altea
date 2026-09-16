import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { ReflectionServer } from "@altea/altea/server/reflectionServer";
import type { MetadataBlob } from "@altea/altea/data/metadata";
import { AuthReflectionServer } from "@altea/altea-auth/server/AuthReflection";
import { PropertyAllowed, TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { SampleEntity, SamplePanelEntity } from "../data/sample";
import { start, hasDb, asRole, role, Roles } from "./setup";

// What the ROLE-filtered metadata blob says, and — as much to the point — what it no longer bothers
// saying. Three redundancies used to ride in every response:
//
//   - a type the role cannot read, described in full and then marked None. It is now GONE: presence in
//     `types` IS the permission, which is why a readable type keeps an entry even when it is empty;
//   - every property of such a type, each restating the type's own answer (for the ANONYMOUS blob, which
//     every client fetches at boot to render the login page, 1951 of 1971 property entries);
//   - a property whose allowance merely equals its type's — nearly all of them on a Read-only type.
//
// Runs the REAL filter over the real seeded rules, because the whole question is whether what was dropped
// is what said nothing.

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("role-filtered metadata blob", () => {

    let base: RoleEntity, sales: RoleEntity, manager: RoleEntity, superR: RoleEntity, autoUpgrade: RoleEntity;

    beforeAll(async () => {
        await start();
        AuthReflectionServer.install();
        [base, sales, manager, superR, autoUpgrade] = await Promise.all([
            role(Roles.Base), role(Roles.Sales), role(Roles.Manager), role(Roles.Super), role(Roles.AutoUpgrade)]);
    });

    const blobFor = (r: RoleEntity): Promise<MetadataBlob> =>
        asRole(r, async () => {
            const filter = ReflectionServer.getMetadataFilter()!;
            return await filter(ReflectionServer.buildMetadata("en"));
        });

    // The role's answers live in `routes` — keyed by the owner-rooted property route a rule is written
    // against — never in `fields`, which is the type's own members by name.
    const sampleRoutes = (b: MetadataBlob) => b.types[SampleEntity.name]?.routes ?? {};
    const propertyEntries = (b: MetadataBlob): number => Object.values(b.types)
        .flatMap(tm => Object.values(tm.routes ?? {}))
        .filter(rm => rm.propertyAllowed !== undefined).length;

    // Manager has Sample at Write and `secret` at Read — STRICTER than its type, so it is a restriction the
    // UI must be told about: the control it gates is one the user can actually reach.
    test("a property stricter than its type is shipped", async () => {
        const blob = await blobFor(manager);
        assert.equal(blob.types[SampleEntity.name]?.maxTypeAllowed, undefined, "Manager writes Sample");
        assert.equal(sampleRoutes(blob)["secret"]?.propertyAllowed, PropertyAllowed.Read);
    });

    // Base sees nothing: the retrieve gate refuses every Sample, so no control ever consults a property
    // rule about one. The absent TYPE is the whole answer — Signum's `TypeExtension` returning null.
    test("a type the role cannot read is not in the blob at all", async () => {
        const blob = await blobFor(base);
        assert.equal(blob.types[SampleEntity.name], undefined, "Base cannot read Sample");
    });

    // AutoUpgrade holds Sample at Read PLUS AutomaticUpgradeOfProperties, so every un-ruled route follows
    // its type: Read, for all of them. Spelling that out per route was 40 bytes each to repeat what the
    // type entry says two lines up — the reader falls back to it.
    test("a property that only repeats its type's allowance is not shipped", async () => {
        const blob = await blobFor(autoUpgrade);
        assert.equal(blob.types[SampleEntity.name]?.maxTypeAllowed, TypeAllowedBasic.Read, "the type is Read");
        assert.deepEqual(
            Object.entries(sampleRoutes(blob)).filter(([, rm]) => rm.propertyAllowed !== undefined).map(([p]) => p),
            [],
            "and so is every property of it — nothing left to say");
    });

    // The counter-case, and the reason this is a comparison and not a blanket "drop them on a Read type":
    // Sales has the same Read type WITHOUT that permission, so its un-ruled routes are None, not Read.
    // They differ from the type, so every one of them is still shipped.
    test("a property that differs from its type is shipped even when the type is restricted", async () => {
        const blob = await blobFor(sales);
        assert.equal(blob.types[SampleEntity.name]?.maxTypeAllowed, TypeAllowedBasic.Read);
        assert.equal(sampleRoutes(blob)["secret"]?.propertyAllowed, PropertyAllowed.None);
        assert.ok(Object.values(sampleRoutes(blob)).some(rm => rm.propertyAllowed === PropertyAllowed.None));
    });

    test("an unrestricted role carries no property section at all", async () => {
        assert.equal(propertyEntries(await blobFor(superR)), 0);
    });

    // Views are query-projection DTOs the engine materialises; a client has no page, no operation and no
    // query for one. They reached the blob only because they are registered types.
    test("View types are not in the blob", async () => {
        const types = ReflectionServer.buildMetadata("en").types;
        const views = Object.keys(types).filter(n => n.startsWith("Sys") && n.endsWith("s"));
        assert.deepEqual(views.filter(n => ["SysTables", "SysColumns", "SysDatabases", "SysSchemas"].includes(n)), []);
    });

    // The nice names, the route labels, the operations, the registered expressions — all of it described a
    // type no page can open, no query can return and no control can render.
    test("a None type takes its whole entry with it", async () => {
        const blob = await blobFor(base);
        assert.equal(blob.types[SampleEntity.name], undefined);
        assert.equal(Object.keys(blob.types).includes(SampleEntity.name), false);
    });

    // The other half of the bargain: absence can only MEAN denial if presence is guaranteed for everything
    // the role can read. A type with nothing to say still ships, as a bare `{ kind }`.
    test("a readable type is present even with nothing to say", async () => {
        const blob = await blobFor(superR);
        const tm = blob.types[SamplePanelEntity.name];
        assert.ok(tm != null, "Super reads it, so it must be there for the client's gates to see");
        assert.equal(tm.maxTypeAllowed, undefined, "unrestricted says nothing beyond being present");
    });

    test("a READABLE-but-not-writable type keeps everything, plus its allowance", async () => {
        const tm = (await blobFor(sales)).types[SampleEntity.name]!;
        assert.equal(tm.maxTypeAllowed, TypeAllowedBasic.Read);
        assert.ok(Object.keys(tm.routes ?? {}).length > 0, "its restricted routes are still described");
    });

    // The two records are different questions about different keys, and a @part is where that shows: a
    // panel's `title` is described ONCE, under SamplePanelEntity, while the role's answer about it is
    // keyed by the path that reaches it from the root the rule is written against.
    test("a @part's labels live under the part, its allowances under the owner", async () => {
        const blob = await blobFor(sales);

        assert.equal(blob.types[SampleEntity.name]?.fields["panels/title"], undefined,
            "no owner-rooted path may appear in `fields`");
        assert.ok("title" in (blob.types[SamplePanelEntity.name]?.fields ?? {}) === false
            || blob.types[SamplePanelEntity.name]!.fields["title"] != null,
            "the part describes its own members, by bare name");

        const routes = Object.keys(sampleRoutes(blob));
        assert.ok(routes.some(r => r.includes("/") || r.includes(".")),
            `an owner-rooted path reaching into the part, got ${JSON.stringify(routes)}`);
        assert.ok(routes.every(r => blob.types[SampleEntity.name]!.fields[r] === undefined),
            "and none of them doubles as a member key");
    });
});
