import { sqlMethod, returnType, resultType } from "@altea/altea/server/query";
import { LiteralType } from "@altea/altea/server/runtimeTypes";
import type { SchemaAssets } from "@altea/altea/server/sync/schemaAssets";
import type { int } from "@altea/altea/data/basics";
import { IntValue } from "../data/music";

// Port of Signum's `MinimumExtensions` (Entities.cs) — the [SqlMethod]-marked UDFs used only inside a
// query, plus the SchemaAssets registration that creates them. SERVER-TIER: these carry the query/schema
// coupling (@sqlMethod, LiteralType, SchemaAssets) that must NOT live in the isomorphic Music model, so
// they were split out of entities/music.ts (which stays pure @altea/altea/data). The query-only markers
// reference IntValue (a pure-data @reflect View that remains in music.ts).
export class MinimumExtensions {
    // `minimumTableValued` is an inline table-valued function returning `IntValue` rows (Signum's
    // `IQueryable<IntValue>`); a query-only marker whose body throws. @sqlMethod names the SQL function
    // (unqualified — the binder qualifies a table-valued UDF with the dialect default schema, `dbo.`/
    // `public.`) and @returnType declares the row view, so the QueryBinder lowers the call to a
    // `<schema>.MinimumTableValued(...)` source. The UDF itself is created by includeFunction below.
    @sqlMethod("MinimumTableValued")
    @returnType(IntValue)
    static minimumTableValued(_a: number, _b: number): IntValue[] {
        throw new Error("MinimumExtensions.minimumTableValued is a query-only SQL function marker.");
    }

    // Signum's scalar [SqlMethod("MinimumScalar")]: a plain int-returning UDF. No @returnType (a
    // scalar, not an IView row set), so the binder lowers the call to a scalar SqlFunctionExpression
    // — schema-qualified (public./dbo.) so SQL Server accepts it (an unqualified name resolves as a
    // built-in there).
    @sqlMethod("MinimumScalar")
    @resultType(() => LiteralType.number)
    static minimumScalar(_a: int | null, _b: int | null): int | null {
        throw new Error("MinimumExtensions.minimumScalar is a query-only SQL function marker.");
    }

    // Port of Signum's MinimumExtensions.IncludeFunction (Entities.cs) — registers the
    // MinimumTableValued inline table-valued UDF and the MinimumScalar scalar UDF on the schema's
    // SchemaAssets, so schema generation creates them. Called from MusicLogic.start. The exact SQL
    // is Signum's; `isPostgres` picks the dialect (Signum reads Schema.Current.Settings.IsPostgres).
    static includeFunction(assets: SchemaAssets, isPostgres: boolean): void {
        if (isPostgres) {
            // The body is written in the exact form `pg_get_functiondef` reports back (leading
            // space before RETURNS/LANGUAGE, `$function$` dollar-quote, LANGUAGE before AS), so the
            // synchronizer's clean()-comparison round-trips to an empty script. Postgres
            // canonicalises a function definition on read regardless of the submitted formatting,
            // so this is the only form that byte-matches (Signum's SchemaAssets workflow: register
            // what the DB reports). Keep in sync if the target Postgres version changes its
            // pg_get_functiondef formatting.
            assets.includeUserDefinedFunction("MinimumTableValued", `(p1 integer, p2 integer)
 RETURNS TABLE(min_value integer)
 LANGUAGE plpgsql
AS $function$
BEGIN
RETURN QUERY
SELECT Case When p1 < p2 Then p1
       Else COALESCE(p2, p1) End as MinValue;
            END
$function$`);
            assets.includeUserDefinedFunction("MinimumScalar", `(p1 integer, p2 integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
BEGIN
RETURN (Case When p1 < p2 Then p1
       Else COALESCE(p2, p1) End);
END
$function$`);
        } else {
            assets.includeUserDefinedFunction("MinimumTableValued", `(@Param1 Integer, @Param2 Integer)
RETURNS Table As
RETURN (SELECT Case When @Param1 < @Param2 Then @Param1
           Else COALESCE(@Param2, @Param1) End MinValue)`);
            assets.includeUserDefinedFunction("MinimumScalar", `(@Param1 Integer, @Param2 Integer)
RETURNS Integer
AS
BEGIN
   RETURN (Case When @Param1 < @Param2 Then @Param1
       Else COALESCE(@Param2, @Param1) End);
END`);
        }
    }
}
