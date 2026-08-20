import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxPost, ajaxPostRaw, saveFile } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Constructor } from "@altea/altea/client/Constructor";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import { ButtonBarManager } from "@altea/altea/client/Frames/ButtonBar";
import type { ButtonsContext, ButtonBarElement } from "@altea/altea/client/TypeContext";
import { onContextualItems, type ContextualItemsContext, type MenuItemBlock } from "@altea/altea/client/SearchControl/ContextualItems";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import type { EntityPack } from "@altea/altea/data/entityPack";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { Lite } from "@altea/altea/data/lite";
import { getKey as queryKeyOf } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import { TemplatingClient } from "@altea/altea-templating/client/TemplatingClient";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import {
    OfficeConverterSymbol, OfficeModelEntity, OfficeTemplateEntity, OfficeTemplateOperation,
    OfficeTemplateVisibleOn, OfficeTransformerSymbol,
} from "../data/OfficeTemplate";
import OfficeEntityMenu from "./OfficeEntityMenu";
import OfficeSearchMenu from "./OfficeSearchMenu";

// Port of Signum.Word's WordClient.tsx — the module's client registration: the template editor, the two
// built-in model settings, the "create report" operation, the contextual menu, and the typed HTTP client.
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(...)`, and the
//    server's `.WithQuery(() => …)` projections become `withQuerySettings({ defaultColumns })` (altea
//    resolves query columns client-side).
//  - Signum read a query's / an entity pack's applicable templates off extensions the server pushed into
//    the QueryDescription and EntityPack DTOs (`queryDescription.wordTemplates` / `pack.wordTemplates`).
//    altea has neither DTO, so both menus ASK for them — see OfficeSearchMenu / OfficeEntityMenu.
//  - `EvalClient` / `ChangeLogClient` have no altea counterpart on this path.
//  - `WordTemplateVisibleOn` stays a plain numeric flag enum (see its declaration for why); the wire value
//    the routes take is its NAME, which is what the two call sites below pass.

export namespace OfficeClient {

    export function start(cb: ClientBuilder, options: {
        contextual: boolean;
        queryButton: boolean;
        entityButton: boolean;
    }): void {

        TemplatingClient.start(cb);

        cb.configure(OfficeTemplateEntity)
            .withView(() => import("./Templates/OfficeTemplate"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(t => t.id),
                    token(t => t.name),
                    token(t => t.query),
                    token(t => t.model),
                    token(t => t.culture),
                    token(t => t.fileName),
                ],
            }));

        cb.configure(OfficeModelEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(m => m.id),
                    token(m => m.fullClassName),
                ],
            }));

        cb.configure(OfficeTransformerSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(s => s.id),
                    token(s => s.key),
                ],
            }));

        cb.configure(OfficeConverterSymbol)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(s => s.id),
                    token(s => s.key),
                ],
            }));

        // The two built-in models Signum registers: "one report for a SET of entities" and "one report for
        // the RESULT of a query".
        register(QueryModel, {
            createFromTemplate: async ot =>
                ot.query == null ? undefined : await Navigator.view(QueryModel.create({ queryKey: ot.query.key })),
            createFromEntities: async (ot, lites) => {
                const template = await Navigator.API.fetch(ot);
                if (template.query == null)
                    return undefined;
                return QueryModel.create({
                    queryKey: template.query.key,
                    filters: [{ token: "Entity", operation: "IsIn", value: lites }],
                    orders: [],
                    pagination: { mode: "All" },
                });
            },
            createFromQuery: async (_ot, req) => QueryModel.create({
                queryKey: req.queryKey,
                filters: req.filters,
                orders: req.orders,
                pagination: req.pagination,
            }),
        });

        register(MultiEntityModel, {
            createFromTemplate: async ot => {
                if (ot.query == null)
                    return undefined;
                const lites = await Finder.findMany({ queryName: ot.query.key });
                return lites == null ? undefined : MultiEntityModel.create({ entities: lites });
            },
            createFromEntities: async (_ot, lites) =>
                await Navigator.view(MultiEntityModel.create({ entities: lites })),
        });

        /**
         * "Create a report from this template". What has to be gathered first depends on the template's
         * MODEL: no model (or an entity-shaped one) needs a row picked in a finder; a model with its own
         * editor needs that editor opened. Signum's onClick, with the same three branches.
         *
         * The operation itself is UI-only server-side (it throws): the bytes come back from the route, so
         * the click ends in a file download rather than a re-render.
         */
        Operations.addSettings(new EntityOperationSettings(OfficeTemplateOperation.CreateOfficeReport, {
            onClick: async ctx => {
                const entity = ctx.entity as OfficeTemplateEntity;
                const template = entity.toLite();
                const constructorType = entity.model != null
                    ? await API.getConstructorType(entity.model)
                    : undefined;

                if (constructorType == undefined || tryGetTypeInfo(constructorType) != null) {
                    if (entity.query == null)
                        throw new Error(`The template '${entity.name}' has neither a query nor a model`);

                    const lite = await Finder.find({ queryName: entity.query.key });
                    if (lite == null)
                        return;

                    return await createAndDownloadReport({ template, lite });
                }

                const setting = settings[constructorType];
                const model = setting?.createFromTemplate != undefined
                    ? await setting.createFromTemplate(entity)
                    : await Constructor.construct(constructorType).then(e => e && Navigator.view(e));

                if (model != null)
                    await createAndDownloadReport({ template, entity: model });
            },
        }));

        if (options.contextual)
            onContextualItems.push(getOfficeTemplates);

        if (options.queryButton)
            Finder.ButtonBarQuery.onButtonBarElements.push(ctx =>
                ({ button: <OfficeSearchMenu searchControl={ctx.searchControl} /> }));

        if (options.entityButton)
            ButtonBarManager.onButtonBarRender.push(getEntityOfficeButtons);

        UserAssetClient.registerExportAssertLink(OfficeTemplateEntity);
    }

    /** Signum's getEntityWordButtons. */
    export function getEntityOfficeButtons(ctx: ButtonsContext): (ButtonBarElement | undefined)[] | undefined {
        if (tryGetTypeInfo(OfficeTemplateEntity) == null)
            return undefined;

        return [{ button: <OfficeEntityMenu entityPack={ctx.pack as EntityPack<Entity>} />, order: 1000 }];
    }

    /** Signum's WordModelSettings — how the client BUILDS a model before rendering a report from it. */
    export interface OfficeModelSettings<T extends BaseEntity> {
        createFromTemplate?: (ot: OfficeTemplateEntity) => Promise<BaseEntity | undefined>;
        createFromEntities?: (ot: Lite<OfficeTemplateEntity>, lites: Lite<Entity>[]) => Promise<BaseEntity | undefined>;
        createFromQuery?: (ot: Lite<OfficeTemplateEntity>, req: QueryRequest) => Promise<BaseEntity | undefined>;
    }

    export const settings: { [typeName: string]: OfficeModelSettings<BaseEntity> } = {};

    export function register<T extends BaseEntity>(type: Type<T>, setting: OfficeModelSettings<T>): void {
        settings[(type as unknown as { typeName: string }).typeName] = setting as OfficeModelSettings<BaseEntity>;
    }

    /** Signum's getWordTemplates contextual item — "render one of these templates for the selected rows". */
    export function getOfficeTemplates(ctx: ContextualItemsContext<Entity>): Promise<MenuItemBlock | undefined> | undefined {
        if (ctx.lites.length === 0)
            return undefined;

        if (tryGetTypeInfo(OfficeTemplateEntity) == null)
            return undefined;

        return API.getOfficeTemplates(
            queryKeyOf(ctx.queryToken.queryName),
            ctx.lites.length > 1 ? "Multiple" : "Single",
            { lite: ctx.lites.length === 1 ? ctx.lites[0] : null },
        ).then(templates => {
            if (templates.length === 0)
                return undefined;

            return {
                header: OfficeTemplateEntity.nicePluralName(),
                menuItems: templates.map(ot => (
                    <Dropdown.Item key={ot.key()} onClick={() => void handleMenuClick(ot, ctx)}>
                        <FontAwesomeIcon aria-hidden={true} icon="file-word" className="icon" />
                        {ot.toString()}
                    </Dropdown.Item>
                )),
            } satisfies MenuItemBlock;
        });
    }

    export async function handleMenuClick(ot: Lite<OfficeTemplateEntity>, ctx: ContextualItemsContext<Entity>): Promise<void> {
        const template = await Navigator.API.fetch(ot);
        const constructorType = template.model != null
            ? await API.getConstructorType(template.model)
            : undefined;

        // No model, or one built from exactly the selected row's type: render against that row.
        if (constructorType == undefined
            || (ctx.lites.length === 1 && queryKeyOf(ctx.lites[0].entityType) === constructorType))
            return await createAndDownloadReport({ template: ot, lite: ctx.lites[0] });

        const setting = settings[constructorType];
        if (setting == undefined)
            throw new Error(`No 'OfficeModelSettings' defined for '${constructorType}'`);
        if (setting.createFromEntities == undefined)
            throw new Error(`No 'createFromEntities' defined in the OfficeModelSettings of '${constructorType}'`);

        const model = await setting.createFromEntities(ot, ctx.lites);
        if (model != null)
            await createAndDownloadReport({ template: ot, entity: model });
    }

    /**
     * Render a report and hand the produced file to the browser.
     *
     * Signum's callers each do `API.createAndDownloadReport(...).then(r => r && saveFile(r))`; folding the
     * `saveFile` in here means no call site can forget it and leave the user staring at nothing.
     */
    export async function createAndDownloadReport(request: API.CreateOfficeReportRequest): Promise<void> {
        const response = await API.createAndDownloadReport(request);
        await saveFile(response);
    }

    export namespace API {

        export interface CreateOfficeReportRequest {
            template: Lite<OfficeTemplateEntity>;
            lite?: Lite<Entity> | null;
            entity?: BaseEntity | null;
        }

        export interface GetOfficeTemplatesRequest {
            lite: Lite<Entity> | null;
        }

        /** The RAW response — the caller streams it to a file (see OfficeClient.createAndDownloadReport). */
        export function createAndDownloadReport(request: CreateOfficeReportRequest): Promise<Response> {
            return ajaxPostRaw({ url: "/api/office/createReport" }, request);
        }

        export function getConstructorType(officeModel: OfficeModelEntity): Promise<string> {
            return ajaxPost({ url: "/api/office/constructorType" }, officeModel);
        }

        export function getOfficeTemplates(
            queryKey: string, visibleOn: keyof typeof OfficeTemplateVisibleOn, request: GetOfficeTemplatesRequest,
        ): Promise<Lite<OfficeTemplateEntity>[]> {
            return ajaxPost(
                { url: `/api/office/officeTemplates?queryKey=${encodeURIComponent(queryKey)}&visibleOn=${visibleOn}` },
                request);
        }
    }
}
