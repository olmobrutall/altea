import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { BasicPermission } from "@altea/altea/data/permissionSymbol";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import type { RoleEntity } from "@altea/altea-auth/data/Role";
import { start, hasDb, asRole, role, Roles } from "./setup";

// PermissionSymbol and PermissionLogic live in CORE, where Signum keeps them
// (Signum/Basics/PermissionLogic.cs), and the CHECK is a seam this module fills from
// `PermissionAuthLogic.start`. That is what lets a module declare, register and check a permission without
// depending on the authorization package. These tests pin the seam itself: that asking CORE gives the
// authorization module's answer, and that a refusal carries a real message rather than a bare false.
//
// The complementary half — core ALLOWS when no implementation is registered — is pinned in the framework's
// own suite (altea/test/server/permissionLogic.test.ts), which runs with no authorization module at all.

describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("PermissionLogic seam", () => {

    let autoUpgrade: RoleEntity, sales: RoleEntity;

    beforeAll(async () => {
        await start();
        [autoUpgrade, sales] = await Promise.all([role(Roles.AutoUpgrade), role(Roles.Sales)]);
    });

    const permission = BasicPermission.AutomaticUpgradeOfProperties;

    test("core's isAuthorized routes through the authorization module", async () => {
        // AutoUpgrade is granted this permission by the fixture; Sales has no rule for it and its role
        // default denies. Both answers must arrive through CORE, not only through PermissionAuthLogic.
        assert.equal(await asRole(autoUpgrade, () => PermissionLogic.isAuthorized(permission)), true);
        assert.equal(await asRole(sales, () => PermissionLogic.isAuthorized(permission)), false);
    });

    test("core and the authorization module agree", async () => {
        for (const r of [autoUpgrade, sales])
            assert.equal(
                await asRole(r, () => PermissionLogic.isAuthorized(permission)),
                await asRole(r, () => PermissionAuthLogic.isAuthorized(permission)));
    });

    test("a refusal carries the permission's name, and assertAuthorized throws it", async () => {
        const message = await asRole(sales, () => PermissionLogic.isAuthorizedString(permission));
        assert.notEqual(message, null);
        assert.match(String(message), /AutomaticUpgradeOfProperties/);

        await assert.rejects(
            () => asRole(sales, () => PermissionLogic.assertAuthorized(permission)),
            /AutomaticUpgradeOfProperties/);

        // The allowed role gets no message and no throw.
        assert.equal(await asRole(autoUpgrade, () => PermissionLogic.isAuthorizedString(permission)), null);
        await asRole(autoUpgrade, () => PermissionLogic.assertAuthorized(permission));
    });
});
