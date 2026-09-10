import "@altea/altea/server"; // installs Entity.save()/delete()
import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { StringDistance } from "@altea/altea/server/sync/stringDistance";
import { TokenMigrationLogic } from "@altea/altea-user-assets/server/TokenMigrationLogic";
import { walkQueryTokens, type TokenSlot } from "@altea/altea-user-assets/server/TokenSyncWalker";
import type { TokenSyncContext } from "@altea/altea-user-assets/server/TokenSyncContext";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser";
import {
    TemplateSynchronizationContext, TemplateSyncException,
} from "@altea/altea-templating/server/TemplateSync";
import type { ValueProviderBase } from "@altea/altea-templating/server/ValueProviders";
import { ScopedDictionary } from "@altea/altea-templating/server/TemplateUtils";
import { OfficeTemplateEntity } from "../data/OfficeTemplate";
import { OxmlPackage } from "./oxml/OxmlPackage";
import { OfficeTemplateParser } from "./OfficeTemplateParser";
import { BaseNode } from "./OfficeTemplateNodes";
import { OfficeModelLogic } from "./OfficeModelLogic";
import { prepareSpreadsheet } from "./spreadsheet/SpreadsheetUtils";

// The OfficeTemplate half of Signum's `TokenMigrationLogic.TokenSynchronizing` subscription
// (WordTemplateLogic.TokenMigration_Sync / ProcessWordTemplate — `Word*` is `Office*` here, see
// data/OfficeTemplate's naming divergence). The filter / order walk is the shared one — see
// @altea/altea-user-assets' TokenSyncWalker.
//
// SCOPE — all three halves, in Signum's order:
//
//  1. the stored QUERY tokens: the filters and the orders;
//  2. the DOCUMENT, where `@[Customer.Name]` / `@foreach[Details]` live inside the .docx/.pptx/.xlsx
//     bytes — the same `TemplateSynchronizationContext` @altea/altea-templating drives over text, walked
//     over a different tree (`OfficeTemplateNodes`' own `synchronize` per node);
//  3. the FILE NAME, which is itself a text template.
//
// (2) and (3) take a context EACH, as Signum does: the document pass may throw a TemplateSyncException
// that abandons the template, and the file name is asked about afterwards regardless.
//
// A template whose `query` is null is MODEL-only, so it has no query tokens to repair.

export namespace OfficeTemplateTokenSync {
    export let avoidSynchronizeTokens = false;

    /** Registered by OfficeTemplateLogic.start. */
    export function register(): void {
        TokenMigrationLogic.registerTokenSynchronizing("OfficeTemplateLogic.tokenSynchronizing", run);
    }

    async function run(ctx: TokenSyncContext): Promise<void> {
        if (avoidSynchronizeTokens)
            return;

        const list = await ExecutionMode.global(async () =>
            await table(OfficeTemplateEntity).toArray() as OfficeTemplateEntity[]);

        for (const ot of list)
            await processTemplate(ctx, ot);
    }

