import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ajaxGet, ajaxPost, ajaxGetRaw, saveFile } from "@altea/altea/client/Services";
import * as AppContext from "@altea/altea/client/AppContext";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { tasks, type LineBaseController, type LineBaseProps } from "@altea/altea/client/Lines/LineBase";
import { TextBoxLineController } from "@altea/altea/client/Lines/TextBoxLine";
import { TextAreaLineController } from "@altea/altea/client/Lines/TextAreaLine";
import { PropertyRouteType } from "@altea/altea/data/propertyRoute";
import type { Binding } from "@altea/altea/client/binding";
import type { TranslatableRouteType } from "@altea/altea/data/reflection";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { classes } from "@altea/altea/data/globals";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { getTypeName } from "@altea/altea/client/Reflection";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { registerSpecialAction } from "@altea/altea-omnibox/client/OmniboxSpecialAction";
import {
    TranslationPermission, TranslationMessage, TranslatedSummaryState, MatchTranslatedInstances,
} from "../data/Translation";

// Port of Signum.Translation's TranslatedInstanceClient.tsx — the INSTANCE half's client registration:
// the three pages, the calls behind them, and the little "language" button every @translatable Line grows.
//
// altea divergences:
//  - `MemberInfo.translatable` is already on the compile-time `FieldInfo` (core's @translatable decorator
//    stamps it on both tiers), so there is no `declare module` widening and no metadata plumbing — Signum
//    has to ship the flag through `ReflectionServer.PropertyRouteExtension`.
//  - **no rowId** anywhere (see the server's TranslatedInstanceLogic): a cell is addressed by its plain
//    route, and Signum's `"route;rowId"` splitting is gone.
//  - `isPermissionAuthorized` lives in altea-auth, and is read inside the task so it follows
//    `onCurrentUserChanged`.
export namespace TranslatedInstanceClient {

    export function start(cb: ClientBuilder): void {

        registerSpecialAction({
            key: "TranslateInstances",
            allowed: () => AuthClient.isPermissionAuthorized(TranslationPermission.TranslateInstances),
            onClick: () => Promise.resolve("/translatedInstance/status"),
        });

        cb.routes.push(
            { path: "/translatedInstance/status", element: <ImportComponent onImport={() => import("./Instances/TranslatedInstanceStatus")} /> },
            { path: "/translatedInstance/view/:type/:culture?", element: <ImportComponent onImport={() => import("./Instances/TranslatedInstanceView")} /> },
            { path: "/translatedInstance/sync/:type/:culture", element: <ImportComponent onImport={() => import("./Instances/TranslatedInstanceSync")} /> },
        );
    }

    /**
     * Signum's `taskSetTranslatableIcon` — a LINE TASK (it runs for every Line the app renders): a text
     * line bound to a `@translatable` route grows a button that opens the translation page for that
     * instance, and shows the current culture's translation as its help text.
     *
     * The translation itself rides on the entity as `<field>_translated`, which the server's serializer
     * attaches for exactly these routes (core's setTranslatedFieldProvider) — no extra call.
     */
    export function taskSetTranslatableIcon(lineBase: LineBaseController<LineBaseProps, unknown>, state: LineBaseProps): void {
        if (!(lineBase instanceof TextBoxLineController) && !(lineBase instanceof TextAreaLineController))
            return;

        const route = state.ctx.propertyRoute;
        if (route == undefined
            || route.propertyRouteType !== PropertyRouteType.FieldOrProperty
            || route.fieldInfo?.translatable == undefined
            || route.fieldInfo.translatable === false
            || !AuthClient.isPermissionAuthorized(TranslationPermission.TranslateInstances))
            return;

        const props = state as LineBaseProps & {
            extraButtons?: (c: LineBaseController<LineBaseProps, unknown>) => React.ReactNode;
            helpText?: React.ReactNode;
        };

        props.extraButtons ??= () => <TranslateButton ctx={state.ctx} />;

        if (props.helpText == undefined) {
            // The value the serializer attached beside the field. Only a plain `Binding` (the ordinary
            // field case) has an owner object to read it off — a ReadonlyBinding or a hand-built one does
            // not, and simply gets no help text.
            const binding = state.ctx.binding as Partial<Binding<unknown>>;
            const value = binding.parentObject == undefined ? undefined
                : (binding.parentObject as Record<string, unknown>)[String(binding.member) + "_translated"];
            if (value != undefined)
                props.helpText = <><strong>{CultureInfo.currentUICulture()}:</strong> {String(value)}</>;
        }
    }

    tasks.push(taskSetTranslatableIcon);

