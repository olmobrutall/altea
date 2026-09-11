import type { Quoted } from "quote-transformer/quoted";
import { QueryTokenString, tokenSequence, type Anonymous } from "@altea/altea/data/dynamicQuery/queryTokenString";
import { Enum } from "@altea/altea/data/enum";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { cleanTypeName } from "@altea/altea/data/registration";
import { getKey, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { FilterOperation, OrderType, type FilterOperationKeys, type OrderTypeKeys } from "@altea/altea/data/dynamicQueries";

// How a test NAMES things. Signum's own Playwright suites pass strings — `"Entity.Customer.Name"`,
// `"EqualTo"`, `"Order"` — because its proxies are built on `object queryName` and `string token`. Here
// every one of those is the typed thing itself, so a renamed property breaks the build instead of the run.

/**
 * A query TOKEN: a property lambda over the query's row (`o => o.shipAddress.city`), or a built
 * {@link QueryTokenString} for the columns that are not a property (`QueryTokenString.entity()`,
 * `.count()`, an aggregate, a cast).
 *
 * The lambda goes through the same `tokenSequence` the application's own `Type.token(…)` uses, so a test
 * and the client produce the identical string — PascalCase and rootless (`ShipAddress.City`).
 */
export type TokenOf<T, S = unknown> = Quoted<(t: Anonymous<T>) => S> | QueryTokenString<S>;

/** The token string behind {@link TokenOf} — what the DOM carries as `data-full-token` / `data-column-name`. */
export function tokenString<T>(token: TokenOf<T>): string {
    return token instanceof QueryTokenString
        ? token.token
        : tokenSequence(token as Quoted<Function>, /* isFirst */ true);
}

/** The query KEY of a query named by its row type (`OrderEntity` → "Order"). */
export function queryKeyOf(queryName: QueryName): string {
    return getKey(queryName);
}

/** The route segment an entity page / a create page is addressed by (`OrderEntity` → "Order"). */
export function cleanNameOf(type: Type<BaseEntity>): string {
    return cleanTypeName(type);
}

/**
 * What a `<select>` of an altea enum holds: the MEMBER NAME. A test writes the enum value
 * (`FilterOperation.EqualTo`, `OrderState.Ordered`) and this is where it becomes the wire spelling.
 */
export function enumName(enumObject: object, value: unknown): string {
    return Enum.toName(enumObject as never, value as never);
}

export function filterOperationName(operation: FilterOperation | FilterOperationKeys): string {
    return enumName(FilterOperation, operation);
}

/**
 * The PropertyRoute a token names, when it names one — a property lambda over the query's row resolves;
 * `QueryTokenString.entity()`, an aggregate or a registered expression does not.
 *
 * It exists for the values: the editor of an enum column holds the member NAME, and the member name of the
 * number a TypeScript enum passes around can only be recovered from the enum OBJECT, which is exactly what
 * the route's TypeReference carries.
 */
export function tryRouteOf<T extends BaseEntity>(rootType: Type<T>, token: TokenOf<T>): PropertyRoute | undefined {
    if (token instanceof QueryTokenString)
        return undefined;
    try {
        return PropertyRoute.root(rootType).addLambda(token as Quoted<(val: any) => any>);
    } catch {
        return undefined; // not a property route: an expression member, a cast, the Entity column…
    }
}

/**
 * How a value is WRITTEN into a filter / line editor: a lite by its key, an enum by the value the option
 * carries, everything else by its own text.
 *
 * An altea enum line renders `value={toStr(oi.value)}` and `data-value={ctx.value}` — the NUMBER the
 * TypeScript enum defines, not the member name (EnumLine.tsx). Signum's DOM carries the name, which is why
 * its proxy takes and returns one. Both spellings are accepted here and normalised to the number.
 */
export function editorText(value: unknown, route?: PropertyRoute): string {
    if (value instanceof Lite)
        return value.key();
    if (value instanceof Entity)
        return value.toLite().key();

    const enumObject = route?.type?.getEnum();
    if (enumObject != null)
        return String(Enum.toValue(enumObject as never, enumName(enumObject, value) as never));

    return String(value);
}

/** The inverse: what the DOM holds for an enum column, back as the enum VALUE. */
export function editorValue(text: string, route?: PropertyRoute): unknown {
    const enumObject = route?.type?.getEnum();
    if (enumObject == null)
        return text;

    const numeric = Number(text);
    return Number.isNaN(numeric) ? Enum.toValue(enumObject as never, text as never) : numeric;
}

export function orderTypeName(orderType: OrderType | OrderTypeKeys): string {
    return enumName(OrderType, orderType);
}