    async function processTemplate(ctx: TokenSyncContext, ot: OfficeTemplateEntity): Promise<void> {
        if (ctx.mode === "Apply") {
            const known = ctx.knownAction(ot);
            if (known != null) {
                try {
                    if (known === "Delete")
                        await deleteTemplate(ctx, ot);
                } catch (e) {
                    ctx.logError(ot, e);
                }
                return;
            }
        }

        try {
            const queryName = ot.query == null ? undefined : QueryLogic.tryToQueryName(ot.query.key);
            if (ot.query != null && queryName == null) {
                SafeConsole.writeLineColor(Color.darkRed,
                    `  OfficeTemplate '${ot.name}': query '${ot.query.key}' no longer exists`);
                return;
            }

            let touched = false;

            if (ot.query != null) {
                const result = await walkQueryTokens(ctx, {
                    queryKey: ot.query.key,
                    queryName: queryName!,
                    groupResults: false,
                    filters: {
                        rows: ot.filters,
                        remove: row => {
                            const i = ot.filters.indexOf(row as OfficeTemplateEntity["filters"][number]);
                            if (i >= 0)
                                ot.filters.splice(i, 1);
                        },
                    },
                    orders: ot.orders.map((ord): TokenSlot => ({
                        get: () => ord.token,
                        set: t => { ord.token = t; },
                        remove: () => { ot.orders.splice(ot.orders.indexOf(ord), 1); },
                    })),
                });

                if (result.outcome === "Skip")
                    return;

                if (result.outcome === "Delete") {
                    await deleteTemplate(ctx, ot);
                    return;
                }

                touched = result.outcome === "Touched";
            }

            const modelType = ot.model == null ? undefined : OfficeModelLogic.toType(ot.model);

            // (2) the DOCUMENT pass.
            try {
                if (await synchronizeDocument(ctx, ot, queryName, modelType))
                    touched = true;
            } catch (e) {
                if (!(e instanceof TemplateSyncException))
                    throw e;

                if (e.result === "DeleteEntity") {
                    await deleteTemplate(ctx, ot);
                    return;
                }
                // SkipEntity, and RegenerateEntity — which reseeds a template from its model's DEFAULT
                // document, an office-module operation nothing here can do, so it is treated as Skip.
                return;
            }

            // (3) the FILE NAME, itself a text template.
            try {
                const sc = new TemplateSynchronizationContext(ot, ctx, new StringDistance(), queryName, modelType);
                const newFileName = await TextTemplateParser.synchronize(ot.fileName, sc);
                if (newFileName != ot.fileName) {
                    ot.fileName = newFileName!;
                    touched = true;
                }
            } catch (e) {
                if (!(e instanceof TemplateSyncException))
                    throw e;

                if (e.result === "DeleteEntity") {
                    await deleteTemplate(ctx, ot);
                    return;
                }
                return;
            }

            if (touched && ctx.mode === "Apply")
                await ExecutionMode.global(() => Transaction.forceNew(async () => { await ot.save(); }));
        } catch (e) {
            ctx.logError(ot, e);
        }
    }

    /**
     * Signum's `wt.ProcessOpenXmlPackage(...)` block: parse the stored document, repair every token in
     * it, and — only if something changed — print the tree back out as literal template text.
     *
     * Answers whether the bytes were rewritten. The template is NOT saved here; the caller does that once
     * for all three passes.
     */
    async function synchronizeDocument(
        ctx: TokenSyncContext,
        ot: OfficeTemplateEntity,
        queryName: ReturnType<typeof QueryLogic.tryToQueryName>,
        modelType: Function | undefined,
    ): Promise<boolean> {
        const file = ot.template;
        if (file?.binaryFile == null || file.binaryFile.length === 0)
            return false;

        const sc = new TemplateSynchronizationContext(ot, ctx, new StringDistance(), queryName, modelType);

        const package_ = OxmlPackage.load(file.binaryFile);
        const parser = new OfficeTemplateParser(package_, ot, queryName, modelType, prepareSpreadsheet);
        parser.parseDocument();
        parser.createNodes();
        parser.assertClean();

        // Eager on BOTH walks, as the renderer's is: each node REPLACES itself in the tree, so the work
        // list has to be taken first.
        //
        // This reaches only the TOP-LEVEL nodes — a block container's body was moved into a BlockNode
        // that is not its child in the tree — so a container recursing is what covers the rest, and is
        // where the variable scoping lives. See BaseNode.synchronize.
        for (const root of package_.allRootElements)
            for (const node of root.descendantsOfType(BaseNode))
                await node.synchronize(sc);

        if (!sc.hasChanges)
            return false;

        for (const root of package_.allRootElements) {
            const variables = new ScopedDictionary<ValueProviderBase>(undefined);
            for (const node of root.descendantsOfType(BaseNode))
                node.renderTemplate(variables);
        }

        // A FileEntity is IMMUTABLE, and this is one of the three places Signum lifts that per instance
        // (`file.AllowChange = true`) rather than making a new row: the document is the SAME file with
        // its tokens repaired, and a new row would leave the old one behind for every template that
        // shares it. The hash follows the bytes in FileLogic's own preSaving.
        file.allowChange = true;
        file.binaryFile = package_.save();
        return true;
    }

    async function deleteTemplate(ctx: TokenSyncContext, ot: OfficeTemplateEntity): Promise<void> {
        if (ctx.mode === "Record")
            ctx.addUserAssetAction(ot, "Delete");
        else
            await ExecutionMode.global(() => Transaction.forceNew(async () => { await ot.delete(); }));
    }
}
