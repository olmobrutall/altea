import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Entity } from "@altea/altea/entities/entity";
import { reflect, getOrCreateTypeInfo, setDefaultTypeDescription, registerType } from "@altea/altea/entities/reflection";
import { setDefaultCulture, getPackageCulture, cultureForName, setDefaultDatabaseSchema, schemaForName } from "@altea/altea/entities/reflection";
import { niceName, nicePluralName, gender } from "@altea/altea/entities/decorators";
import { Localization } from "@altea/altea/entities/utils/localization";
import { CultureInfo } from "@altea/altea/entities/utils/cultureInfo";
import { Enum } from "@altea/altea/entities/enum";
import { SchemaSettings } from "@altea/altea/server/schema/schemaBuilder";
import { ArtistOperation } from "../entities/testOperations";
import { ArtistEntity } from "../entities/music";

// A top-level setDefaultDatabaseSchema call, so the compiled output can be checked for the transformer's
// injected __fileInfo. Placed here in test/ (no entities live under test/), so it registers a scope that
// matches no real entity — the DB suite's schema build is untouched.
setDefaultDatabaseSchema("testDbo");

// Code-declared DEFAULT-language nice names — no translation file needed (the @niceName /
// @nicePluralName / @gender decorators, Enum.setNiceName, and operation init({ niceName })). The
// decorators use the bare names; the localization resolvers live under `Localization`. Pure in-memory,
// no DB. Verifies each override beats the humanized fallback, and that a loaded translation still wins.

@niceName("Person") @nicePluralName("People")
@reflect
class PersonThing extends Entity {
    @niceName("e-Mail") email!: string;
    // No override → humanized fallback ("firstName" → "First name").
    firstName!: string;
}

enum ColorEnum { Weiss, Rot }

// German-gendered type: without @gender the detector would guess from the ending; @gender pins it.
@gender("m")
class PerroEntity extends Entity { }

describe("nice-name overrides (no translation file)", () => {
    test("@niceName / @nicePluralName override a type's nice name", () => {
        assert.equal(Localization.niceName(PersonThing), "Person");
        assert.equal(Localization.nicePluralName(PersonThing), "People");
    });

    test("@niceName on a field overrides the member's nice name; others humanize", () => {
        const ti = getOrCreateTypeInfo(PersonThing);
        assert.equal(ti.fields["email"].niceToString(), "e-Mail");
        assert.equal(ti.fields["firstName"].niceToString(), "First name");
    });

    test("Enum.setNiceName overrides an enum member; others humanize", () => {
        Enum.setNiceName(ColorEnum, "Weiss", "Weiß");
        assert.equal(Enum.niceName(ColorEnum, "Weiss"), "Weiß");
        assert.equal(Enum.niceName(ColorEnum, "Rot"), "Rot");
    });

    test("operation init({ niceName }) registers a default operation label", () => {
        assert.equal(ArtistOperation.CreateFromScratch.key, "ArtistOperation.CreateFromScratch");
        // The client Operations layer resolves an operation's label via DescriptionManager.translate.
        assert.equal(Localization.translate("ArtistOperation", "CreateFromScratch"), "Create Artist from scratch");
    });

    test("@gender pins a type's grammatical gender", () => {
        assert.equal(Localization.gender(PerroEntity), "m");
    });

    test("setDefaultCulture is package-scoped", () => {
        // Call with an explicit FileInfo (a fake package) rather than relying on the transformer's
        // injection, so it stays deterministic and never touches the real test package's culture.
        setDefaultCulture("de", { packageName: "com.example.fake", fileName: "domain/index.ts" });
        assert.equal(getPackageCulture("com.example.fake"), "de");
    });

    test("setDefaultDatabaseSchema is folder-scoped — the longest matching directory wins", () => {
        // Register a fake type under a fake package so this never perturbs the real DB suite.
        registerType(class FakeThing { }, "FakeThing", { packageName: "com.example.fake", fileName: "domain/sales/orders.ts" });
        assert.equal(cultureForName("FakeThing"), "de"); // culture resolves via the type's package

        setDefaultDatabaseSchema("app", { packageName: "com.example.fake", fileName: "domain/index.ts" });       // dir "domain/"
        assert.equal(schemaForName("FakeThing"), "app");
        setDefaultDatabaseSchema("sales", { packageName: "com.example.fake", fileName: "domain/sales/setup.ts" }); // dir "domain/sales/"
        assert.equal(schemaForName("FakeThing"), "sales"); // more specific folder overrides the package default
    });

    test("SchemaSettings.schemaForType falls back to the connection schema for an uncovered type", () => {
        // ArtistEntity's package (@altea/altea-test) has no schema declaration covering entities/, so the
        // connection default (empty/current schema) is used — the hook never changes uncovered types.
        const settings = new SchemaSettings();
        assert.equal(settings.schemaForType(ArtistEntity as any).name, settings.schemaName.name);
    });

    test("a loaded translation wins over the code-declared default", () => {
        // Register a default for a fresh type, then a translation for the current UI culture: the
        // translation must take precedence (the default is only the no-translation fallback).
        setDefaultTypeDescription("WidgetThing", { description: "Widget (default)", pluralDescription: "Widgets (default)" });
        assert.equal(Localization.typeDescription("WidgetThing"), "Widget (default)");

        Localization.addLocalizedTypes(CultureInfo.currentUICulture(), {
            WidgetThing: { description: "Gadget", pluralDescription: "Gadgets", members: {} },
        });
        assert.equal(Localization.typeDescription("WidgetThing"), "Gadget");
        assert.equal(Localization.typePluralDescription("WidgetThing"), "Gadgets");
    });
});
