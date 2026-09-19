import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { Entity } from "../../entity";
import { QueryTokenMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions, entityCtorOf } from "./queryToken";

// Port of Signum's OperationsContainerToken.cs + OperationToken.cs: an entity OPERATION surfaced as a
// search-result COLUMN, so each row carries its own button.
//
// Shape: an entity token exposes `[Operations]` (OperationsContainerToken); its leaves are one
// OperationToken per ELIGIBLE operation of that entity type, and a leaf projects a CellOperationDto
// per row — { lite, operationKey, canExecute } — which the client's "CellOperation" format rule
// (client/Operations.tsx) turns into a <CellOperationButton>.
//
// "Eligible" is the whole subtlety, and it is Signum's: an operation may only be a column if its
// can-execute reason can be computed IN SQL, because the point of the column is to render the button's
// disabled state for a whole page of rows without retrieving one of them. See {@link setEligibleTypeOperationsProvider}.

/**
 * Signum's `ContainerTokenKey` enum (QueryToken.cs): the fixed keys of the two containers an entity
 * token exposes for tokens that are declared imperatively rather than derived from the entity model.
 *
 * A plain const map rather than an altea enum: Signum's members carry `[Description("[Operations]")]`
 * only so the KEY can be read back off the enum, and nothing localizes them — the container's own
 * display name is `QueryTokenMessage.Operations` / the quick-links key. Declaring it as a reflected
 * enum would add a translatable type whose every translation is a bracketed literal.
 */
export const ContainerTokenKey = {
    Operations: "[Operations]",
    QuickLinks: "[QuickLinks]",
} as const;
export type ContainerTokenKey = typeof ContainerTokenKey[keyof typeof ContainerTokenKey];

/**
 * Signum's `CellOperationDTO` — the per-row column value an operation leaf projects. `canExecute` is
 * the reason the button is disabled for THIS row (null ⇒ enabled), evaluated in SQL.
 */
export interface CellOperationDto {
    lite: unknown;
    operationKey: string;
    canExecute: string | null;
}

/**
 * The value TypeReference an operation leaf reports (Signum's `Type => typeof(CellOperationDTO)`). The
 * NAME is load-bearing: the client's format rule is `c.type.getTypeName() == "CellOperationDTO"`, and
 * SearchControlLoaded excludes a column of this type from entity navigation by the same string.
 */
export const TR_CELL_OPERATION = new TypeReference({ typeName: "CellOperationDTO" });

/** The container's own opaque value type (Signum's `Type => typeof(OperationsContainerToken)`). */
export const TR_OPERATIONS_CONTAINER = new TypeReference({ typeName: "OperationsContainerToken" });

/**
 * One operation the `[Operations]` container may offer, in the form BOTH tiers can produce — the key
 * the leaf is addressed by and the label it shows. Signum's seam hands back `OperationSymbol`s, which
 * only the server has: altea's client builds the same token tree locally out of the reflection
 * metadata blob, so the descriptor is reduced to what both sides know.
 */
export interface EligibleOperation {
    /** The operation symbol's key, e.g. "OrderOperation.Ship" (NOT `.`→`#` escaped — the token does that). */
    operationKey: string;
    /** The operation's localized nice name — the leaf's caption, hence the column header. */
    niceName: string;
}

/**
 * Signum's `OperationsContainerToken.GetEligibleTypeOperations` static, as altea's usual registration
 * seam. Both tiers fill it, with the same answer reached two ways:
 *
 *  - SERVER (`OperationLogic.start`): the operations registered for the type whose can-execute reason
 *    is expressible as SQL — no in-memory-only guard, and a resolvable state enum when it has states.
 *  - CLIENT (`Operations.start`): the same set read off the reflection metadata blob
 *    (`OperationMetadata.canBeCellOperation`, computed server-side by the rule above). The blob only
 *    carries operations the current role may see, so the client's list is authorized for free.
 *
 * Unset ⇒ the container offers nothing (and, being empty, is still listed but expands to nothing —
 * exactly as Signum's would if its seam returned an empty sequence). Signum THROWS when its static is
 * null; altea cannot, because the token layer runs on a client that may not have started Operations.
 */
