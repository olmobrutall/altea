import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, implementedByAll, stringLengthValidator } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { OperationSymbol } from "@altea/altea/data/operations";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ProcessAlgorithmSymbol, type IProcessDataEntity } from "./Processes";

// Port of Signum.Processes' Package.cs — a PACKAGE is the most common thing a process runs over: a named
// bag of LINES, each pointing at one entity, so "do this to these 5,000 rows" becomes one observable,
// resumable process with a per-row failure record.
//
// altea divergences, documented inline:
//  - `byte[]? OperationArguments` (Signum serialises the operation's arguments into the package) → a
//    `Uint8Array | null` "Blob" column. Nothing fills it yet: the client-side "run this operation over the
//    selected rows" flow (Signum's PackageOperation contextual menu) is NOT ported, so an app builds its
//    packages in code and needs no argument blob.
//  - `PackageEntity` is `@entity("Part")` in Signum (owned by the process that runs it) — but altea Parts
//    have exactly ONE owner and are reached through it, while a package is referenced by `ProcessEntity.data`
//    (an @implementedByAll Lite, not an owned collection). So it is a "System" entity here, like its lines.
//  - `PackageOperationEntity` subclasses PackageEntity in Signum. Kept, since it is what names the operation
//    a PackageOperation process applies.

@reflect
@entity("System", "Transactional")
export class PackageEntity extends Entity implements IProcessDataEntity {

    @stringLengthValidator({ max: 200 })
    name: string | null = null;

    /** Signum's OperationArguments (see the header note — unused for now). */
    operationArguments: Uint8Array | null = null;

    configString: BigStringEmbedded = new BigStringEmbedded();

    // NO `lines` collection, exactly as in Signum: a package can hold hundreds of thousands of lines, so the
    // LINE points at the package (`PackageLineEntity.package`) and is queried from there. An owned array
    // here would make every retrieve of a package drag its whole content in.

    toString(): string {
        return `Package ${this.name ?? ""}`.trim();
    }
}

/** Signum's PackageOperationEntity — a package whose lines are all to be fed to ONE operation. */
@reflect
@entity("System", "Transactional")
export class PackageOperationEntity extends PackageEntity {

    operation: OperationSymbol;

    override toString(): string {
        return `Package ${this.operation ?? ""} ${this.name ?? ""}`.trim();
    }
}

/** Signum's PackageLineEntity — one element of a package, plus what came out of processing it. */
@reflect
@entity("System", "Transactional")
export class PackageLineEntity extends Entity {

    package: Lite<PackageEntity>;

    @implementedByAll
    target: Lite<Entity>;

    /** Only a ConstructFrom-style operation produces one (Signum's comment). */
    @implementedByAll
    result: Lite<Entity> | null = null;

    finishTime: Temporal.PlainDateTime | null = null;

    toString(): string {
        return `PackageLine (${this.id ?? "New"})`;
    }
}

/** Signum's `[AutoInit] PackageOperationProcess.PackageOperation` — the algorithm that applies a
 *  PackageOperationEntity's operation to every line. */
export namespace PackageOperationProcess {
    export const PackageOperation: ProcessAlgorithmSymbol = init();
}
