import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { NotNullValidator, notNullValidator } from "@altea/altea/data/validators";
import { reflect, Validator } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { ArtistEntity, ArtistEntity_Friends } from "../music";

// A non-nullable string that opts OUT of the implicit NotNull with an explicit, disabled one. Declared
// at class-definition time (as real code would), so the implicit-NotNull decision sees it up front.
@reflect
class OptOutEmbedded extends EmbeddedEntity {
    @notNullValidator({ disabled: true })
    name!: string;
}

// Verifies Signum's implicit NotNullValidator behaviour ported to altea:
//   - a non-nullable string / reference is required automatically (no decorator);
//   - "" counts as null;
//   - a non-null @backReference is exempt (wired by the save cascade, not the user);
//   - value types / enums / arrays are NOT auto-required.
describe("implicit NotNullValidator", () => {

    test("a non-nullable string field (ArtistEntity.name) is required automatically", () => {
        const a = new ArtistEntity();
        const ic = entityIntegrityCheck(a);
        assert.ok(ic != null, "expected an integrity error");
        assert.ok(ic!.errors["name"] != null, `expected 'name' to be required, got ${JSON.stringify(ic!.errors)}`);
    });

    test('"" counts as not set', () => {
        const a = new ArtistEntity();
        a.name = "";
        assert.ok(entityIntegrityCheck(a)?.errors["name"] != null, "empty string should fail NotNull");
    });

    test("a set value passes", () => {
        const a = new ArtistEntity();
        a.name = "Michael";
        assert.equal(entityIntegrityCheck(a)?.errors["name"], undefined);
    });

    test("value types & enums ARE required in TS (divergence from Signum); nullable & arrays are not", () => {
        const a = new ArtistEntity();
        a.name = "x";
        const ic = entityIntegrityCheck(a);
        // dead:boolean and sex:enum are non-nullable value types → required (undefined on a fresh entity,
        // unlike a C# struct which is physically non-null).
        assert.ok(ic?.errors["dead"] != null, "non-nullable boolean should be required");
        assert.ok(ic?.errors["sex"] != null, "non-nullable enum should be required");
        // status:enum|null and lastAward:Entity|null are nullable; friends:[] is an array → NOT required.
        assert.equal(ic?.errors["status"], undefined);
        assert.equal(ic?.errors["lastAward"], undefined);
        assert.equal(ic?.errors["friends"], undefined);
    });

    test("a non-null @backReference is exempt; a non-null @valueField reference is required", () => {
        const row = new ArtistEntity_Friends();
        const ic = entityIntegrityCheck(row);
        assert.equal(ic?.errors["artist"], undefined, "backReference must NOT be required");
        assert.ok(ic?.errors["friend"] != null, "valueField Lite reference must be required");
    });
});

// The explicit @notNullValidator escape hatches.
describe("explicit NotNullValidator options", () => {

    test("{ disabled: true } opts out", () => {
        assert.equal(new NotNullValidator({ disabled: true }).error(null, {} as any, { niceToString: () => "X" } as any), null);
    });

    test("{ disableInServerDeserialization: true } is skipped only inside runInServerDeserialization", () => {
        const v = new NotNullValidator({ disableInServerDeserialization: true });
        const fi = { niceToString: () => "X" } as any;
        assert.ok(v.error(null, {} as any, fi) != null, "required outside server deserialization");
        Validator.runInServerDeserialization(() => {
            assert.equal(v.error(null, {} as any, fi), null, "skipped during server deserialization");
        });
    });

    test("an explicit (disabled) NotNullValidator suppresses the implicit one", () => {
        const e = new OptOutEmbedded(); // name is unset, but the explicit disabled NotNull wins
        assert.equal(entityIntegrityCheck(e)?.errors["name"], undefined, "explicit disabled NotNull wins");
    });
});
