// The query HTTP API (Signum's QueriesController.cs), on altea's typed `ws` wrapper (./webApi).
// Register on a SchemaBuilder's webBuilder alongside EntitiesServer:
//   if (sb.webBuilder) QueryServer.start(sb.webBuilder);
//
// Two layers of contract cross here:
//   - the SERVER-ONLY sub-tokens (serverTokens) — plain JSON, no entity graph, so res.json.
//   - executeQuery — the client POSTs a wire QueryRequest (string tokens, filters, orders,
//     pagination — entities/dynamicQuery/queryRequest); the server PARSES it into the engine's
//     QueryRequest (parsed QueryTokens), runs it, and serialises the ResultTable back through the
//     entity Serializer (res.jsonTyped) so the lites/values in the rows go out in wire form.

import { Entity } from "../data/entity";
import { Temporal, Decimal } from "../data/basics";
import { resolveCleanType } from "../data/registration";
import { SubTokensOptionsAll } from "../data/dynamicQuery/tokens";
import {
    isServerOnlyToken, serializeServerToken, type ServerTokenJson,
} from "../data/dynamicQuery/tokenSerializer";
import type { QueryName } from "../data/dynamicQuery/queryUtils";
import type { QueryToken } from "../data/dynamicQuery/tokens";
import type {
    QueryRequest as WireQueryRequest, ResultTable as WireResultTable,
    QueryValueRequest as WireQueryValueRequest,
    FilterRequest, Pagination as WirePagination,
} from "../data/dynamicQuery/queryRequest";
import { QueryLogic } from "./dynamicQuery/queryLogic";
import {
    QueryRequest, Column, Order, type Filter, FilterCondition, FilterGroup, Pagination,
    FilterOperation, type FilterGroupOperation, type OrderType,
} from "./dynamicQuery/requests";
import type { ResultTable } from "./dynamicQuery/resultTable";
import { WebBuilder, CustomType } from "./webApi";

export namespace QueryServer {

    export function start(ws: WebBuilder): void {

        // GET /api/query/:queryKey/serverTokens?token=<fullKey>&options=<bitflags>
        // The server-only sub-tokens of the parent token (empty `token` ⇒ children of the entity root).
        ws.get("/api/query/:queryKey/serverTokens",
            { params: CustomType<{ queryKey: string }>(), res: CustomType<ServerTokenJson[]>() },
            async (req, res) => {
                const queryName = QueryLogic.tryToQueryName(req.params.queryKey) ?? resolveCleanType(req.params.queryKey);
                if (queryName == undefined) {
                    res.status(404).json({ error: `Query '${req.params.queryKey}' not found` });
                    return;
                }
                const tokenString = (req.query.token as string | undefined) ?? "";
                const options = req.query.options != undefined ? Number(req.query.options) : SubTokensOptionsAll;

                const parent = QueryLogic.getToken(queryName, tokenString, options);
                const serverTokens = parent.subTokens(options).filter(isServerOnlyToken).map(serializeServerToken);
                res.json(serverTokens);
            });

        // POST /api/query/executeQuery/:queryKey — run a query request → ResultTable (Signum's
        // QueryController.ExecuteQuery). The row entity + column values (lites/entities/dates) are
        // serialised through the entity Serializer by res.jsonTyped.
        ws.post("/api/query/executeQuery/:queryKey",
            { params: CustomType<{ queryKey: string }>(), req: CustomType<WireQueryRequest>(), res: CustomType<WireResultTable>() },
            async (req, res) => {
                const wire = await req.jsonTyped() as WireQueryRequest;
                const request = parseQueryRequest(wire);
                // Query authorization (Signum's AssertQueryAllowed, fullScreen:false → blocks only None).
                await QueryLogic.assertQueryAllowedHook?.(request.queryName, false);
                const rt = await QueryLogic.queries.executeQueryAsync(request);
                res.jsonTyped(toWireResultTable(rt, wire));
            });

        // POST /api/query/queryValue/:queryKey — a scalar value for a query (Signum's
        // QueryController.QueryValue): with no `valueToken` it is the row COUNT (what SearchValue /
        // SearchValueLine request), the count used for "N users in this role" badges. A `valueToken`
        // aggregate (Sum/Min/Max of a column) is not wired yet — it needs the aggregate-token executor.
        ws.post("/api/query/queryValue/:queryKey",
            { params: CustomType<{ queryKey: string }>(), req: CustomType<WireQueryValueRequest>(), res: CustomType<unknown>() },
            async (req, res) => {
                const wire = await req.jsonTyped() as WireQueryValueRequest;
                if (wire.valueToken != undefined && wire.valueToken !== "Count")
                    throw new Error(`queryValue with valueToken '${wire.valueToken}' is not supported yet (only Count).`);
                const queryName = resolveQueryName(wire.queryKey);
                await QueryLogic.assertQueryAllowedHook?.(queryName, false);
                const token = (s: string): QueryToken => QueryLogic.getToken(queryName, s, SubTokensOptionsAll);
                const filters = (wire.filters ?? []).map(f => parseFilter(token, f));
                // Count = execute with the filters and no display columns, then size the result. (A true
                // SQL COUNT(*) would avoid materialising rows; fine for the small reference-count queries.)
                const request = new QueryRequest(queryName, filters, [], [], new Pagination.All(), false);
                const rt = await QueryLogic.queries.executeQueryAsync(request);
                res.jsonTyped(rt.rows.length);
            });
    }
}

// ---- wire → engine ---------------------------------------------------------------------------

