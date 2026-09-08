import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, part, implementedBy, implementedByAll, quoted, ticksColumn } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { OperationSymbol } from "@altea/altea/data/operations";
import { Serializer } from "@altea/altea/data/serializer";
import { ProcessAlgorithmSymbol, ProcessEntity, type IProcessDataEntity } from "./Processes";
import { ExceptionEntity } from "@altea/altea/data/exception";

// Port of Signum.Processes' Package.cs — a PACKAGE is the most common thing a process runs over: a named
// bag of LINES, each pointing at one entity, so "do this to these 5,000 rows" becomes one observable,
// resumable process with a per-row failure record.
//
// altea divergences, documented inline:
//  - `byte[]? OperationArguments` (Signum serialises the operation's arguments into the package) → a
//    `Uint8Array | null` "Blob" column, read and written by `setOperationArgs` / `getOperationArgs` below.
//    (The client-side "run this operation over the selected rows" flow — Signum's PackageOperation
//    contextual menu — is still not ported; a package is built in code, but it can now carry arguments.)
//  - `PackageEntity` is `@part` in Signum (owned by the process that runs it) — but altea Parts
//    have exactly ONE owner and are reached through it, while a package is referenced by `ProcessEntity.data`
//    (an @implementedByAll Lite, not an owned collection). So it is a "System" entity here, like its lines.
//  - `PackageOperationEntity` subclasses PackageEntity in Signum. Kept, since it is what names the operation
//    a PackageOperation process applies.

@reflect
@entity("System", "Transactional")
export class PackageEntity extends Entity implements IProcessDataEntity {

    @stringLengthValidator({ max: 200 })
    name: string | null = null;

    /** Signum's OperationArguments — the arguments the process needs beyond its lines, written and read
     *  by `setOperationArgs` / `getOperationArgs` below. */
    operationArguments: Uint8Array | null = null;

    @stringLengthValidator({ max: 1000, multiLine: true })
    configString: string | null;

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
// Signum's [TicksColumn(false)] — the engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
export class PackageLineEntity extends Entity {

    // A PackageOperation is a PackageEntity SUBCLASS with a table of its own, so one FK to
    // `processes.package` could not reference an operation package at all. Signum gives a reference to a
    // type with concrete subclasses one column per table, which is what these two are.
    @implementedBy(() => [PackageEntity, PackageOperationEntity])
    package: Lite<PackageEntity>;

    @implementedByAll
    target: Lite<Entity>;

    /** Only a ConstructFrom-style operation produces one (Signum's comment). */
    @implementedByAll
    result: Lite<Entity> | null = null;

    finishTime: Temporal.PlainDateTime | null = null;

