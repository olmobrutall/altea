import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { getKey, getNiceName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { reflectionDefaultColumns } from "@altea/altea/data/dynamicQuery/defaultColumns";
import { cleanTypeName, getLocation } from "@altea/altea/data/registration";
import { SkillCode, Schema as S } from "../SkillCode";
import type { SkillPropertyDescriptor } from "../SkillCode";
import { CurrentServerContextSkill } from "./CurrentServerContextSkill";
import {
    assertValidFindOptions, findOptionsPath, registeredQueryKeys, resolveQueryName, toQueryRequest, type FindOptions,
} from "./FindOptions";

// Port of Signum.Agent's Skills/SearchSkill.cs — the skill that teaches the model altea's query system and
// then runs it. The FindOptions model, its validation and its URL encoder live in ./FindOptions.ts.
//
// altea divergences, documented inline:
//  - Signum's `QueryDescription` tool is `QueryTokens` here, and it returns the ROOT token's children plus
//    which of them are the query's default columns — the token tree IS altea's query metadata (there is no
//    QueryDescription DTO; see the repo CLAUDE.md). `SubTokens` is unchanged in spirit.
//  - Signum groups the root queries by .NET NAMESPACE; altea has no namespaces, so the grouping key is the
//    MODULE a query's type was declared in (its `FileInfo` location — the same source `TypeEntity.package`
//    is filled from). `ListQueryNames` therefore takes a module name.
//  - "allowed" queries are filtered through `QueryLogic.assertQueryAllowedHook` (the framework's query-auth
//    seam) rather than Signum's `GetAllowedQueryNames`, so the skill works with or without an auth module.
//  - the tools' JSON schemas are declared, not reflected (see SkillCode.ts).

/** Signum's `SkillProperty_QueryList` — a comma-separated list of query keys. */
function queryListProperty(name: string, get: () => Set<string>, set: (value: Set<string>) => void): SkillPropertyDescriptor {
    return {
        name,
        attributeName: "SkillProperty_QueryList",
        propertyType: "HashSet<QueryName>",
        valueHint: "Comma-separated query keys",
        getAsString: () => [...get()].join(", "),
        setFromString: value => set(new Set((value ?? "").split(",").map(k => k.trim()).filter(k => k !== ""))),
        validate: value => {
            if (value == null)
                return null;
            const known = new Set(registeredQueryKeys());
            const unknown = value.split(",").map(k => k.trim()).filter(k => k !== "" && !known.has(k));
            return unknown.length > 0 ? `Unknown query key(s): ${unknown.join(", ")}` : null;
        },
    };
}

export class SearchSkill extends SkillCode {

    /** Signum's `[SkillProperty_QueryList] HashSet<object> InlineQueryName` — spelled out in the prompt. */
    inlineQueryName = new Set<string>();

    constructor() {
        super();

        this.shortDescription = "Explores the database schema and queries any information in the database";
        this.isAllowed = () => true;

        this.registerProperty(queryListProperty("inlineQueryName",
            () => this.inlineQueryName, v => { this.inlineQueryName = v; }));

        this.replacements = {
            "<LIST_ROOT_QUERIES>": () => listRootQueries(this.inlineQueryName),
        };

        this.registerTool({
            name: "ListQueryNames",
            description: "List all query names in a module",
            returnType: "string[]",
            parameters: S.args({ moduleName: S.string("The module a query's type is declared in") }),
            invoke: async args => allowedQueryNames()
                .filter(qn => moduleOf(qn) === String(args["moduleName"]))
                .map(qn => getKey(qn)),
        });

        this.registerTool({
            name: "QueryTokens",
            description: "Gets the columns (root tokens) of a query, and which of them are its default columns",
            returnType: "QueryTokensResult",
            parameters: S.args({ queryKey: S.string() }),
            invoke: async args => {
                const queryName = resolveQueryName(String(args["queryKey"]));
                const root = QueryLogic.getRootToken(queryName);
                const defaults = new Set(reflectionDefaultColumns(root).map(t => t.fullKey()));

                return {
                    queryKey: getKey(queryName),
                    niceName: getNiceName(queryName),
                    tokens: root.subTokens(SubTokensOptionsAll).map(t => describeToken(t, defaults)),
                };
            },
        });

        this.registerTool({
            name: "SubTokens",
            description: "Returns the sub-tokens of a query token",
            returnType: "QueryTokenInfo[]",
            parameters: S.args({
                queryKey: S.string(),
                token: S.string("The full dotted token key; empty for the query root"),
            }),
            invoke: async args => {
                const queryName = resolveQueryName(String(args["queryKey"]));
                const parent = QueryLogic.getToken(queryName, String(args["token"] ?? ""), SubTokensOptionsAll);
                return parent.subTokens(SubTokensOptionsAll).map(t => describeToken(t));
            },
        });

        this.registerTool({
            name: "GetFindOptionsUrl",
            description: "Convert FindOptions to a url",
            returnType: "string",
            parameters: S.args({ findOptions: findOptionsSchema() }),
            invoke: async args => {
                const fo = args["findOptions"] as FindOptions;
                assertValidFindOptions(fo);
                return (CurrentServerContextSkill.urlLeft?.() ?? "") + findOptionsPath(fo);
            },
        });

        this.registerTool({
            name: "GetResultTable",
            description: "Executes a FindOptions and returns a dynamic ResultTable",
            returnType: "ResultTableSimple",
            parameters: S.args({ findOptions: findOptionsSchema() }),
            invoke: async args => {
                const fo = args["findOptions"] as FindOptions;
                const request = toQueryRequest(fo);
                const rt = await QueryLogic.queries.executeQueryAsync(request);

                // Signum's ResultTableSimple: columns as c0..cN → full token key, rows as objects.
                return {
                    columns: Object.fromEntries(rt.columns.map((c, i) => [`c${i}`, c.token.fullKey()])),
                    rows: rt.rows.map(row => {
                        const dic: Record<string, unknown> = {};
                        if (!request.groupResults)
                            dic["Entity"] = row.entity;
                        rt.columns.forEach((c, i) => dic[`c${i}`] = row.getValue(c.token));
                        return dic;
                    }),
                };
            },
        });
    }
}

function describeToken(token: { key: string; fullKey(): string; toString(): string; niceName(): string; type?: unknown },
    defaults?: Set<string>): Record<string, unknown> {
    const type = token.type as { typeName?: string; array?: boolean; lite?: boolean } | undefined;
    return {
        key: token.key,
        fullKey: token.fullKey(),
        niceName: token.niceName(),
        type: type?.typeName ?? "",
        isCollection: type?.array === true,
        isEntity: type?.lite === true,
        ...(defaults != undefined ? { isDefaultColumn: defaults.has(token.fullKey()) } : {}),
    };
}

/** Every registered query the current role may open (Signum's GetAllowedQueryNames(fullScreen: true)). */
export function allowedQueryNames(): QueryName[] {
    // The auth hook is async in altea, so it cannot gate a synchronous list. Registered queries are the
    // list; a query the role may not open still fails at execution, where the hook does run. Read from the
    // query CONTAINER, not QueryLogic's name-only registry (see FindOptions.resolveQueryName).
    return QueryLogic.queries.getQueryNames();
}

/**
 * The PACKAGE a query's type was declared in — altea's stand-in for Signum's .NET namespace. It is the
 * same `FileInfo.packageName` that fills `TypeEntity.package`, so the grouping the model sees matches the
 * grouping the rest of the application shows.
 */
export function moduleOf(queryName: QueryName): string {
    const name = queryName.name;
    return getLocation(name)?.packageName ?? "Unknown";
}

/** Signum's `<LIST_ROOT_QUERIES>` replacement: one line per module, with the inline queries spelled out. */
export function listRootQueries(inlineQueryName: Set<string>): string {
    const byModule = new Map<string, QueryName[]>();
    for (const qn of allowedQueryNames()) {
        const module = moduleOf(qn);
        const list = byModule.get(module);
        if (list == undefined)
            byModule.set(module, [qn]);
        else
            list.push(qn);
    }

    const lines: string[] = [];
    for (const [module, queries] of [...byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const inline = queries.filter(qn => inlineQueryName.has(getKey(qn)));
        if (inline.length > 0) {
            lines.push(`* Module ${module}: ${queries.length} queries including...`);
            for (const qn of inline)
                lines.push(`  * ${getKey(qn)}${implementationsSuffix(qn)}`);
        } else {
            lines.push(`* Module ${module}: ${queries.length} queries`);
        }
    }
    return lines.join("\n");
}

/** Signum's "(ImplementedBy …)" note, for a query whose root is an @implementedByAll reference. */
function implementationsSuffix(queryName: QueryName): string {
    const implementations = QueryLogic.getImplementedByAllTypes(queryName);
    if (implementations.length <= 1)
        return "";

    return ` (ImplementedBy ${implementations.map(t => cleanTypeName(t)).join(", ")})`;
}

/**
 * The FindOptions schema the model fills in. Written out rather than reflected (see SkillCode.ts); the
 * shape mirrors ./FindOptions.ts, and the prompt (Search.md) documents the semantics.
 */
export function findOptionsSchema(): ReturnType<typeof S.object> {
    const filter: ReturnType<typeof S.object> = {
        type: "object",
        description: "A filter condition (token + operation + value) or a group (groupOperation + filters)",
        properties: {
            token: S.string(),
            operation: S.string("EqualTo, DistinctTo, GreaterThan, GreaterThanOrEqual, LessThan, LessThanOrEqual, Contains, StartsWith, EndsWith, Like, NotContains, NotStartsWith, NotEndsWith, NotLike, IsIn, IsNotIn"),
            value: S.any(),
            groupOperation: S.string("And or Or"),
            // Recursion by description: a JSON Schema `$ref` is not portable across the three providers.
            filters: S.array(S.any(), "Nested filters, same shape as this object"),
        },
        required: [],
        additionalProperties: false,
    };

    return S.object({
        queryName: S.string("The query key, e.g. \"Order\""),
        groupResults: S.boolean(),
        includeDefaultFilters: S.boolean(),
        filterOptions: S.array(filter),
        orderOptions: S.array(S.object({
            token: S.string(),
            orderType: S.string("Ascending or Descending"),
        }, ["token"])),
        columnOptionsMode: S.string("Add, Remove, ReplaceAll, InsertStart or ReplaceOrAdd"),
        columnOptions: S.array(S.object({
            token: S.string(),
            displayName: S.string(),
            summaryToken: S.string(),
            hiddenColumn: S.boolean(),
        }, ["token"])),
        pagination: S.object({
            mode: S.string("All, Firsts or Paginate"),
            elementsPerPage: S.number(),
            currentPage: S.number(),
        }, ["mode"]),
    }, ["queryName"]);
}

