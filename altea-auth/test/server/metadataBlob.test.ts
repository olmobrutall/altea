import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { ReflectionServer } from "@altea/altea/server/reflectionServer";
import type { MetadataBlob } from "@altea/altea/data/metadata";
import { AuthReflectionServer } from "@altea/altea-auth/server/AuthReflection";
import { PropertyAllowed, TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { SampleEntity } from "../data/sample";
import { start, hasDb, asRole, role, Roles } from "./setup";

// What the ROLE-filtered metadata blob says about properties, and — as much to the point — what it no
// longer bothers saying. The property section used to restate "you may not read this" once per property
// of a type the role cannot read at all, which for the ANONYMOUS blob (fetched by every client at boot,
// before login, to render the login page) was 1951 of 1971 entries.
//
// Runs the REAL filter over the real seeded rules, because the whole question is whether the entries that
// were dropped are the ones that say nothing.

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("role-filtered metadata blob", () => {

    let base: RoleEntity, manager: RoleEntity, superR: RoleEntity;

    beforeAll(async () => {
        await start();
        AuthReflectionServer.install();
        [base, manager, superR] = await Promise.all([role(Roles.Base), role(Roles.Manager), role(Roles.Super)]);
    });

    const blobFor = (r: RoleEntity): Promise<MetadataBlob> =>
        asRole(r, async () => {
            const filter = ReflectionServer.getMetadataFilter()!;
            return await filter(ReflectionServer.buildMetadata("en"));
        });

    const sampleFields = (b: MetadataBlob) => b.types[SampleEntity.name]?.fields ?? {};
    const propertyEntries = (b: MetadataBlob): number => Object.values(b.types)
        .flatMap(tm => Object.values(tm.fields ?? {}))
        .filter(fm => fm.propertyAllowed !== undefined).length;

    // Manager reads Sample and has `secret` at Read — a restriction the UI must be told about, because the
    // control it gates is one the user can actually reach.
    test("a restricted property on a READABLE type is still shipped", async () => {
        const blob = await blobFor(manager);
        assert.notEqual(blob.types[SampleEntity.name]?.maxTypeAllowed, TypeAllowedBasic.None, "Manager can read Sample");
        assert.equal(sampleFields(blob)["secret"]?.propertyAllowed, PropertyAllowed.Read);
    });

    // Base sees nothing: the retrieve gate refuses every Sample, so no control ever consults a property
    // rule about one. Saying it per property is 62 bytes each to repeat the type's own answer.
    test("a type the role cannot read at all ships NO property rules", async () => {
        const blob = await blobFor(base);
        assert.equal(blob.types[SampleEntity.name]?.maxTypeAllowed, TypeAllowedBasic.None, "Base cannot read Sample");
        assert.deepEqual(
            Object.entries(sampleFields(blob)).filter(([, fm]) => fm.propertyAllowed !== undefined).map(([p]) => p),
            [],
            "the type-level None is the whole answer");
    });

    // The coarse case — no type condition, so the range is a single point — is most of every blob, and
    // shipping one number three times was the shape of it.
    test("min/max are omitted when they equal the fallback", async () => {
        const secret = sampleFields(await blobFor(manager))["secret"]!;
        assert.equal(secret.propertyAllowed, PropertyAllowed.Read);
        assert.equal(secret.minPropertyAllowed, undefined);
        assert.equal(secret.maxPropertyAllowed, undefined);
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

    // A type the role cannot read is reduced to saying exactly that. Signum drops it from the blob
    // outright; altea keeps the husk because its client reads a MISSING entry as unrestricted, so
    // dropping would turn a forbidden type into an allowed one — the husk says the opposite.
    test("a None type keeps its allowance and nothing else", async () => {
        const tm = (await blobFor(base)).types[SampleEntity.name]!;

        assert.equal(tm.maxTypeAllowed, TypeAllowedBasic.None);
        assert.equal(tm.minTypeAllowed, undefined, "min == max, so only max is shipped");
        assert.deepEqual(Object.keys(tm.fields), [], "no route labels");
        assert.equal(tm.operations, undefined, "no operations it could never run");
        assert.equal(tm.extensions, undefined, "no registered expressions");
        assert.equal(tm.niceName, undefined, "not even a label");
        assert.equal(tm.kind, "Entity", "the kind stays — the type does exist");
    });

    // The husk must not read as "unrestricted": Navigator's isViewable/isCreable gates treat an ABSENT
    // entry as allowed, which is what makes dropping the entry the wrong move.
    test("a None type is still present, so the client's gates see it", async () => {
        assert.ok((await blobFor(base)).types[SampleEntity.name] != null);
    });

    test("a READABLE-but-not-writable type keeps everything, plus its allowance", async () => {
        const tm = (await blobFor(manager)).types[SampleEntity.name]!;
        assert.notEqual(tm.maxTypeAllowed, TypeAllowedBasic.None);
        assert.ok(Object.keys(tm.fields).length > 0, "its routes are still described");
    });
});