    /** The button the task installs — opens the instance-translation page filtered to this very row. */
    export function TranslateButton(p: { ctx: LineBaseProps["ctx"] }): React.JSX.Element {
        const root = p.ctx.tryFindRootEntity();

        return (
            <LinkButton className={classes("sf-line-button sf-view", "btn input-group-text", "sf-translate-button")}
                title={TranslationMessage.ThisFieldIsTranslatable.niceToString()}
                onClick={() => {
                    const entity = root?.value as Entity | undefined;
                    const url = entity == undefined ? "/translatedInstance/status/"
                        : entity.id == undefined ? `/translatedInstance/view/${getTypeName(entity)}/`
                            : `/translatedInstance/view/${getTypeName(entity)}/?filter=${entity.toLite().key()}`;
                    window.open(AppContext.toAbsoluteUrl(url));
                }}>
                <FontAwesomeIcon aria-hidden={true} icon="language" />
            </LinkButton>
        );
    }

    export namespace API {
        export function status(applyFilter?: boolean): Promise<TranslatedTypeSummary[]> {
            return ajaxGet({ url: `/api/translatedInstance?${q({ applyFilter })}` });
        }

        export function downloadView(type: string, culture: string | undefined, applyFilter?: boolean): void {
            void ajaxGetRaw({ url: `/api/translatedInstance/viewFile/${type}?${q({ culture, applyFilter })}` })
                .then(response => saveFile(response));
        }

        export function downloadSync(type: string, culture: string | undefined, applyFilter?: boolean): void {
            void ajaxGetRaw({ url: `/api/translatedInstance/syncFile/${type}?${q({ culture, applyFilter })}` })
                .then(response => saveFile(response));
        }

        export interface FileUpload {
            fileName: string;
            content: string;
        }

        export function uploadFile(request: FileUpload, mode: MatchTranslatedInstances): Promise<void> {
            return ajaxPost({ url: `/api/translatedInstance/uploadFile?${q({ mode: MatchTranslatedInstances[mode] })}` }, request);
        }

        export function viewTranslatedInstanceData(type: string, culture: string | undefined, filter: string | undefined, applyFilter?: boolean): Promise<TranslatedInstanceViewType> {
            return ajaxGet({ url: `/api/translatedInstance/view/${type}?${q({ culture, filter, applyFilter })}` });
        }

        export function syncTranslatedInstance(type: string, culture: string, applyFilter?: boolean): Promise<TypeInstancesChanges> {
            return ajaxGet({ url: `/api/translatedInstance/sync/${type}?${q({ culture, applyFilter })}` });
        }

        export function autoTranslate(type: string, culture: string): Promise<void> {
            return ajaxGet({ url: `/api/translatedInstance/autoTranslate/${type}?${q({ culture })}` });
        }

        export function autoTranslateAll(culture: string): Promise<void> {
            return ajaxGet({ url: `/api/translatedInstance/autoTranslateAll?${q({ culture })}` });
        }

        export function saveTranslatedInstanceData(records: TranslationRecord[], type: string, isSync: boolean, culture?: string): Promise<void> {
            return ajaxPost({ url: `/api/translatedInstance/save/${type}?${q({ isSync, culture })}` }, records);
        }
    }

    function q(params: Record<string, string | boolean | undefined>): string {
        return Object.entries(params)
            .filter(([, v]) => v != undefined)
            .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
            .join("&");
    }

    // ---- The DTOs (mirroring server/TranslatedInstanceServer) -----------------------------------------

    export interface TranslationRecord {
        culture: string;
        propertyRoute: string;
        lite: Lite<Entity>;
        originalText: string;
        translatedText: string;
    }

    export interface TranslatedTypeSummary {
        type: string;
        culture: string;
        isDefaultCulture: boolean;
        state: TranslatedSummaryState | null;
    }

    export interface TypeInstancesChanges {
        typeName: string;
        masterCulture: string;
        routes: Record<string, TranslatableRouteType>;
        totalInstances: number;
        instances: InstanceChange[];
        deletedTranslations: number;
    }

    export interface InstanceChange {
        instance: Lite<Entity>;
        routeConflicts: Record<string, PropertyChange>;
    }

    export interface PropertyChange {
        translatedText?: string;
        support: Record<string, PropertyRouteConflict>;
    }

    export interface PropertyRouteConflict {
        oldOriginal?: string;
        oldTranslation?: string;
        original: string;
        automaticTranslations: { translatorName: string; text: string }[];
    }

    export interface TranslatedInstanceViewType {
        typeName: string;
        masterCulture: string;
        routes: Record<string, TranslatableRouteType>;
        instances: TranslatedInstanceView[];
    }

    export interface TranslatedInstanceView {
        lite: Lite<Entity>;
        master: Record<string, string | null>;
        translations: Record<string, Record<string, TranslatedPairView>>;
    }

    export interface TranslatedPairView {
        translatedText: string;
        newText: string | null;
        originalText: string;
    }
}
