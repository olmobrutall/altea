import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Metadata, type TypeMetadata } from "@altea/altea/data/metadata";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";

// A specific culture inherits its NEUTRAL culture's translations, as a .NET CultureInfo falls back to its
// parent: the files are `App.de.xml` while the request runs in `de-DE` (a user's saved preference, a
// CultureInfo row). Made-up culture names, so nothing a real suite loaded is touched.

const neutral = { niceName: "Neutral", fields: { a: { niceName: "A neutral" }, b: { niceName: "B neutral" } } } as unknown as TypeMetadata;
const specific = { fields: { b: { niceName: "B specific" } } } as unknown as TypeMetadata;

Metadata.merge("xq", { FallbackThing: neutral });
Metadata.merge("xq-YY", { FallbackThing: specific });

describe("neutral culture fallback", () => {

    test("a specific culture with nothing of its own gets the neutral one", () => {
        const t = Metadata.forCulture("xq-ZZ")["FallbackThing"];
        assert.equal(t?.niceName, "Neutral");
        assert.equal(t?.fields["b"]?.niceName, "B neutral");
    });

    test("its own keys override the neutral ones, per key", () => {
        const t = Metadata.forCulture("xq-YY")["FallbackThing"];
        assert.equal(t?.niceName, "Neutral");
        assert.equal(t?.fields["a"]?.niceName, "A neutral");
        assert.equal(t?.fields["b"]?.niceName, "B specific");
    });

    test("tryType falls back for the current UI culture", () => {
        const old = CultureInfo.defaultUICulture();
        CultureInfo.setDefaultUICulture("xq-ZZ");
        try {
            assert.equal(Metadata.tryType("FallbackThing")?.niceName, "Neutral");
        } finally {
            CultureInfo.setDefaultUICulture(old);
        }
    });
});
