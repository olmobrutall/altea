import type { Entity } from "../data/entity";
import type { Lite } from "../data/lite";
import type { OperationSymbol } from "../data/operations";

// Port of Signum's operation-kind enum + the IOperation interface family (Internal.cs /
// OperationLogic.cs), trimmed to what altea supports. The invoke methods are `doX` (not
// `x`) so they don't clash with the Graph.* classes' user-supplied `execute`/`delete`/
// `construct` FIELDS. Implemented by the Graph.* classes (graph.ts); consumed by
// OperationLogic (operationLogic.ts).

export enum OperationType {
    Execute = "Execute",
    Delete = "Delete",
    Constructor = "Constructor",
    ConstructorFrom = "ConstructorFrom",
    ConstructorFromMany = "ConstructorFromMany",
}

export interface IOperation {
    readonly operationSymbol: OperationSymbol;
    readonly operationType: OperationType;
    /**
     * The entity type this operation is REGISTERED ON (Signum's `IOperation.OverridenType`): the type
     * whose frame shows its button, and the key it is shipped under in the reflection metadata blob.
     * For a ConstructFrom / ConstructFromMany this is the SOURCE type, not the constructed one.
     * Explicit rather than derived, because a generic parameter is erased at runtime — see graph.ts.
     */
    readonly entityType: Function;
    assertIsValid(): void;
}

/**
 * Signum's `IGraphHasStatesOperation` / `IGraphHasFromStatesOperation` (Internal.cs), collapsed into one
 * READER over the state machine an operation participates in: every `Graph.*` class already carries these
 * three fields, this only declares them so a consumer need not duck-type its way in.
 *
 * The one consumer is @altea/altea-map's operation map, which needs all three: the from/to state lists ARE
 * the edges it draws, and `getState` (a `Quoted`, see graph.ts) is both the groupBy key it counts states
 * with and the source of each state's query token.
 *
 * `unknown[]` rather than `S[]`: S is per-operation, and a reader holds a heterogeneous list of them. The
 * runtime values are enum MEMBER NAMES (altea enums are string-valued on the wire).
 *
 * NOT ported: Signum's `IGraphFromToStatesOperations.GetUntypedFromTo()`, the explicit from→to PAIR list
 * that lets one operation declare a sparse transition table. altea's Graph.* classes have no such option,
 * so a consumer draws the cartesian product of `fromStates` × `toStates` — which is exactly what Signum's
 * own client does whenever `fromToStates` is null.
 */
export interface IGraphStateOperation extends IOperation {
    readonly fromStates?: readonly unknown[];
    readonly toStates?: readonly unknown[];
    readonly getState?: (entity: any) => unknown;
}

export interface IEntityOperation extends IOperation {
    canBeNew: boolean;
    canBeModified: boolean;
    onCanExecute(entity: Entity): string | null;
}

export interface IConstructOperation extends IOperation {
    doConstruct(args: unknown[]): Promise<Entity>;
}

export interface IConstructorFromOperation extends IEntityOperation {
    resultIsSaved: boolean;
    doConstructFrom(entity: Entity, args: unknown[]): Promise<Entity>;
}

export interface IConstructorFromManyOperation extends IOperation {
    doConstructFromMany(lites: Lite<Entity>[], args: unknown[]): Promise<Entity>;
}

export interface IExecuteOperation extends IEntityOperation {
    doExecute(entity: Entity, args: unknown[]): Promise<Entity>;
}

export interface IDeleteOperation extends IEntityOperation {
    doDelete(entity: Entity, args: unknown[]): Promise<void>;
}
