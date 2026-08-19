import * as React from "react";
import { DropdownButton, Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { Entity } from "@altea/altea/data/entity";
import type { EntityPack } from "@altea/altea/data/entityPack";
import type { Lite } from "@altea/altea/data/lite";
import { OfficeTemplateMessage, type OfficeTemplateEntity } from "../data/OfficeTemplate";
import { OfficeClient } from "./OfficeClient";

// Port of Signum.Word's WordEntityMenu.tsx — the button on an entity's frame offering every report template
// applicable to THAT entity.
//
// altea divergence: Signum read the templates off `entityPack.wordTemplates`, an extension the server pushed
// into the EntityPack DTO. altea's EntityPack carries no such member, so they are FETCHED here with
// visibleOn "Single" — the same call the contextual menu makes. The button renders nothing until they
// arrive and nothing at all when there are none, which is what Signum's `wordTemplates.length > 0` guard
// on the render side did.

export interface OfficeEntityMenuProps {
    entityPack: EntityPack<Entity>;
}

export default function OfficeEntityMenu(p: OfficeEntityMenuProps): React.JSX.Element | null {

    const entity = p.entityPack.entity;
    const queryKey = getQueryKey(entity.constructor as Parameters<typeof getQueryKey>[0]);

    const templates = useAPI(
        () => entity.isNew
            // A new entity has no row to render against yet.
            ? Promise.resolve([] as Lite<OfficeTemplateEntity>[])
            : OfficeClient.API.getOfficeTemplates(queryKey, "Single", { lite: entity.toLite() })
                .catch(() => [] as Lite<OfficeTemplateEntity>[]),
        [queryKey, String(entity.id), entity.isNew],
    );

    async function handleClick(ot: Lite<OfficeTemplateEntity>): Promise<void> {
        const template = await Navigator.API.fetch(ot);
        const constructorType = template.model != null
            ? await OfficeClient.API.getConstructorType(template.model)
            : undefined;

        // No model, or a model built straight from this entity's type: render against the entity itself.
        if (constructorType == undefined || constructorType === getQueryKey(entity.constructor as Parameters<typeof getQueryKey>[0]))
            return await OfficeClient.createAndDownloadReport({ template: ot, lite: entity.toLite() });

        const setting = OfficeClient.settings[constructorType];
        if (setting == undefined)
            throw new Error(`No 'OfficeModelSettings' defined for '${constructorType}'`);
        if (setting.createFromEntities == undefined)
            throw new Error(`No 'createFromEntities' defined in the OfficeModelSettings of '${constructorType}'`);

        const model = await setting.createFromEntities(ot, [entity.toLite()]);
        if (model != null)
            await OfficeClient.createAndDownloadReport({ template: ot, entity: model });
    }

    if (templates == null || templates.length === 0)
        return null;

    const label = (
        <span>
            <FontAwesomeIcon aria-hidden={true} icon="file-word" />
            &nbsp;{OfficeTemplateMessage.OfficeReport.niceToString()}
        </span>
    );

    return (
        <DropdownButton id="officeMenu" className="sf-office-dropdown" variant="outline-info" title={label}>
            {templates.map((ot, i) =>
                <Dropdown.Item key={i} onClick={() => void handleClick(ot)}>
                    {ot.toString()}
                </Dropdown.Item>)}
        </DropdownButton>
    );
}