let eligibleTypeOperationsProvider: ((entityCtor: Function) => EligibleOperation[]) | undefined;
export function setEligibleTypeOperationsProvider(fn: ((entityCtor: Function) => EligibleOperation[]) | undefined): void {
    eligibleTypeOperationsProvider = fn;
}

/**
 * Signum's `OperationToken.IsAllowedExtension` static: why the current role may not use this operation
 * as a column, or null. Unset ⇒ the leaf defers to its parent, which is the CLIENT's situation by
 * construction (an operation the role may not run is not in the metadata blob, so no leaf exists for
 * it) and the SERVER's until a SYNCHRONOUS operation-auth snapshot exists — `OperationAuthLogic`'s
 * check is async, and `QueryToken.isAllowed()` is not.
 */
let operationTokenAuthorizer: ((operationKey: string, entityCtor: Function) => string | null) | undefined;
export function setOperationTokenAuthorizer(fn: ((operationKey: string, entityCtor: Function) => string | null) | undefined): void {
    operationTokenAuthorizer = fn;
}

/** Signum's `o.Key.Replace(".", "#")`: a token key may not contain the `.` that separates token steps. */
export function operationTokenKey(operationKey: string): string {
    return operationKey.replace(/\./g, "#");
}

// Signum's OperationsContainerToken: the `[Operations]` grouping node under an entity token. Carries no
// value of its own — its expression is simply its parent's entity (see server/dynamicQuery/tokenExpressions).
export class OperationsContainerToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
        // Signum: "OperationsToken only can be child of entity type tokens".
        if (!_parent.type.is(Entity))
            throw new Error("OperationsContainerToken can only be a child of an entity/lite token");
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return ContainerTokenKey.Operations; }
    // Signum spells both as "[" + QueryTokenMessage.Operations + "]", which in the invariant culture is
    // the key itself — and in German "[Operationen]". The key stays the literal either way.
    override toString(): string { return `[${QueryTokenMessage.Operations.niceToString()}]`; }
    niceName(): string { return `[${QueryTokenMessage.Operations.niceToString()}]`; }
    get type(): TypeReference { return TR_OPERATIONS_CONTAINER; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    override niceTypeName(): string { return QueryTokenMessage.ContainerOfCellOperations.niceToString(); }
    override get hideInAutoExpand(): boolean { return true; }
    protected override get autoExpandInternal(): boolean { return false; }
    override hasOperation(): boolean { return true; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    /** The entity type the operations are looked up for (Signum's `parent.Type.CleanType()`). */
    get entityCtor(): Function | undefined { return entityCtorOf(this._parent.type); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        const ctor = this.entityCtor;
        if (eligibleTypeOperationsProvider == undefined || ctor == undefined)
            return [];
        return eligibleTypeOperationsProvider(ctor).map(o => new OperationToken(this, ctor, o));
    }
}

// Signum's OperationToken — one operation, as a leaf column. `operation.operationKey` is what the
// server's expression seam re-finds the registered operation by, and what the client's
// CellOperationContext looks the OperationSettings up with.
export class OperationToken extends QueryToken {
    constructor(
        private readonly _parent: OperationsContainerToken,
        readonly entityCtor: Function,
        readonly operation: EligibleOperation,
    ) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return operationTokenKey(this.operation.operationKey); }
    override toString(): string { return this.operation.operationKey; }
    niceName(): string { return this.operation.niceName; }
    get type(): TypeReference { return TR_CELL_OPERATION; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    override niceTypeName(): string { return QueryTokenMessage.CellOperation.niceToString(); }
    override hasOperation(): boolean { return true; }
    // Not a value: a CellOperationDTO can be neither grouped nor filtered on.
    override get isGroupable(): boolean { return false; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }

    isAllowed(): string | null {
        return this._parent.isAllowed()
            ?? (operationTokenAuthorizer?.(this.operation.operationKey, this.entityCtor) ?? null);
    }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
