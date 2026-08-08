import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { NotNullValidator, notNullValidator } from "@altea/altea/data/validators";
import { reflect, Validator } from "@altea/altea/data/reflection";
import type { IntegrityCheckEnvironment } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { ArtistEntity, ArtistEntity_Friends } from "../music";

const FI = { niceToString: () => "X" } as any;

// A NotNullValidator with a `disabled` predicate (decorators set it via ValidatorOptions; here we set
// the inherited field directly for a unit test).
function notNull(disabled?: (env: IntegrityCheckEnvironment) => boolean): Validator {
    const v = new NotNullValidator();
    v.disabled = disabled;
    return v;
}

// A non-nullable string that opts OUT of the implicit NotNull with an explicit, disabled one. Declared
// at class-definition time (as real code would), so the implicit-NotNull decision sees it up front.
@reflect
class OptOutEmbedded extends EmbeddedEntity {
    @notNullValidator({ disabled: () => true })
    name!: string;
}

// Verifies Signum's implicit NotNullValidator behaviour ported to altea (env "Saving" — the strictest,
// no validator is env-disabled by default so any env behaves the same here):
describe("implicit NotNullValidator", () => {

    test("a non-nullable string field (ArtistEntity.name) is required automatically", () => {
        const ic = entityIntegrityCheck(new ArtistEntity(), "Saving");
        assert.ok(ic != null, "expected an integrity error");
        assert.ok(ic!.errors["name"] != null, `expected 'name' to be required, got ${JSON.stringify(ic!.errors)}`);
    });

    test('"" counts as not set', () => {
        const a = new ArtistEntity();
        a.name = "";
        assert.ok(entityIntegrityCheck(a, "Saving")?.errors["name"] != null, "empty string should fail NotNull");
    });

    test("a set value passes", () => {
        const a = new ArtistEntity();
        a.name = "Michael";
        assert.equal(entityIntegrityCheck(a, "Saving")?.errors["name"], undefined);
    });

    test("value types & enums ARE required in TS (divergence from Signum); nullable & arrays are not", () => {
        const a = new ArtistEntity();
        a.name = "x";
        const ic = entityIntegrityCheck(a, "Saving");
        assert.ok(ic?.errors["dead"] != null, "non-nullable boolean should be required");
        assert.ok(ic?.errors["sex"] != null, "non-nullable enum should be required");
        assert.equal(ic?.errors["status"], undefined);
        assert.equal(ic?.errors["lastAward"], undefined);
        assert.equal(ic?.errors["friends"], undefined);
    });

    test("a non-null @backReference is exempt; a non-null @valueField reference is required", () => {
        const ic = entityIntegrityCheck(new ArtistEntity_Friends(), "Saving");
        assert.equal(ic?.errors["artist"], undefined, "backReference must NOT be required");
        assert.ok(ic?.errors["friend"] != null, "valueField Lite reference must be required");
    });
});

// The env-based `disabled` opt-out (Signum's Disabled / DisabledInModelBinder unified into a predicate).
describe("Validator.disabled per IntegrityCheckEnvironment", () => {

    test("disabled: () => true opts out everywhere", () => {
        const v = notNull(() => true);
        assert.equal(v.error(null, {}, FI, "Client"), null);
        assert.equal(v.error(null, {}, FI, "ServerDeserialization"), null);
        assert.equal(v.error(null, {}, FI, "Saving"), null);
    });

    test("server-only (disabled on Client) runs on the server phases only", () => {
        const v = notNull(env => env === "Client");
        assert.equal(v.error(null, {}, FI, "Client"), null, "skipped on the client");
        assert.ok(v.error(null, {}, FI, "ServerDeserialization") != null, "runs after deserialization");
        assert.ok(v.error(null, {}, FI, "Saving") != null, "runs before saving");
    });

    test("save-only (enforced only when Saving)", () => {
        const v = notNull(env => env !== "Saving");
        assert.equal(v.error(null, {}, FI, "Client"), null);
        assert.equal(v.error(null, {}, FI, "ServerDeserialization"), null);
        assert.ok(v.error(null, {}, FI, "Saving") != null);
    });

    test("no disabled → runs in every environment", () => {
        const v = notNull();
        for (const env of ["Client", "ServerDeserialization", "Saving"] as const)
            assert.ok(v.error(null, {}, FI, env) != null, `should run in ${env}`);
    });

    test("an explicit (disabled) NotNullValidator suppresses the implicit one", () => {
        const e = new OptOutEmbedded(); // name unset, but the explicit disabled NotNull wins
        assert.equal(entityIntegrityCheck(e, "Saving")?.errors["name"], undefined, "explicit disabled NotNull wins");
    });
});
