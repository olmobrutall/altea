import * as React from "react";
import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { ViewPromise, type ViewOverride } from "@altea/altea/client/EntitySettings";
import type { ViewReplacer } from "@altea/altea/client/Frames/ReactVisitor";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { Entity, type BaseEntity } from "@altea/altea/data/entity";
import { resolveType } from "@altea/altea/data/registration";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { Dic } from "@altea/altea/data/globals";
import SelectorModal from "@altea/altea/client/SelectorModal";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import type { FileTypeSymbol } from "@altea/altea-files/data/Files";
import { globalModules } from "./View/GlobalModules";
import type * as NodeUtils from "./View/NodeUtils";
import type * as Nodes from "./View/Nodes";
import {
    DynamicViewEntity, DynamicViewMessage, DynamicViewOperation,
    DynamicViewOverrideEntity, DynamicViewOverrideOperation,
    DynamicViewSelectorEntity, DynamicViewSelectorOperation,
} from "../data/DynamicView";

// Port of Signum.Dynamic's DynamicViewClient.tsx — where the module PLUGS IN: it installs a ViewDispatcher
// that, for any entity type, prefers a view stored in the database over the compiled one.
//
// The dispatcher is the whole integration, and it is why this port needed a core change: altea's Navigator
// resolved views inline (with a `// TODO: real ViewDispatcher` where the seam belonged). It now has
// `Navigator.setViewDispatcher`, so this module replaces the resolution strategy without patching anything.
//
// altea divergences, documented inline:
//  - `EvalClient.Options.registerDynamicPanelSearch` / `onGetDynamicLineForType` belong to the unported
//    Signum.Eval; the panel's search registry is re-homed on `DynamicClient` (see DynamicClient.tsx).
//  - `patchComponent` / `unPatchComponent` are NOT ported. They monkey-patch a CLASS component's `render`,
//    and altea's views are function components — its ViewReplacer rewrites the returned element tree instead,
//    which is what `applyViewOverrides` already does for both static and dynamic overrides.
//  - `isTypeEntity(typeName)` → `resolveType(typeName)` + an `Entity` check.
//  - `registeredFileTypes` is new: Signum can enumerate FileType symbols from its client TypeInfo blob
//    ("SymbolContainer" kind), altea cannot — a symbol is declared, not reflected — so the app registers the
//    ones its FileLine nodes may choose from.
export namespace DynamicViewClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(DynamicViewEntity).withView(() => import("./View/DynamicView")).withQuerySettings(token => ({
            defaultColumns: [
                token(a => a.id),
                token(a => a.viewName),
                token(a => a.entityType),
            ],
        }));

        cb.configure(DynamicViewSelectorEntity).withView(() => import("./View/DynamicViewSelector")).withQuerySettings(token => ({
            defaultColumns: [
                token(a => a.id),
                token(a => a.entityType),
            ],
        }));

        cb.configure(DynamicViewOverrideEntity).withView(() => import("./View/DynamicViewOverride")).withQuerySettings(token => ({
            defaultColumns: [
                token(a => a.id),
                token(a => a.entityType),
                token(a => a.viewName),
            ],
        }));

        // Any write to a view / selector / override invalidates what the dispatcher has cached, so the next
        // navigation reflects the edit without a reload (Signum wires the same four operations).
        Operations.addSettings(
            ...[
                DynamicViewOperation.Save, DynamicViewOperation.Delete,
                DynamicViewSelectorOperation.Save, DynamicViewSelectorOperation.Delete,
                DynamicViewOverrideOperation.Save, DynamicViewOverrideOperation.Delete,
            ].map(op => new EntityOperationSettings(op as never, {
                commonOnClick: oc => { cleanCaches(); return oc.defaultClick(); },
            })));

        Navigator.setViewDispatcher(new DynamicViewViewDispatcher());
    }

    // ---- registries the app fills ------------------------------------------------------------------------

    export const registeredCustomContexts: { [name: string]: CustomContextSettings } = {};

    export interface CustomContextSettings {
        getTypeContext: (ctx: TypeContext<unknown>) => TypeContext<unknown> | undefined;
        getCodeContext: (ctx: NodeUtils.CodeContext) => NodeUtils.CodeContext;
        getPropertyRoute: (dn: NodeUtils.DesignerNode<Nodes.CustomContextNode>) => PropertyRoute | undefined;
    }

    /** The FileType symbols a FileLine / MultiFileLine / FileImageLine node may be pointed at (see header). */
    export const registeredFileTypes: { [key: string]: FileTypeSymbol } = {};

    export function registerFileTypes(...fileTypes: FileTypeSymbol[]): void {
        for (const ft of fileTypes)
            registeredFileTypes[ft.key] = ft;
    }

    // ---- the dispatcher ---------------------------------------------------------------------------------

    export class DynamicViewViewDispatcher implements Navigator.ViewDispatcher {

        hasDefaultView(_typeName: string): boolean {
            return true;
        }

        getViewNames(typeName: string): Promise<string[]> {
            const es = Navigator.getSettings(typeName);
            const staticViewNames = es?.namedViews ? Dic.getKeys(es.namedViews) : [];

            if (!isEntityTypeName(typeName))
                return Promise.resolve(staticViewNames);

            return getDynamicViewNames(typeName).then(dynamicViewNames => [
                ...staticViewNames,
                ...dynamicViewNames,
            ]);
        }

        getViewOverrides(typeName: string, viewName?: string): Promise<ViewOverride<BaseEntity>[]> {
            const es = Navigator.getSettings(typeName);
            const staticViewOverrides = (es?.viewOverrides ?? []).filter(a => a.viewName == viewName) as ViewOverride<BaseEntity>[];

            if (!isEntityTypeName(typeName))
                return Promise.resolve(staticViewOverrides);

            return getDynamicViewOverrides(typeName).then(dvos => [
                ...staticViewOverrides,
                ...dvos
                    .filter(dvo => (dvo.entity.viewName ?? undefined) == viewName)
                    .map(dvo => ({ override: dvo.override, viewName: dvo.entity.viewName ?? undefined }) as ViewOverride<BaseEntity>),
            ]);
        }

        getViewPromise<T extends BaseEntity>(entity: T, viewName?: string): ViewPromise<T> {

            const typeName = typeNameOf(entity);

            if (viewName === "STATIC")
                return this.static(entity);

            if (viewName === "NEW")
                return ViewPromise.flat(createDefaultDynamicView(typeName).then(dv => dynamicViewComponent<T>(dv)));

            if (!isEntityTypeName(typeName) || viewName != undefined)
                return this.fallback(entity, viewName);

            return ViewPromise.flat(getSelector(typeName).then(sel => {

                if (!sel)
                    return this.fallback(entity);

                try {
                    const selected = sel(entity as unknown as Entity);

                    if (selected === "STATIC")
                        return this.static(entity);

                    if (selected === "NEW")
                        return ViewPromise.flat(createDefaultDynamicView(typeName).then(dv => dynamicViewComponent<T>(dv)));

                    if (selected === "CHOOSE")
                        return this.chooseViewName(entity, true);

                    return this.getViewPromiseWithName(entity, selected);
                } catch (error) {
                    return MessageModal.showError("There was an error executing the DynamicViewSelector. Fallback to default")
                        .then(() => this.fallback(entity));
                }
            }));
        }

        getViewPromiseWithName<T extends BaseEntity>(entity: T, viewName: string): ViewPromise<T> {
            const typeName = typeNameOf(entity);
            const es = Navigator.getSettings(typeName);
            const namedView = es?.namedViews && es.namedViews[viewName];

            if (namedView?.getViewPromise)
                return namedView.getViewPromise(entity as never).applyViewOverrides(typeName, viewName) as ViewPromise<T>;

            return ViewPromise.flat(API.getDynamicView(typeName, viewName).then(dve => dynamicViewComponent<T>(dve)));
        }

        fallback<T extends BaseEntity>(entity: T, viewName?: string): ViewPromise<T> {

            if (viewName)
                return this.getViewPromiseWithName(entity, viewName);

            const typeName = typeNameOf(entity);
            const settings = Navigator.getSettings(typeName);

            if (settings?.getViewPromise != null)
                return settings.getViewPromise(entity as never).applyViewOverrides(typeName) as ViewPromise<T>;

            // No compiled view. THE divergence from Signum, and the reason it matters: in Signum a type with
            // no registered view cannot be shown at all, so its dispatcher offers to create a dynamic one
            // (`chooseViewName`). altea AUTO-GENERATES a view from the property routes, and plenty of types
            // rely on that — so falling through to "design a dynamic view" would change how every one of
            // them renders the moment this module is installed. Only ASK when there is something to choose.
            if (!isEntityTypeName(typeName))
                return new ViewPromise<T>(import("@altea/altea/client/AutoComponent")).applyViewOverrides(typeName);

            return ViewPromise.flat(getDynamicViewNames(typeName).then(names =>
                names.length === 0
                    ? new ViewPromise<T>(import("@altea/altea/client/AutoComponent")).applyViewOverrides(typeName)
                    : this.chooseViewName(entity, true)));
        }

        static<T extends BaseEntity>(entity: T): ViewPromise<T> {
            const typeName = typeNameOf(entity);
            const es = Navigator.getSettings(typeName);

            // altea always HAS a view (AutoComponent), so "STATIC" with nothing registered is the
            // auto-generated one rather than Signum's error.
            if (es?.getViewPromise == null)
                return new ViewPromise<T>(import("@altea/altea/client/AutoComponent")).applyViewOverrides(typeName);

            return es.getViewPromise(entity as never).applyViewOverrides(typeName) as ViewPromise<T>;
        }

        chooseViewName<T extends BaseEntity>(entity: T, avoidMessage = false): ViewPromise<T> {
            const typeName = typeNameOf(entity);

            return ViewPromise.flat(this.getViewNames(typeName)
                .then(names => SelectorModal.chooseElement(names, {
                    title: DynamicViewMessage.ChooseAView.niceToString(),
                    message: avoidMessage ? undefined
                        : DynamicViewMessage.SinceThereIsNoDynamicViewSelectorYouNeedToChooseAViewManually.niceToString(),
                }))
                .then(viewName => {
                    if (!viewName)
                        return createDefaultDynamicView(typeName).then(dv => dynamicViewComponent<T>(dv));

                    return this.getViewPromiseWithName(entity, viewName);
                }));
        }

        getOrCreateDynamicView(typeName: string, viewName: string | undefined): Promise<DynamicViewEntity> {
            if (viewName == undefined)
                return createDefaultDynamicView(typeName);

            return API.getDynamicView(typeName, viewName);
        }
    }

    // ---- caches -----------------------------------------------------------------------------------------

    function getOrCreate<V>(cache: { [key: string]: V }, key: string, onCreate: (key: string) => Promise<V>): Promise<V> {
        if (Object.prototype.hasOwnProperty.call(cache, key))
            return Promise.resolve(cache[key]!);

        return onCreate(key).then(v => cache[key] = v);
    }

    export function cleanCaches(): void {
        Dic.clear(viewNamesCache);
        Dic.clear(selectorCache);
        Dic.clear(overrideCache);
    }

    const viewNamesCache: { [typeName: string]: string[] } = {};

    export function getDynamicViewNames(typeName: string): Promise<string[]> {
        return getOrCreate(viewNamesCache, typeName, () => API.getDynamicViewNames(typeName));
    }

    const selectorCache: { [typeName: string]: ((e: Entity) => string) | undefined } = {};

    export function getSelector(typeName: string): Promise<((e: Entity) => string) | undefined> {
        return getOrCreate(selectorCache, typeName, () =>
            API.getDynamicViewSelector(typeName).then(dvs => dvs ? asSelectorFunction(dvs) : undefined));
    }

    interface DynamicViewOverridePair {
        override: (vr: ViewReplacer<BaseEntity>) => void;
        entity: DynamicViewOverrideEntity;
    }

    const overrideCache: { [typeName: string]: DynamicViewOverridePair[] } = {};

    export function getDynamicViewOverrides(typeName: string): Promise<DynamicViewOverridePair[]> {
        return getOrCreate(overrideCache, typeName, () =>
            API.getDynamicViewOverride(typeName)
                .then(dvos => dvos.map(dvo => ({ entity: dvo, override: asOverrideFunction(dvo) }))));
    }

    // ---- the two interpreted snippets -------------------------------------------------------------------

    /**
     * A selector is `e => <body>`. The `eval` is direct so the snippet sees `modules` from this scope — the
     * same arrangement NodeUtils.evalWithScope documents.
     */
    export function asSelectorFunction(dvs: DynamicViewSelectorEntity): (e: Entity) => string {

        const code = "e => " + dvs.script;
        const modules = globalModules;
        void modules;

        try {
            // eslint-disable-next-line no-eval
            return eval(code) as (e: Entity) => string;
        } catch (e) {
            throw new Error(`Syntax in DynamicViewSelector for '${String(dvs.entityType)}':\n${code}\n${(e as Error).message}`);
        }
    }

    /**
     * An override is `vr => <body>` over a ViewReplacer. Signum brings ~25 Lines / Search / bootstrap names
     * into scope as bare identifiers for the snippet's benefit; altea exposes the SAME set through `modules`
     * (see GlobalModules) rather than re-declaring each one here — one place to keep in sync instead of two.
     */
    export function asOverrideFunction(dvo: DynamicViewOverrideEntity): (vr: ViewReplacer<BaseEntity>) => void {

        const code = "(function(vr){ " + dvo.script + "})";
        const modules = globalModules;
        void modules;

        try {
            // eslint-disable-next-line no-eval
            return eval(code) as (vr: ViewReplacer<BaseEntity>) => void;
        } catch (e) {
            throw new Error(`Syntax in DynamicViewOverride for '${String(dvo.entityType)}':\n${code}\n${(e as Error).message}`);
        }
    }

    // ---- building a view ---------------------------------------------------------------------------------

    export function createDefaultDynamicView(typeName: string): Promise<DynamicViewEntity> {
        return loadNodes().then(nodes => {
            const ti = typeInfoOf(typeName);
            if (ti == undefined)
                throw new Error(`Type '${typeName}' is not registered on the client`);

            return DynamicViewEntity.create({
                entityType: undefined as never, // filled by the editor: the TypeEntity is a server row
                viewName: "My View",
                locals: "{\n"
                    + "  const forceUpdate = modules.Hooks.useForceUpdate();\n"
                    + "  return { forceUpdate };\n"
                    + "}",
                viewContent: JSON.stringify(nodes.NodeConstructor.createDefaultNode(ti)),
            });
        });
    }

    export function loadNodes(): Promise<typeof Nodes> {
        return import("./View/Nodes");
    }

    export function dynamicViewComponent<T extends BaseEntity>(dynamicView: DynamicViewEntity): ViewPromise<T> {
        return new ViewPromise<T>(import("./View/DynamicViewComponent"))
            .withProps({ initialDynamicView: dynamicView });
    }

    // ---- helpers ---------------------------------------------------------------------------------------

    function typeNameOf(entity: BaseEntity): string {
        return (entity.constructor as unknown as { typeName: string }).typeName;
    }

    function typeInfoOf(typeName: string) {
        const ctor = resolveType(typeName);
        return ctor == undefined ? undefined : tryGetTypeInfo(ctor as never);
    }

    /** Signum's `isTypeEntity(typeName)`: is this a persistent ENTITY type (not an embedded / model)? */
    function isEntityTypeName(typeName: string): boolean {
        const ctor = resolveType(typeName);
        return ctor != undefined && (ctor === Entity || ctor.prototype instanceof Entity);
    }

    // ---- API -------------------------------------------------------------------------------------------

    export namespace API {

        export function getDynamicView(typeName: string, viewName: string): Promise<DynamicViewEntity> {
            return ajaxGet({ url: `/api/dynamic/view/${typeName}?viewName=${encodeURIComponent(viewName)}` });
        }

        export function getDynamicViewProps(typeName: string, viewName: string): Promise<DynamicViewProps[]> {
            return ajaxGet({ url: `/api/dynamic/viewProps/${typeName}?viewName=${encodeURIComponent(viewName)}` });
        }

        export function getDynamicViewSelector(typeName: string): Promise<DynamicViewSelectorEntity | undefined> {
            return ajaxGet({ url: `/api/dynamic/selector/${typeName}` });
        }

        export function getDynamicViewOverride(typeName: string): Promise<DynamicViewOverrideEntity[]> {
            return ajaxGet({ url: `/api/dynamic/override/${typeName}` });
        }

        export function getDynamicViewNames(typeName: string): Promise<string[]> {
            return ajaxGet({ url: `/api/dynamic/viewNames/${typeName}` });
        }

        export function getSuggestedFindOptions(typeName: string): Promise<SuggestedFindOptions[]> {
            return ajaxGet({ url: `/api/dynamic/suggestedFindOptions/${typeName}` });
        }
    }

    export interface SuggestedFindOptions {
        queryKey: string;
        parentToken: string;
    }

    export interface DynamicViewProps {
        name: string;
        type: string;
    }
}
