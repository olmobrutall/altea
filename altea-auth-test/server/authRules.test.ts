import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { Serializer } from "@altea/altea/data/serializer";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { toInt } from "@altea/altea/data/basics";
import { TypeAuthLogic } from "@altea/altea-auth/server/TypeAuthLogic";
import { TypeAllowedBasic } from "@altea/altea-auth/data/Rules";
import type { PrimaryKey } from "@altea/altea/data/entity";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { SampleEntity, SampleOperation } from "../data/sample";
import { start, hasDb, asRole, role, Roles } from "./setup";

// Server-side authorization tests, run against the seeded role/rule fixture (see setup.ts). Each case
// `asRole(...)`s to set the current role, then calls the engine directly (no HTTP). Covers: default-allowed
// (merge-strategy roots), the type dimension, operation + inheritance/auto-propagate, row-level type
// conditions (per-instance), and property hide/read-only/coerce (through the real serializer gate).

describe("AuthRules", { skip: hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable" }, () => {

    let superR: RoleEntity, base: RoleEntity, sales: RoleEntity, manager: RoleEntity, restricted: RoleEntity;
    let typeId: PrimaryKey;

    before(async () => {
        await start();
        [superR, base, sales, manager, restricted] = await Promise.all([
            role(Roles.Super), role(Roles.Base), role(Roles.Sales), role(Roles.Manager), role(Roles.Restricted),
        ]);
        typeId = TypeLogic.typeToId(SampleEntity);
    });

    // A concrete SampleEntity (existing id, so the read-gate treats it as a root).
    function sample(confidential: boolean, secret = "top"): SampleEntity {
        const e = SampleEntity.create({ name: "S", secret, confidential, value: toInt(1) });
        e.id = toInt(1); e.isNew = false;
        return e;
    }
    const canRead = (): Promise<boolean> => TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Read, true);
    const canWrite = (): Promise<boolean> => TypeAuthLogic.isAllowedForType(typeId, TypeAllowedBasic.Write, true);

    describe("role defaults (merge-strategy roots)", () => {
        test("Intersection root ⇒ default-allowed: Super sees everything with no rule", async () => {
            assert.equal(await asRole(superR, canWrite), true);
        });
        test("Union root ⇒ deny-by-default: Base sees nothing with no rule", async () => {
            assert.equal(await asRole(base, canRead), false);
        });
    });

    describe("type dimension", () => {
        test("Sales: Read yes, Write no", async () => {
            assert.equal(await asRole(sales, canRead), true);
            assert.equal(await asRole(sales, canWrite), false);
        });
        test("Manager: Write yes (overrides the inherited Read)", async () => {
            assert.equal(await asRole(manager, canWrite), true);
        });
    });

    describe("operation dimension + inheritance (auto-propagate)", () => {
        const canSave = (): Promise<boolean> =>
            OperationLogic.isOperationAllowed(SampleOperation.Save, SampleEntity, false, sample(false));
        test("Sales: Save allowed (explicit rule)", async () => {
            assert.equal(await asRole(sales, canSave), true);
        });
        test("Base: Save denied (no rule, deny-by-default)", async () => {
            assert.equal(await asRole(base, canSave), false);
        });
        test("Manager: Save allowed via INHERITANCE from Sales (no explicit Manager rule)", async () => {
            assert.equal(await asRole(manager, canSave), true);
        });
    });

    describe("row-level type conditions (per instance)", () => {
        const canReadInstance = (e: SampleEntity): Promise<boolean> =>
            TypeAuthLogic.isAllowedFor(e, TypeAllowedBasic.Read, true);
        test("Restricted (fallback None, [Public] → Read): can read a Public row", async () => {
            assert.equal(await asRole(restricted, () => canReadInstance(sample(false))), true);
        });
        test("Restricted: CANNOT read a Confidential row (fallback None applies)", async () => {
            assert.equal(await asRole(restricted, () => canReadInstance(sample(true))), false);
        });
    });

    describe("property dimension (hide / read-only / coerce), through the serializer", () => {
        const ser = (e: SampleEntity): Record<string, unknown> => JSON.parse(Serializer.stringify(e));

        test("Sales: `secret` (None) is hidden; `name` (no rule) follows the type's Read ⇒ read-only", async () => {
            const o = await asRole(sales, async () => ser(sample(false)));
            assert.equal(o.secret, undefined, "None property is omitted from the wire");
            assert.ok(Array.isArray(o.propsMeta));
            assert.ok((o.propsMeta as string[]).includes("!secret"), "propsMeta marks `secret` hidden");
            assert.ok((o.propsMeta as string[]).includes("name"), "`name` (no rule) follows the type's Read ⇒ read-only");
        });
        test("Manager: `secret` (Read) is read-only (written + flagged); `name` (type Write) is writable", async () => {
            const o = await asRole(manager, async () => ser(sample(false)));
            assert.equal(o.secret, "top", "Read property is still written");
            assert.ok((o.propsMeta as string[] | undefined)?.includes("secret"), "propsMeta marks `secret` read-only");
            assert.ok(!((o.propsMeta as string[] | undefined)?.includes("name")), "`name` is writable (not in propsMeta)");
        });
    });
});
