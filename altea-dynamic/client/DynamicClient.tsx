import * as React from "react";
import { ajaxGet } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { DynamicCompilationStatus } from "../data/DynamicPanel";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { DynamicCSSOverrideEntity } from "../data/DynamicCSSOverride";
import { DynamicRenameEntity, DynamicSqlMigrationEntity } from "../data/DynamicSqlMigration";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { DynamicTypeEntity, DynamicTypeOperation, DynamicTypeMessage } from "../data/DynamicType";
import { DynamicMixinConnectionEntity } from "../data/DynamicMixinConnection";
import { DynamicExpressionEntity } from "../data/DynamicExpression";
import { DynamicValidationEntity } from "../data/DynamicValidation";
import { DynamicTypeConditionEntity, DynamicTypeConditionSymbolEntity } from "../data/DynamicTypeCondition";
import { DynamicApiEntity } from "../data/DynamicApi";

// Port of Signum.Dynamic's DynamicCSSOverrideClient.tsx + the client half of its SqlMigrations, plus the one
// piece Signum does in `Index.cshtml`: injecting the stored stylesheet into the page.
//
// altea divergences, documented inline:
//  - Signum interpolates `DynamicCSSOverrideLogic.Cached` into its server-rendered page. altea has no such
//    page, so `applyCSSOverrides` fetches the concatenated text from an ANONYMOUS endpoint and appends one
//    <style> element. The app calls it at boot (before or after login — the endpoint is anonymous precisely
//    so the login screen is styled too, which is the timing Signum's HTML had).
//  - `EvalClient.Options.registerDynamicPanelSearch` — the registry behind the dynamic panel's search box —
//    is re-homed here, because Signum.Eval does not port. It is kept as a plain registry rather than dropped
//    so the panel (and anything else that wants to search across dynamic definitions) has one place to read.
export namespace DynamicClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(DynamicCSSOverrideEntity)
            .withView(() => import("./CSS/DynamicCSSOverride"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.isDisabled),
                ],
            }));

        cb.configure(DynamicSqlMigrationEntity)
            .withView(() => import("./SqlMigrations/DynamicSqlMigration"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.creationDate),
                    token(a => a.createdBy),
                    token(a => a.executionDate),
                    token(a => a.executedBy),
                    token(a => a.comment),
                ],
            }));

        // A rename row is read-only in the UI (Signum shows it as a SearchControl on the panel and offers
        // no editor): it is a record of something that already happened.
        cb.configure(DynamicRenameEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.creationDate),
                    token(a => a.replacementKey),
                    token(a => a.oldName),
                    token(a => a.newName),
                ],
            }));

        registerDynamicPanelSearch(DynamicRenameEntity.typeName, [
            { token: "replacementKey", type: "Text" },
            { token: "oldName", type: "Text" },
            { token: "newName", type: "Text" },
        ]);

        registerDynamicPanelSearch(DynamicCSSOverrideEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "script", type: "Code" },
        ]);

        registerDynamicPanelSearch(DynamicSqlMigrationEntity.typeName, [
            { token: "comment", type: "Text" },
            { token: "script", type: "Code" },
        ]);

        // ---- the COMPILED half (Signum's DynamicTypeClient / DynamicExpressionClient / …) --------------

        cb.configure(DynamicTypeEntity)
            .withView(() => import("./Type/DynamicType"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.typeName),
                    token(a => a.baseType),
                ],
            }));

        cb.configure(DynamicMixinConnectionEntity)
            .withView(() => import("./Type/DynamicMixinConnection"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.entityType),
                    token(a => a.mixinName),
                ],
            }));

        cb.configure(DynamicExpressionEntity)
            .withView(() => import("./Expression/DynamicExpression"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.fromType),
                    token(a => a.returnType),
                ],
            }));

        cb.configure(DynamicValidationEntity)
            .withView(() => import("./Validation/DynamicValidation"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.entityType),
                    token(a => a.subEntity),
                    token(a => a.disabled),
                ],
            }));

        cb.configure(DynamicTypeConditionEntity)
            .withView(() => import("./TypeCondition/DynamicTypeCondition"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.symbolName),
                    token(a => a.entityType),
                ],
            }));

        cb.configure(DynamicTypeConditionSymbolEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                ],
            }));

        cb.configure(DynamicApiEntity)
            .withView(() => import("./Api/DynamicApi"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.disabled),
                ],
            }));

        // Signum's DynamicTypeOperation.Save override opens a modal offering the dynamic panel, because a
        // saved type does nothing until the server restarts. The same message is kept, and the operation
        // needs no override: the view writes its JSON on every edit (see Type/DynamicType), so an ordinary
        // Save carries the definition.
        Operations.addSettings(new EntityOperationSettings(DynamicTypeOperation.Save, {
            onClick: async eoc => {
                await eoc.defaultClick();

                if (eoc.entity.typeName != null)
                    await MessageModal.show({
                        title: DynamicTypeMessage.TypeSaved.niceToString(),
                        message: DynamicTypeMessage.DynamicType0SucessfullySavedGoToDynamicPanelNow
                            .niceToString(eoc.entity.typeName),
                        buttons: "ok",
                        style: "success",
                        icon: "success",
                    });
            },
        }));

        registerDynamicPanelSearch(DynamicTypeEntity.typeName, [
            { token: "typeName", type: "Text" },
            { token: "typeDefinition", type: "JSon" },
        ]);

        registerDynamicPanelSearch(DynamicExpressionEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "fromType", type: "Text" },
            { token: "body", type: "Code" },
        ]);

        registerDynamicPanelSearch(DynamicValidationEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "eval.script", type: "Code" },
        ]);

        registerDynamicPanelSearch(DynamicTypeConditionEntity.typeName, [
            { token: "eval.script", type: "Code" },
        ]);

        registerDynamicPanelSearch(DynamicApiEntity.typeName, [
            { token: "name", type: "Text" },
            { token: "eval.script", type: "Code" },
        ]);

        // The panel — Signum's /dynamic/panel, same path.
        cb.routes.push({
            path: "/dynamic/panel",
            element: <ImportComponent onImport={() => import("./DynamicPanelPage")} />,
        });
    }

    // ---- the panel search registry (Signum's EvalClient.Options.registerDynamicPanelSearch) -------------

    export type DynamicPanelSearchType = "Text" | "Code" | "JSon";

    export interface DynamicPanelSearchColumn {
        token: string;
        type: DynamicPanelSearchType;
    }

    export const registeredPanelSearches: { [typeName: string]: DynamicPanelSearchColumn[] } = {};

    export function registerDynamicPanelSearch(typeName: string, columns: DynamicPanelSearchColumn[]): void {
        registeredPanelSearches[typeName] = columns;
    }

    // ---- the CSS overrides (Signum's Index.cshtml interpolation) ----------------------------------------

    const styleElementId = "sf-dynamic-css-overrides";

    /**
     * Fetch the concatenated stylesheet and append it as ONE <style> element, replacing any previous one.
     * Idempotent, so it can also be called again after a CSS override is saved.
     */
    export async function applyCSSOverrides(): Promise<void> {
        const css = await API.getCSSOverrides();

        document.getElementById(styleElementId)?.remove();

        if (!css)
            return;

        const style = document.createElement("style");
        style.id = styleElementId;
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
    }

    export namespace API {
        export function getCSSOverrides(): Promise<string> {
            return ajaxGet({ url: "/api/dynamic/cssOverrides" });
        }

        /** Did the dynamic code compile, and if not why — what the panel is for. */
        export function compilationStatus(): Promise<DynamicCompilationStatus> {
            return ajaxGet({ url: "/api/dynamic/compilationStatus" });
        }
    }
}