function resolveQueryName(queryKey: string): QueryName {
    const qn = QueryLogic.tryToQueryName(queryKey) ?? resolveCleanType(queryKey);
    if (qn == undefined)
        throw new Error(`Query '${queryKey}' not found`);
    return qn;
}

/** The wire → engine translation, Signum's `QueryRequestTS.ToQueryRequest`: exported because every module
 *  that takes a query request over HTTP needs it (Signum.Excel's controller is the first). */
export function parseQueryRequest(wire: WireQueryRequest): QueryRequest {
    const queryName = resolveQueryName(wire.queryKey);
    const opt = SubTokensOptionsAll;
    const token = (s: string): QueryToken => QueryLogic.getToken(queryName, s, opt);

    const columns = (wire.columns ?? []).map(c => new Column(token(c.token), c.displayName));
    const orders = (wire.orders ?? []).map(o => new Order(token(o.token), o.orderType as OrderType));
    const filters = (wire.filters ?? []).map(f => parseFilter(token, f));
    const pagination = parsePagination(wire.pagination);

    return new QueryRequest(queryName, filters, orders, columns, pagination, wire.groupResults ?? false);
}

function parseFilter(token: (s: string) => QueryToken, f: FilterRequest): Filter {
    if ("filters" in f) // FilterGroupRequest
        return new FilterGroup(
            f.groupOperation as FilterGroupOperation,
            f.token != undefined ? token(f.token) : undefined,
            f.filters.map(sub => parseFilter(token, sub)));
    const t = token(f.token);
    const op = f.operation as FilterOperation;
    return new FilterCondition(t, op, deserializeFilterValue(t, op, f.value));
}

// Signum's FilterValueConverter: deserialize a wire filter value against the token's type. IsIn /
// IsNotIn carry an ARRAY of that type. Lites/entities/embeddeds already arrive decoded (the request
// body went through the entity Serializer); enums (member-name string), dates and primitives don't.
function deserializeFilterValue(token: QueryToken, operation: FilterOperation, raw: unknown): unknown {
    if (operation === FilterOperation.IsIn || operation === FilterOperation.IsNotIn)
        return Array.isArray(raw) ? raw.map(v => deserializeSingle(token, v)) : raw;
    return deserializeSingle(token, raw);
}

function deserializeSingle(token: QueryToken, raw: unknown): unknown {
    if (raw == null) return raw;
    switch (token.filterType) {
        case "Integer": return typeof raw === "number" ? raw : Number(raw);
        // A decimal filter value round-trips as a STRING (the client's DecimalSerializer); rebuild the
        // exact Decimal so the SQL parameter keeps full precision (normalizeScalar stringifies it back).
        case "Decimal": return raw instanceof Decimal ? raw : new Decimal(raw as Decimal.Value);
        case "Boolean": return typeof raw === "boolean" ? raw : raw === "true";
        case "Enum": {
            // The wire carries the enum member NAME; the column stores its ordinal value.
            const e = token.type.getEnum() as Record<string, unknown> | undefined;
            return e != null && typeof raw === "string" && raw in e ? e[raw] : raw;
        }
        case "DateTime":
        case "Time": return coerceTemporal(token, raw);
        case "String":
        case "Guid": return String(raw);
        default: return raw; // Lite / Embedded / Model — already decoded by the Serializer
    }
}

// ISO string → the token's Temporal type (the column materialises as a Temporal, so the filter
// constant must be one too), keyed by the token's typeName.
function coerceTemporal(token: QueryToken, raw: unknown): unknown {
    if (typeof raw !== "string") return raw;
    switch (token.type.typeName) {
        case "PlainDate": return Temporal.PlainDate.from(raw);
        case "PlainDateTime": return Temporal.PlainDateTime.from(raw);
        case "PlainTime": return Temporal.PlainTime.from(raw);
        default: return raw;
    }
}

function parsePagination(p: WirePagination | undefined): Pagination {
    switch (p?.mode) {
        case "Firsts": return new Pagination.Firsts(p.elementsPerPage ?? 20);
        case "Paginate": return new Pagination.Paginate(p.elementsPerPage ?? 20, p.currentPage ?? 1);
        default: return new Pagination.All();
    }
}

// ---- engine → wire ---------------------------------------------------------------------------

// The row entity as a Lite (the wire contract): a materialised full entity → its lite, otherwise
// passed through (already a lite, or undefined).
function liteify(value: unknown): WireResultTable["rows"][number]["entity"] {
    return value instanceof Entity
        ? value.toLite() as WireResultTable["rows"][number]["entity"]
        : value as WireResultTable["rows"][number]["entity"];
}

function toWireResultTable(rt: ResultTable, wire: WireQueryRequest): WireResultTable {
    return {
        columns: rt.columns.map(c => c.token.fullKey()),
        uniqueValues: {},
        // The row's entity (a Lite) and each display column's value at the row index. Lites / entities
        // / Temporal dates are encoded by the Serializer when res.jsonTyped stringifies this object.
        rows: rt.rows.map(row => ({
            // The wire contract is a Lite for the row entity; altea's root ("") token materialises the
            // full entity, so lite-ify it here (Signum's Entity column is a lite).
            entity: liteify(rt.entityColumn?.values[row.index]),
            columns: rt.columns.map(c => c.values[row.index]),
        })),
        pagination: wire.pagination,
        // The paged total (Signum's ResultTable.TotalElements): the client needs it to compute
        // totalPages / the "N of M results" label. Without it totalPages is NaN and the pagination
        // renders bogus extra pages that all return an empty page.
        totalElements: rt.totalElements,
    };
}