    // Signum's `[ExpressionField("ToStringExpression")]` over `pel => "PackageLine (" + pel.Id + ")"` —
    // an EXPRESSION, so the string is expanded inline in queries and this table has no ToStr column.
    @quoted
    toString(): string {
        return `PackageLine (${this.id ?? "New"})`;
    }
}

/** Signum's `[AutoInit] PackageOperationProcess.PackageOperation` — the algorithm that applies a
 *  PackageOperationEntity's operation to every line. */
export namespace PackageOperationProcess {
    export const PackageOperation: ProcessAlgorithmSymbol = init();
}

// ---- Operation arguments (Signum's PackageLogic.SetOperationArgs / GetOperationArgs) --------------------

// A process that walks a package often needs more than the lines: "send THIS template to these 500
// customers" is one argument plus the lines. Signum stashes that argument list in the package itself, as
// JSON bytes written with the FULL entity serializer so a `Lite<EmailTemplateEntity>` survives the round
// trip with its type; altea does the same through its own `Serializer`, which is the codec that knows how
// to write a Lite (`JSON.stringify` drops a Lite's constructor-valued entityType, leaving a reader unable
// to tell what it points at).
//
// `writeTypes: "Always"` mirrors Signum's FullJsonSerializerOptions: the array is `unknown[]`, so nothing
// on the reading side can infer a missing discriminator from a declared field type.
//
// They live beside the entity rather than in a logic module because they are pure codec — no database, no
// schema — and Signum's own placement (extension methods in PackageLogic) has no altea counterpart to
// hang them on.

/** Signum's `package.SetOperationArgs(args)` — returns the package, so it chains into a `save()`. */
export function setOperationArgs<T extends PackageEntity>(pack: T, args: unknown[] | null): T {
    pack.operationArguments = args == null ? null : new TextEncoder().encode(Serializer.stringify(args, { writeTypes: "Always" }));
    return pack;
}

/** Signum's `package.GetOperationArgs()` — null when the package carries none. */
export function getOperationArgs(pack: PackageEntity): unknown[] | null {
    if (pack.operationArguments == null)
        return null;
    return Serializer.parse(new TextDecoder().decode(pack.operationArguments)) as unknown[];
}

// Signum reads an argument by TYPE (`args.GetArg<T>()`), which TypeScript's erasure cannot do — so the
// type is passed as the constructor. A LITE needs its own pair: a `Lite<EmailTemplateEntity>` is a LiteImp,
// never an `instanceof EmailTemplateEntity`, so matching it means comparing the lite's `entityType`.

/** Signum's `args.GetArg<T>()` for a value / entity / symbol argument — or throw naming what was asked for. */
export function getArg<T>(args: unknown[] | null, ctor: new (...a: any[]) => T): T {
    const found = tryGetArg(args, ctor);
    if (found == null)
        throw new Error(`The package carries no argument of type ${ctor.name}`);
    return found;
}

/** Signum's `args.TryGetArgC<T>()` — undefined when there is none. */
export function tryGetArg<T>(args: unknown[] | null, ctor: new (...a: any[]) => T): T | undefined {
    return args?.find(a => a instanceof ctor) as T | undefined;
}

/** `getArg` for a `Lite<T>` argument, matched on the lite's entityType. */
export function getLiteArg<T extends Entity>(args: unknown[] | null, ctor: abstract new (...a: any[]) => T): Lite<T> {
    const found = tryGetLiteArg(args, ctor);
    if (found == null)
        throw new Error(`The package carries no Lite<${ctor.name}> argument`);
    return found;
}

/** `tryGetArg` for a `Lite<T>` argument. */
export function tryGetLiteArg<T extends Entity>(args: unknown[] | null, ctor: abstract new (...a: any[]) => T): Lite<T> | undefined {
    return args?.find(a => a instanceof Lite && a.entityType === ctor) as Lite<T> | undefined;
}

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("processes")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("processes");

// ---- the three LastProcess queries (Signum's PackageQuery.*) -------------------------------------------
//
// Signum names each by an ENUM MEMBER and projects an anonymous type; altea names a query by its ROW
// MODEL, whose clean name IS the key (`PackageLastProcessRowModel` → `PackageLastProcess`), so the
// anonymous projection becomes the model's members — the same columns in the same order.
//
// What each adds over the plain package/line query is the LAST PROCESS that ran the package and, through
// it, whether a line failed. Signum reaches those through `LastProcess()` / `Exception(pl, p)`, two
// [AutoExpressionField] extension methods; altea registers neither, and one of them takes a PARAMETER,
// which is not a query token here at all. The subqueries are therefore spelled out INLINE in the
// projection (see PackageLogic) — the same SQL, without a token nothing else asks for.

@reflect
export class PackageLastProcessRowModel extends ModelEntity {
    entity: Lite<PackageEntity>;
    id: int;
    name: string | null;
    numLines: int;
    lastProcess: Lite<ProcessEntity> | null;
    numErrors: int;
}

@reflect
export class PackageOperationLastProcessRowModel extends ModelEntity {
    entity: Lite<PackageOperationEntity>;
    id: int;
    name: string | null;
    operation: OperationSymbol;
    numLines: int;
    lastProcess: Lite<ProcessEntity> | null;
    numErrors: int;
}

@reflect
export class PackageLineLastProcessRowModel extends ModelEntity {
    entity: Lite<PackageLineEntity>;
    package: Lite<PackageEntity>;
    id: int;
    target: Lite<Entity>;
    result: Lite<Entity> | null;
    finishTime: Temporal.PlainDateTime | null;
    lastProcess: Lite<ProcessEntity> | null;
    exception: Lite<ExceptionEntity> | null;
}
