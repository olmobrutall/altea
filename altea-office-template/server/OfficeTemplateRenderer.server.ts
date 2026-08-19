// Port of Signum.Word's WordTemplateRenderer.cs — the four steps that turn a PARSED template into a
// finished document:
//
//   executeQuery()   collect every token the whole document needs, run the query ONCE
//   renderNodes()    let each node rewrite its own neighbourhood, then bind charts/tables
//   assertClean()    no template node may survive
//   renderFileName() the output file's name is itself a text template
//
// The one-query rule is the reason `fillTokens` exists on every node: a template with a `@foreach` over
// order lines and twenty `@[...]` tokens inside it still issues a single query, with those tokens as its
// columns. Rendering then reads rows out of the QueryContext rather than hitting the database per token.
//
// altea divergences:
//  - `QueryDescription` is gone (see the repo CLAUDE.md); the renderer carries a `queryName` and resolves
//    tokens through the registered entity metadata, exactly as @altea/altea-email's message builder does.
//  - `Signum.Engine.Basics.QueryLogic.Queries.ExecuteQuery` is async here (`executeQueryAsync`), so the
//    whole render path is async — hence `processTables` being awaited.
//  - `EmbeddedPackagePart` (the workbook Word embeds behind a chart) has no typed class; it is recognised
//    by CONTENT TYPE instead.

import type { Entity } from "@altea/altea/data/entity";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Column, Order, QueryRequest, type Filter } from "@altea/altea/server/dynamicQuery/requests";
import { QueryContext } from "@altea/altea-templating/server/ValueProviders.server";
import type { BlockNode as TextBlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { TextTemplateParameters } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { QueryFilterUtils } from "@altea/altea-user-assets/server/QueryFilterUtils.server";
import type { OfficeTemplateEntity } from "../data/OfficeTemplate";
import { BaseNode, MatchNode } from "./OfficeTemplateNodes.server";
import { OfficeTemplateParameters, type IOfficeModel } from "./OfficeTemplateParameters.server";
import type { OxmlPackage } from "./oxml/OxmlPackage.server";
import { processTables } from "./TableBinder.server";

export class OfficeTemplateRenderer {
    private queryContext: QueryContext | undefined;

    constructor(
        private readonly package_: OxmlPackage,
        private readonly queryName: QueryName | undefined,
        private readonly culture: string,
        private readonly template: OfficeTemplateEntity,
        private readonly model: IOfficeModel | undefined,
        private readonly entity: Entity | null,
        /** The parsed `fileName` template, printed after the document renders. */
        private readonly fileNameBlock: TextBlockNode | undefined,
    ) { }

    /**
     * Signum's ExecuteQuery — walk every node in every part, union the tokens they need, and run one query.
     */
    async executeQuery(): Promise<void> {
        const queryName = this.queryName;
        if (queryName == null)
            return; // a model-only template: there are no query rows to fetch

        const tokens: QueryToken[] = [];

        for (const part of this.package_.parts)
            if (part.isXml)
                for (const node of part.document.root.descendantsOfType(BaseNode))
                    node.fillTokens(tokens);

        this.fileNameBlock?.fillQueryTokens(tokens);

        const columns = distinctTokens(tokens).map(qt => new Column(qt));

        const model = this.model;

        const filters: Filter[] = model?.getFilters != null ? model.getFilters(queryName)
            : this.entity != null ? [QueryFilterUtils.entityFilter(queryName, this.entity)]
                : (() => {
                    throw new Error(
                        "Impossible to create an Office report if 'entity' and 'model' are both null");
                })();

        filters.push(...QueryFilterUtils.toFilterList(queryName, this.template.filters));

        const orders: Order[] = model?.getOrders?.(queryName) ?? [];
        orders.push(...this.template.orders.map(qo =>
            new Order(this.token(qo.token.tokenString), qo.orderType as unknown as Order["orderType"])));

        const table = await QueryLogic.queries.executeQueryAsync(new QueryRequest(
            queryName, filters, orders, columns,
            model?.getPagination?.(), this.template.groupResults));

        this.queryContext = new QueryContext(queryName, table);
    }

    /**
     * Signum's RenderNodes — each node replaces itself, then the chart/table binder runs, then the
     * leftovers Word keeps around for its own bookkeeping are stripped.
     */
    async renderNodes(): Promise<void> {
        const parameters = new OfficeTemplateParameters(
            this.entity, this.culture, this.queryContext, this.template, this.model, this.package_);

        for (const part of this.package_.parts) {
            if (!part.isXml)
                continue;

            const root = part.document.root;

            // Eager: rendering MUTATES the tree, so the work list has to be taken first (Signum's "//eager").
            for (const node of root.descendantsOfType(BaseNode))
                node.renderNode(parameters);

            await processTables(part, parameters);

            // A chart keeps a cached copy of the worksheet range it was built from; once the series are
            // rebound that cache is stale, so Signum drops it and lets the consumer re-read the values.
            for (const item of [...root.descendants()].filter(d => d.qualifiedName === "c:externalData"))
                item.remove();
        }

        // Word embeds the whole source workbook behind a chart. It is dead weight in a rendered report (and
        // leaks the template's sample data), so every embedded package is unlinked from its parents.
        for (const part of this.package_.parts.filter(isEmbeddedPackagePart))
            for (const parent of part.getParentParts())
                this.package_.deletePart(parent, part);
    }

    /** Signum's AssertClean — a surviving node means a bug in the parse/render pair, never valid output. */
    assertClean(): void {
        for (const part of this.package_.parts) {
            if (!part.isXml)
                continue;

            const list = part.document.root.descendantsOfType(BaseNode);
            if (list.length > 0)
                throw new Error(
                    `${list.length} unexpected BaseNode instances found in '${part.uri}': ` +
                    list.map(l => l.localName).join(", "));

            const matches = part.document.root.descendantsOfType(MatchNode);
            if (matches.length > 0)
                throw new Error(
                    `${matches.length} unexpected MatchNode instances found in '${part.uri}': ` +
                    matches.map(l => l.matchText).join(", "));
        }
    }

    /** Signum's RenderFileName — the output name is a text template over the same rows. */
    renderFileName(): string {
        if (this.fileNameBlock == null)
            return this.template.fileName;

        return this.fileNameBlock.print(
            new TextTemplateParameters(this.entity, this.culture, this.queryContext));
    }

    /** Resolve one of the template's stored token strings against the query. */
    private token(tokenString: string): QueryToken {
        return QueryLogic.getToken(this.queryName!, tokenString, SubTokensOptionsAll);
    }
}

/**
 * A part that holds a whole embedded Office package (the workbook behind a chart). Signum matches the
 * SDK's `EmbeddedPackagePart`; altea recognises it by content type.
 */
function isEmbeddedPackagePart(part: { contentType: string }): boolean {
    return part.contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        || part.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        || part.contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        || part.contentType === "application/vnd.ms-office.chartex+xml"
        || part.contentType === "application/vnd.openxmlformats-officedocument.oleObject";
}

/** Distinct by the token's full key — the same token reached twice must not become two columns. */
function distinctTokens(tokens: QueryToken[]): QueryToken[] {
    const seen = new Set<string>();
    const out: QueryToken[] = [];
    for (const t of tokens) {
        if (t == null)
            continue;
        const key = t.fullKey();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}
