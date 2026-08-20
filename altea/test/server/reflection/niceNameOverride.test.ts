import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Entity } from "@altea/altea/data/entity";
import { reflect, getOrCreateTypeInfo, setDefaultTypeDescription, registerType } from "@altea/altea/data/reflection";
import { setDefaultCulture, getPackageCulture, cultureForName, setDefaultDatabaseSchema, schemaForName } from "@altea/altea/data/reflection";
import { niceName, nicePluralName, gender } from "@altea/altea/data/decorators";
import { Localization } from "@altea/altea/data/utils/localization";
import { Metadata } from "@altea/altea/data/metadata";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { Enum } from "@altea/altea/data/enum";
import { SchemaSettings } from "@altea/altea/server/schema/schemaBuilder";
import { ArtistOperation } from "../../data/music";
import { ArtistEntity } from "../../data/music";

// A top-level setDefaultDatabaseSchema call, so the compiled output can be checked for the transformer's
// injected __fileInfo. Placed here in test/ (no entities live under test/), so it registers a scope that
// matches no real entity — the DB suite's schema build is untouched.
setDefaultDatabaseSchema("testDbo");

// Code-declared DEFAULT-language nice names — no translation file needed (the @niceName /
// @nicePluralName / @gender decorators, Enum.setNiceName, and operation init({ niceName })). The
// decorators use the bare names; the display names are read through the FLUENT surface the rest of the
// codebase uses (`PersonThing.niceName()`, `Enum.niceName(…)`), not through the resolver engine. Pure
// in-memory, no DB. Verifies each override beats the humanized fallback, and that a loaded translation
// still wins.

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
        assert.equal(PersonThing.niceName(), "Person");
        assert.equal(PersonThing.nicePluralName(), "People");
    });

    test("@niceName on a field overrides the member's nice name; others humanize", () => {
        const ti = getOrCreateTypeInfo(PersonThing);
        assert.equal(ti.fields["email"].niceToString(), "e-Mail");
        assert.equal(ti.fields["firstName"].niceToString(), "First name");
        // Same answers through the fluent property surface (both overloads).
        assert.equal(PersonThing.nicePropertyName(a => a.email), "e-Mail");
        assert.equal(PersonThing.nicePropertyName("firstName"), "First name");
    });

    test("Enum.setNiceName overrides an enum member; others humanize", () => {
        Enum.setNiceName(ColorEnum, "Weiss", "Weiß");
        assert.equal(Enum.niceName(ColorEnum, "Weiss"), "Weiß");
        assert.equal(Enum.niceName(ColorEnum, "Rot"), "Rot");
    });

    test("operation init({ niceName }) registers a default operation label", () => {
        assert.equal(ArtistOperation.CreateFromScratch.key, "ArtistOperation.CreateFromScratch");
        // The client Operations layer resolves an operation's label via DescriptionManager.translate.
        assert.equal(ArtistOperation.CreateFromScratch.niceToString(), "Create Artist from scratch");
    });

    test("@gender pins a type's grammatical gender", () => {
        assert.equal(PerroEntity.gender(), "m");
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
        assert.equal(Localization.Internal.typeNiceName("WidgetThing"), "Widget (default)");

        Metadata.merge(CultureInfo.currentUICulture(), {
            WidgetThing: { kind: "Entity", niceName: "Gadget", nicePluralName: "Gadgets", fields: {} },
        });
        assert.equal(Localization.Internal.typeNiceName("WidgetThing"), "Gadget");
        assert.equal(Localization.Internal.typeNicePluralName("WidgetThing"), "Gadgets");
    });
});
