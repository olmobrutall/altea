// The template parameters and the model contract — see port/OfficeTemplate.md.
// Kept in its own module because the nodes, the parser and the renderer all need it and altea has no
// partial classes.

import type { BaseEntity, Entity } from "@altea/altea/data/entity";
import type { OfficeModel } from "./OfficeModelLogic";
import { TemplateParameters, type QueryContext } from "@altea/altea-templating/server/ValueProviders";
import type { OfficeTemplateEntity } from "../data/OfficeTemplate";
import type { OxmlPackage } from "./oxml/OxmlPackage";
import type { TokenNode } from "./OfficeTemplateNodes";

/** The RUNTIME context one render runs under. */
export class OfficeTemplateParameters extends TemplateParameters {
    /**
     * The token currently being rendered. Set around `ValueProvider.getValue` so a global
     * variable can reach back for the run properties / the node's position (the image-insertion globals
     * rely on it).
     */
    currentTokenNode: TokenNode | undefined;

    constructor(
        entity: Entity | null,
        culture: string,
        queryContext: QueryContext | undefined,
        public readonly template: OfficeTemplateEntity,
        public readonly model: OfficeModel<BaseEntity | null> | undefined,
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
