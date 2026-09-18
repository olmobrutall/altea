import { describe, test } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { PermissionSymbol, BasicPermission } from "@altea/altea/data/permissionSymbol";

// PermissionSymbol and PermissionLogic are CORE, where Signum keeps them (Signum/Basics). This suite runs
// with NO authorization module, which is precisely the configuration that pins the divergence from Signum:
// Signum's IsAuthorizedImplementation is a non-nullable Func with no initialiser, so IsAuthorized() throws
// a NullReferenceException when Signum.Authorization was never started. Here it ALLOWS — an application
// with no authorization module has no policy to refuse by.
//
// The other half of the seam (core's answer coming from the authorization module) is pinned in
// altea-auth/test/server/permissionSeam.test.ts, which runs with that module started.

describe("PermissionLogic (no authorization module)", () => {

    test("with no implementation registered, every permission is allowed", async () => {
        assert.equal(await PermissionLogic.isAuthorizedString(BasicPermission.AdminRules), null);
        assert.equal(await PermissionLogic.isAuthorized(BasicPermission.AdminRules), true);
        await PermissionLogic.assertAuthorized(BasicPermission.AdminRules);
    });

    test("registerContainer registers every PermissionSymbol the container declares", () => {
        PermissionLogic.registerContainer(BasicPermission);
        const registered = PermissionLogic.registeredPermissions();
        for (const p of Object.values(BasicPermission))
            assert.equal(registered.includes(p), true, `${p.key} was not registered`);
    });

    test("registerContainer refuses a container that declares no permission", () => {
        assert.throws(() => PermissionLogic.registerContainer({ notAPermission: 1 }),
            /declares no PermissionSymbol/);
    });

    test("registerPermissions refuses a null, which is an undeclared init()", () => {
        assert.throws(() => PermissionLogic.registerPermissions(null as unknown as PermissionSymbol),
            /was it declared with init\(\)/);
    });
});
