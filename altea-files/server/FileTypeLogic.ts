import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { declaredSymbolsForType } from "@altea/altea/data/reflection";
import { FileTypeSymbol } from "../data/Files";
import type { IFileTypeAlgorithm } from "./FileTypeAlgorithm";

// Port of Signum.Files' FileTypeLogic.cs — the registry mapping each FileTypeSymbol to the ALGORITHM that
// stores its files, plus the symbol table itself.
//
// The symbol table is seeded from the REGISTERED file types, as Signum does
// (`SymbolLogic<FileTypeSymbol>.Start(sb, () => FileTypes.Keys.ToHashSet())`): a file type IS its
// algorithm, and one with no store to write to is not a type this application has. SymbolLogic's own
// default — every DECLARED symbol — is wrong here in a way that shows, because merely IMPORTING a
// module's data layer declares its file types: an app that never STARTS that module still got rows for
// them. Southwind starts neither Printing nor WhatsNew and has a row for neither, where eastwind had six
// its database does not.
//
// Like Signum's, the thunk is evaluated LATE (when the table is seeded), so registration order does not
// matter — which is what the declared-symbol default was reaching for.

const fileTypes = new Map<string /*symbol key*/, IFileTypeAlgorithm>();

export namespace FileTypeLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, FileTypeSymbol,
            () => (declaredSymbolsForType(FileTypeSymbol) as FileTypeSymbol[]).filter(s => fileTypes.has(s.key)));
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
