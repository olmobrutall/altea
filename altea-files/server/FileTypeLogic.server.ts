import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { FileTypeSymbol } from "../data/Files";
import type { IFileTypeAlgorithm } from "./FileTypeAlgorithm.server";

// Port of Signum.Files' FileTypeLogic.cs — the registry mapping each FileTypeSymbol to the ALGORITHM that
// stores its files, plus the symbol table itself.
//
// altea divergence: Signum seeds the symbol table from the REGISTERED keys (`SymbolLogic<FileTypeSymbol>
// .Start(sb, () => FileTypes.Keys)`); altea's SymbolLogic seeds every DECLARED symbol (order-independent —
// see TypeConditionLogic's note), so a declared-but-unregistered file type gets a row but no algorithm and
// throws on use, which is the same failure Signum's GetOrThrow gives.

const fileTypes = new Map<string /*symbol key*/, IFileTypeAlgorithm>();

export namespace FileTypeLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, FileTypeSymbol);
        sb.include(FileTypeSymbol).withQuery();
    }

    /** Signum's `FileTypeLogic.Register(symbol, algorithm)`. */
    export function register(fileType: FileTypeSymbol, algorithm: IFileTypeAlgorithm): void {
        if (fileType == null)
            throw new Error("fileType is required (did the symbol init()?)");
        if (fileTypes.has(fileType.key))
            throw new Error(`FileType '${fileType.key}' is already registered`);

        fileTypes.set(fileType.key, algorithm);
    }

    /** Signum's `fileType.GetAlgorithm()` (GetOrThrow). */
    export function getAlgorithm(fileType: FileTypeSymbol): IFileTypeAlgorithm {
        const algorithm = fileTypes.get(fileType.key);
        if (algorithm == null)
            throw new Error(`No algorithm registered for FileType '${fileType.key}' (call FileTypeLogic.register)`);
        return algorithm;
    }

    export function isRegistered(fileType: FileTypeSymbol): boolean {
        return fileTypes.has(fileType.key);
    }

    export function registeredKeys(): string[] {
        return [...fileTypes.keys()];
    }
}
