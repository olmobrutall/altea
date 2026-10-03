import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Serializer } from "@altea/altea/data/serializer";
import { Entity } from "@altea/altea/data/entity";
import { field, reflect, getTypeInfo } from "@altea/altea/data/reflection";
import { isGraphModified, cleanModified } from "@altea/altea/data/changes";
import { Dic } from "@altea/altea/data/globals";

// A Blob field (Uint8Array) is declared `accessor`: a NON-ENUMERABLE getter/setter on the prototype instead
// of an own property per instance. Everything that reaches a field BY NAME — reflection, the serializer,
// change tracking, `create()` — keeps working; everything that walks an object's KEYS skips the bytes rather
// than visiting one key per byte. The latter is what froze a save for seconds: React 19's dev prop diff
// listed a 600 KB file byte by byte for every component that took the entity as a prop.

@reflect
class BlobProbeEntity extends Entity {
    name: string = "";
    accessor bytes: Uint8Array | null = null;
}

describe("Blob fields are accessors", () => {

    test("reflection still sees the field, as a Blob", () => {
        assert.equal(getTypeInfo(BlobProbeEntity)!.fields["bytes"]?.typeName, "Blob");
    });

    test("read and write by name, through create() too", () => {
        const e = BlobProbeEntity.create({ name: "a", bytes: new Uint8Array([1, 2, 3]) });
        assert.deepEqual([...e.bytes!], [1, 2, 3]);

        e.bytes = new Uint8Array([4]);
        assert.deepEqual([...e.bytes], [4]);
    });

    test("no key walk sees the bytes", () => {
        const e = BlobProbeEntity.create({ name: "a", bytes: new Uint8Array(1_000_000) });

        const forIn: string[] = [];
        for (const k in e) forIn.push(k);

        assert.equal(forIn.includes("bytes"), false, "for…in — what React's dev prop diff uses");
        assert.equal(Object.keys(e).includes("bytes"), false, "Object.keys");
        assert.equal(Dic.getKeys(e).includes("bytes"), false, "Dic.getKeys — what Dic.equals walks");
        assert.ok(Object.keys(e).includes("name"), "an ordinary field is still an own, enumerable property");
    });

    test("the serializer round-trips the bytes", () => {
        const e = BlobProbeEntity.create({ name: "a", bytes: new Uint8Array([7, 8, 9]) });
        const back = Serializer.parse(Serializer.stringify(e)) as BlobProbeEntity;

        assert.ok(back.bytes instanceof Uint8Array);
        assert.deepEqual([...back.bytes!], [7, 8, 9]);
        assert.equal(Object.keys(back).includes("bytes"), false, "a deserialized entity keeps the accessor");
    });

    test("change tracking sees a new file", () => {
        const e = BlobProbeEntity.create({ name: "a", bytes: new Uint8Array([1]) });
        cleanModified(e);   // the baseline a retrieved entity has
        assert.equal(isGraphModified(e), false);

        e.bytes = new Uint8Array([2]);
        assert.equal(isGraphModified(e), true);
    });

    test("a Blob field declared as a plain property is refused at class definition", () => {
        class Plain { }
        assert.throws(() => field({ typeName: "Blob" })(Plain.prototype, "bytes", undefined), /declare it as `accessor bytes/);

        // An accessor arrives with its descriptor, and is accepted.
        assert.doesNotThrow(() => field({ typeName: "Blob" })(Plain.prototype, "bytes", { get() { return null; }, set() { } }));
    });
});
