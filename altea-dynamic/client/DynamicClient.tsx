import * as React from "react";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import * as AppContext from "@altea/altea/client/AppContext";
import { registerSpecialAction } from "@altea/altea/client/OmniboxSpecialAction";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { EvalPanelPermission } from "@altea/altea-eval/data/EvalPanelPermission";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { DynamicCompilationStatus, DynamicCompileResult } from "../data/DynamicPanel";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { DynamicCSSOverrideEntity } from "../data/DynamicCSSOverride";
import { DynamicSqlMigrationCommand, DynamicSqlMigrationEntity, DynamicSqlMigrationMessage, DynamicSqlMigrationOperation } from "../data/DynamicSqlMigration";
import { DynamicClientModules } from "./DynamicClientModules";
import WebConsoleModal from "@altea/altea/client/WebConsole/WebConsoleModal";
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
//    is re-homed here from @altea/altea-eval, because THIS module owns the admin pages. It is kept as a
//    plain registry so the panel, and anything else searching across dynamic definitions, has one place
//    to read.
export namespace DynamicClient {

    export function start(cb: ClientBuilder): void {

        // The dynamic types themselves, before the reflection blob that is applied to them.
        DynamicClientModules.start();

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
            }))
            // The script is generated in a web console, so the synchronizer can ask its rename questions.
            .withConstructorOperation(DynamicSqlMigrationOperation.Create, {
                onConstruct: async coc => {
                    const answer = await WebConsoleModal.show(DynamicSqlMigrationEntity.niceName(), DynamicSqlMigrationCommand.Generate);
                    if (answer == null)
                        return undefined;
                    if (answer.result == null) {
                        await MessageModal.show({
                            title: DynamicSqlMigrationEntity.niceName(),
                            message: DynamicSqlMigrationMessage.TheSchemaIsAlreadyUpToDate.niceToString(),
                            buttons: "ok",
                        });
                        return undefined;
                    }
                    return coc.defaultConstruct(answer.result);
                },
            });

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
            }))
            // A saved type does nothing until the server restarts, so Save points at the dynamic panel.
            .withEntityOperation(DynamicTypeOperation.Save, {
                onClick: eoc => {
                    // Only once the save SUCCEEDED: a rejected save (a source rule) returns normally too.
                    eoc.onExecuteSuccess = async pack => {
                        await eoc.onExecuteSuccess_Default(pack);

                        if (!AuthClient.isPermissionAuthorized(EvalPanelPermission.ViewDynamicPanel))
                            return;

                        const answer = await MessageModal.show({
                            title: DynamicTypeMessage.TypeSaved.niceToString(),
                            message: DynamicTypeMessage.DynamicType0SucessfullySavedGoToDynamicPanelNow
                                .niceToString(pack.entity.typeName),
                            buttons: "yes_no",
                            style: "success",
                            icon: "success",
                        });

                        if (answer === "yes")
                            AppContext.navigate("/dynamic/panel?step=compile");
                    };
                    return eoc.defaultClick();
                },
            });

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
                    token(a => a.isDisabled),
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
                    token(a => a.isDisabled),
                ],
            }));

        registerDynamicPanelSearch(DynamicTypeEntity.typeName, [
            { token: "typeName", type: "Text" },
            { token: "dataCode", type: "Code" },
            { token: "serverCode", type: "Code" },
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

        // The panel, on Signum's own /dynamic/panel path.
        cb.routes.push({
            path: "/dynamic/panel",
            element: <ImportComponent onImport={() => import("./DynamicPanelPage")} />,
        });

        registerSpecialAction({
            key: "DynamicPanel",
            allowed: () => AuthClient.isPermissionAuthorized(EvalPanelPermission.ViewDynamicPanel),
            onClick: () => Promise.resolve("/dynamic/panel"),
        });
    }

    // ---- the panel search registry (see the header) -----------------------------------------------------

    export type DynamicPanelSearchType = "Text" | "Code";

    export interface DynamicPanelSearchColumn {
        token: string;
        type: DynamicPanelSearchType;
    }

    export const registeredPanelSearches: { [typeName: string]: DynamicPanelSearchColumn[] } = {};

    export function registerDynamicPanelSearch(typeName: string, columns: DynamicPanelSearchColumn[]): void {
        registeredPanelSearches[typeName] = columns;
    }

    // ---- the CSS overrides (see the header) -------------------------------------------------------------

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

        /** What this process loaded, whether that failed, and what a restart would change. */
        export function compilationStatus(): Promise<DynamicCompilationStatus> {
            return ajaxGet({ url: "/api/dynamic/compilationStatus" });
        }

        /** Compile the definitions as they are now, without loading them. */
        export function compile(): Promise<DynamicCompileResult> {
            return ajaxPost({ url: "/api/dynamic/compile" }, undefined);
        }

        export function restartServer(): Promise<void> {
            return ajaxPost({ url: "/api/dynamic/restartServer", avoidDeserialize: true }, undefined);
        }
    }
}
