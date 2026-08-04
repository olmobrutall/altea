import type { Entity } from "../data/entity";
import { LiteralType, quotedFunction } from "./runtimeTypes";

// Query-only SQL Server full-text-search predicates (Signum's SqlFullTextSearch). Usable only
// inside a database query, where the LINQ provider (QueryBinder) lowers them to CONTAINS / FREETEXT;
// the bodies throw. Divergence from Signum: altea takes a SINGLE column or an entity (all its
// full-text columns) rather than a `new[] { … }` column array — the multi-column-array overload is
// a later addition. Postgres uses tsvector `@@` instead (see data/tsVector.ts); calling these on
// Postgres throws at bind time.
const onlyQueries = (method: string): never => {
    throw new Error(`SqlFullTextSearch.${method} is only supported inside a SQL Server database query`);
};

export const SqlFullTextSearch = {
    // CONTAINS(<column>, '<searchCondition>') over one full-text column, or CONTAINS(*, …) over all
    // of an entity's full-text columns. https://learn.microsoft.com/sql/t-sql/queries/contains-transact-sql
    contains(columnOrEntity: string | Entity, searchCondition: string): boolean { return onlyQueries("contains"); },

    // FREETEXT(<column>, '<freeText>') over one full-text column, or FREETEXT(*, …) over all of an
    // entity's full-text columns. https://learn.microsoft.com/sql/t-sql/queries/freetext-transact-sql
    freeText(columnOrEntity: string | Entity, freeTextString: string): boolean { return onlyQueries("freeText"); },
};

// Result-type metadata so fromQuoted can type the call node (both predicates return a boolean); the
// QueryBinder then lowers them to CONTAINS / FREETEXT. (The methods live on a captured object, so
// they carry the metadata imperatively rather than via the @resultType decorator.)
quotedFunction(SqlFullTextSearch.contains as unknown as Function).__resultType = () => LiteralType.boolean;
quotedFunction(SqlFullTextSearch.freeText as unknown as Function).__resultType = () => LiteralType.boolean;
