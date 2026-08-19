// Signum's WordTemplateParameters (declared inside WordTemplateLogic.cs) and the IWordModel contract.
// Kept in its own module because the nodes, the parser and the renderer all need it and altea has no
// partial classes.

import type { Entity } from "@altea/altea/data/entity";
import { TemplateParameters, type QueryContext } from "@altea/altea-templating/server/ValueProviders.server";
import type { Order, Pagination, Filter } from "@altea/altea/server/dynamicQuery/requests";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import type { OfficeTemplateEntity } from "../data/OfficeTemplate";
import type { OxmlPackage } from "./oxml/OxmlPackage.server";
import type { TokenNode } from "./OfficeTemplateNodes.server";

/**
 * Signum's IWordModel — a code-declared object that supplies a template's data instead of (or alongside)
 * a query row, and shapes the query the renderer runs.
 *
 * Signum's `WordModel<T>` is an abstract class whose virtual members supply the defaults; TS has no
 * protected-virtual inheritance to mirror, so this is an interface with OPTIONAL shaping members and the
 * `officeModel()` factory in OfficeModelLogic fills in the same defaults — the identical call the sibling
 * @altea/altea-email port made for IEmailModel.
 */
export interface IOfficeModel {
    /** The entity this model is ABOUT (Signum's UntypedEntity). */
    readonly untypedEntity: Entity | null;
    /** The filters the template's query should run with (default: this entity). */
    getFilters?(queryName: QueryName): Filter[];
    getOrders?(queryName: QueryName): Order[];
    getPagination?(): Pagination;
}

/** Signum's WordTemplateParameters: the RUNTIME context one render runs under. */
export class OfficeTemplateParameters extends TemplateParameters {
    /**
     * The token currently being rendered. Signum sets this around `ValueProvider.GetValue` so a global
     * variable can reach back for the run properties / the node's position (the image-insertion globals
     * rely on it).
     */
    currentTokenNode: TokenNode | undefined;

    constructor(
        entity: Entity | null,
        culture: string,
        queryContext: QueryContext | undefined,
        public readonly template: OfficeTemplateEntity,
        public readonly model: IOfficeModel | undefined,
        public readonly package_: OxmlPackage,
    ) {
        super(entity, culture, queryContext);
    }

    override getModel(): object {
        if (this.model == null)
            throw new Error(`There is no model for the template '${this.template.name}'`);
        return this.model;
    }
}
