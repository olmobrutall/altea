import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import type { Entity } from "@altea/altea/data/entity";
import { ModelConverterSymbol, TemplateApplicableSymbol, type ITemplateApplicable } from "../data/Templating";
import { TemplatingServer } from "./TemplatingServer.server";

// Port of Signum.Templating's TemplatingLogic.cs — the module's `start(sb)`: the two symbol tables and
// the code registries behind them.
//
// altea divergences, documented inline:
//  - `TypeHelpLogic.Start(sb)` (the C#-source type browser that fed the Eval script editor) goes with the
//    Eval deferral — there is no script to write, so there is nothing to browse.
//  - `TemplateApplicableSymbol` is altea-only: it replaces Signum's compiled TemplateApplicableEval (see
//    data/Templating.ts). Both registries are keyed by the symbol's KEY, not the symbol OBJECT: a symbol
//    read back from the database is a fresh instance, not the declared singleton (the same gotcha
//    SimpleTaskLogic documents).

export namespace TemplatingLogic {

    const converters = new Map<string, (from: Entity) => Entity>();
    const declaredConverters: ModelConverterSymbol[] = [];

    const applicables = new Map<string, ITemplateApplicable>();
    const declaredApplicables: TemplateApplicableSymbol[] = [];

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, ModelConverterSymbol, () => declaredConverters);
        SymbolLogic.start(sb, TemplateApplicableSymbol, () => declaredApplicables);

        sb.include(ModelConverterSymbol).withQuery();
        sb.include(TemplateApplicableSymbol).withQuery();

        if (sb.webBuilder)
            TemplatingServer.start(sb.webBuilder);
    }

    /** Signum's `TemplatingLogic.Register<F, T>(modelConverter, converterFunction)` — bind a conversion to
     *  a declared ModelConverterSymbol. Call it BEFORE start (the symbol table is seeded from the keys). */
    export function registerConverter<F extends Entity, T extends Entity>(
        modelConverter: ModelConverterSymbol,
        converterFunction: (from: F) => T,
    ): void {
        assertDeclared(modelConverter, "ModelConverterSymbol");
        if (converters.has(modelConverter.key))
            throw new Error(`TemplatingLogic.registerConverter: '${modelConverter.key}' is already registered`);

        converters.set(modelConverter.key, converterFunction as unknown as (from: Entity) => Entity);
        declaredConverters.push(modelConverter);
    }

    /** Signum's `converterSymbol.Convert(entity)`. */
    export function convert(converterSymbol: ModelConverterSymbol, entity: Entity): Entity {
        const converter = converters.get(converterSymbol.key);
        if (converter == undefined)
            throw new Error(`ModelConverter '${converterSymbol.key}' has no registered function`);
        return converter(entity);
    }

    /** altea-only (see the header): bind an "is this template applicable to this entity" predicate to a
     *  declared TemplateApplicableSymbol. Call it BEFORE start. */
    export function registerApplicable(symbol: TemplateApplicableSymbol, predicate: ITemplateApplicable): void {
        assertDeclared(symbol, "TemplateApplicableSymbol");
        if (applicables.has(symbol.key))
            throw new Error(`TemplatingLogic.registerApplicable: '${symbol.key}' is already registered`);

        applicables.set(symbol.key, predicate);
        declaredApplicables.push(symbol);
    }

    /** Evaluate a registered applicable predicate. An UNREGISTERED symbol throws — a template pointing at
     *  a predicate nobody implements is a configuration error, not "applicable to everything". */
    export function isApplicable(symbol: TemplateApplicableSymbol, entity: Entity | null): boolean {
        const predicate = applicables.get(symbol.key);
        if (predicate == undefined)
            throw new Error(`TemplateApplicable '${symbol.key}' has no registered predicate`);
        return predicate(entity);
    }

    function assertDeclared(symbol: { key?: string } | null | undefined, kind: string): void {
        if (symbol?.key == undefined)
            throw new Error(`TemplatingLogic: the ${kind} is null — is it declared with init() inside a namespace?`);
    }
}
