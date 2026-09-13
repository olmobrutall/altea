import { test, describe, afterEach } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";   // String.firstUpper — the legacy path below spells a member with it
import { Serializer, setSerializationAuth } from "@altea/altea/data/serializer";
import { cleanModified } from "@altea/altea/data/changes";
import { setLegacyPropertyPaths } from "@altea/altea/data/propertyRoute";
import { ArtistEntity, Sex } from "../music";
import {
    CastProbeEntity, CastProbeEntity_Panel, CastProbeTextPartEntity,
} from "../castProbe";

// Property-authorization serializer gate (the `setSerializationAuth` hook consumed by PropertyAuthLogic).
// No database — pure codec behaviour on a hand-built graph, with an inline SerializationAuth that marks
// `name` read-only, `dead` hidden and everything else writable. Proves the two runtime enforcement paths:
//   READ  (serialize)  — a hidden property is OMITTED and both hidden/read-only are listed in propsMeta.
//   WRITE (deserialize) — overlaying a tampered wire onto the DB original keeps non-writable properties at
//                         their stored value (a client can't smuggle a change through an echoed value).
// afterEach uninstalls the hook so the codec returns to its open-by-default behaviour for every other suite.

const { stringify: serialize, parse: deserialize } = Serializer;

function makeArtist(id: number, name: string): ArtistEntity {
    const a = ArtistEntity.create({ name, dead: false, sex: Sex.Male, status: null, lastAward: null, friends: [] });
    a.id = id; a.isNew = false; a.ticks = 1;
    cleanModified(a);
    return a;
}

// name → read-only, dead → hidden, else writable.
function installGate(): void {
    setSerializationAuth({
        getMetadata: () => ArtistEntity,
        access: route => {
            const p = route.propertyString();
            return p === "name" ? "readonly" : p === "dead" ? "hidden" : "writable";
        },
    });
}

describe("SerializerAuth", () => {

    afterEach(() => setSerializationAuth(undefined));

    test("read gate: hidden property omitted, propsMeta lists hidden + read-only", () => {
        const a = makeArtist(1, "Michael");
        a.dead = true; // hidden ⇒ must never reach the wire even when set

        installGate();
        const o = JSON.parse(serialize(a));

        assert.equal(o.dead, undefined, "hidden property is omitted from the wire");
        assert.equal(o.name, "Michael", "read-only property is still written");
        assert.equal(o.sex, "Male", "writable property is written");
        assert.ok(Array.isArray(o.propsMeta));
        assert.ok(o.propsMeta.includes("!dead"), 'propsMeta marks a hidden property "!name"');
        assert.ok(o.propsMeta.includes("name"), 'propsMeta marks a read-only property "name"');
    });

    test("write gate: overlay keeps non-writable properties at their stored value", () => {
        // Build the TAMPERED wire with the gate OFF, so all fields (incl. the ones a client shouldn't be
        // able to change) are present and `modified` is set — exactly what a malicious client could POST.
        const tamper = makeArtist(1, "Original");
        tamper.name = "Hacked";     // read-only — must be rejected
        tamper.dead = true;         // hidden   — must be rejected
        tamper.sex = Sex.Female;    // writable — must be applied
        const wire = serialize(tamper);
        assert.equal(JSON.parse(wire).modified, true, "tampered wire is modified (takes the overlay path)");

        // Now deserialize it WITH the gate, overlaying onto the authoritative DB original.
        installGate();
        const original = makeArtist(1, "Original"); // stored: name="Original", dead=false, sex=Male
        const result = deserialize(wire, { resolve: () => original }) as ArtistEntity;

        assert.equal(result, original, "overlaid onto the resolved original instance");
        assert.equal(result.name, "Original", "read-only change is rejected (kept original)");
        assert.equal(result.dead, false, "hidden change is rejected (kept original)");
        assert.equal(result.sex, Sex.Female, "writable change is applied");
    });

    test("open by default: no gate ⇒ every field round-trips, no propsMeta", () => {
        const a = makeArtist(1, "Michael");
        a.dead = true;
        const o = JSON.parse(serialize(a)); // gate NOT installed
        assert.equal(o.dead, true, "no gate ⇒ hidden-eligible field is written");
        assert.equal(o.propsMeta, undefined, "no gate ⇒ no propsMeta");
    });
});

// The route the gate is ASKED about for a `@part` reached through a POLYMORPHIC reference. It must name
// WHICH part — `panels/content.(CastProbeTextPart).textContent`, the same spelling
// `PropertyRoute.generateRoutes(…, includeCasts)` produces and therefore the one a property rule is
// stored under. Without the cast every implementation's members share one path
// (`panels/content.textContent`), which is ambiguous between them AND matches no generated route, so a
// rule on a part content would gate nothing at all.
describe("SerializerAuth — a @part behind a polymorphic reference", () => {

    afterEach(() => setSerializationAuth(undefined));

    function askedRoutes(): string[] {
        const seen: string[] = [];
        setSerializationAuth({
            getMetadata: () => CastProbeEntity,
            access: route => { seen.push(route.propertyString()); return "writable"; },
        });
        const text = CastProbeTextPartEntity.create({ textContent: "hello" });
        const panel = CastProbeEntity_Panel.create({ title: "T", content: text });
        serialize(CastProbeEntity.create({ panels: [panel] }));
        return seen;
    }

    test("the gate is asked about the CAST route, not the ambiguous shared one", () => {
        const seen = askedRoutes();
        assert.ok(seen.includes("panels/content.(CastProbeTextPart).textContent"), seen.join(", "));
        assert.ok(!seen.includes("panels/content.textContent"), seen.join(", "));
    });

    // LEGACY MODE generates no cast route, so gating against one could only ever find nothing — the
    // serializer follows `generateRoutes` rather than inventing a path no rule can exist at.
    test("LEGACY MODE keeps the pre-cast path", () => {
        setLegacyPropertyPaths(true);
        try {
            const seen = askedRoutes();
            assert.ok(!seen.some(p => p.includes("(")), seen.join(", "));
        } finally {
            setLegacyPropertyPaths(false);
        }
    });
});
