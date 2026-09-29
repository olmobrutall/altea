import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import type { uuid } from "@altea/altea/data/basics";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { AzureADConfigurationEmbedded, AzureADType } from "@altea/altea-auth-azuread/data/AzureAD";

// The configuration's validation, as Signum's PropertyValidation + StateValidator: the ids are always
// Guids, and which user flows a product takes is only checked while the directory is enabled.

const emptyGuid = "00000000-0000-0000-0000-000000000000" as uuid;

function config(values: Partial<AzureADConfigurationEmbedded>): AzureADConfigurationEmbedded {
    return AzureADConfigurationEmbedded.create({ applicationID: emptyGuid, directoryID: emptyGuid, roleMapping: [], ...values });
}

function error(c: AzureADConfigurationEmbedded, field: keyof AzureADConfigurationEmbedded & string): string | null {
    return (entityIntegrityCheck(c, "Saving")?.errors as Record<string, string> | undefined)?.[field] ?? null;
}

describe("AzureADConfigurationEmbedded", () => {

    test("the ids must be Guids, whether or not the directory is enabled", () => {
        assert.equal(error(config({}), "applicationID"), null);
        assert.match(error(config({ applicationID: "not-a-guid" as uuid }), "applicationID") ?? "", /Guid/);
        assert.match(error(config({ enabled: true, directoryID: "x" as uuid }), "directoryID") ?? "", /Guid/);
    });

    test("a disabled directory checks no flows", () =>
        assert.equal(error(config({ type: AzureADType.AzureAD, tenantName: "contoso" }), "tenantName"), null));

    test("an Entra ID tenant takes no tenant name or flows", () =>
        assert.ok(error(config({ enabled: true, type: AzureADType.AzureAD, tenantName: "contoso" }), "tenantName") != null));

    test("External ID needs a tenant domain and a sign-in URL", () => {
        const c = config({ enabled: true, type: AzureADType.ExternalID });
        assert.ok(error(c, "tenantName") != null);
        assert.ok(error(c, "signInSignUp_UserFlow") != null);

        c.tenantName = "contoso";
        assert.match(error(c, "tenantName") ?? "", /b2clogin/);
        c.tenantName = "contoso.ciamlogin.com";
        c.signInSignUp_UserFlow = "https://contoso.ciamlogin.com/";
        assert.equal(error(c, "tenantName"), null);
        assert.equal(error(c, "signInSignUp_UserFlow"), null);
    });

    test("B2C takes either sign-in flow", () => {
        const c = config({ enabled: true, type: AzureADType.B2C, tenantName: "contoso" });
        assert.ok(error(c, "signInSignUp_UserFlow") != null);
        c.signIn_UserFlow = "B2C_1_signin";
        assert.equal(error(c, "signInSignUp_UserFlow"), null);
    });
});
