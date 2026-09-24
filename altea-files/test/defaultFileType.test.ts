import "@altea/altea/server/context.node";
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { init, getTypeInfo } from "@altea/altea/data/reflection";
import { Metadata } from "@altea/altea/data/metadata";
import type { TypeMetadata } from "@altea/altea/data/metadata";
import { ReflectionServer } from "@altea/altea/server/reflectionServer";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { FilePathEmbedded, FileTypeSymbol, defaultFileType, fileTypeLimits } from "../data/Files";
import { FileTypeLogic } from "../server/FileTypeLogic";
import { FileTypeAlgorithm } from "../server/FileTypeAlgorithm";

// Signum's [DefaultFileType]: the FIELD names its file type (a thunk — the symbol is declared below), and the
// type's STORE owns the limits, which the server ships with the symbol in the metadata blob.

@entity("Main", "Transactional")
class DocumentSample extends Entity {
    @defaultFileType(() => SampleFileType.Scan)
    scan: FilePathEmbedded | null = null;
}

export namespace SampleFileType {
    export const Scan: FileTypeSymbol = init();
}

describe("@defaultFileType", () => {

    test("the field names its type, declared after the entity", () => {
        assert.equal(getTypeInfo(DocumentSample)!.fields["scan"]!.defaultFileType?.(), SampleFileType.Scan);
    });

    test("the store's limits ride with the symbol in the blob", () => {
        FileTypeLogic.start(new SchemaBuilder());
        FileTypeLogic.register(SampleFileType.Scan, new FileTypeAlgorithm({ physicalPrefix: () => "./scans", onlyImages: true, maxSizeInBytes: 300 }));

        const types: Record<string, TypeMetadata> = {};
        const typeOf = (name: string): TypeMetadata => types[name] ??= { kind: "Container", fields: {} } as unknown as TypeMetadata;
        for (const extend of ReflectionServer.metadataExtensions)
            extend(types, typeOf);

        const [container, member] = SampleFileType.Scan.key.split(".");
        assert.deepEqual(types[container!]!.fields[member!]!.fileTypeLimits, { onlyImages: true, maxSizeInBytes: 300 });

        Metadata.apply({ culture: "en", types: types as never });
        assert.deepEqual(fileTypeLimits(SampleFileType.Scan), { onlyImages: true, maxSizeInBytes: 300 });
    });
});
