import * as React from "react";
import { DropdownButton, Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { getQueryKey } from "@altea/altea/client/Reflection";
import type { Lite } from "@altea/altea/data/lite";
import { OfficeTemplateMessage, type OfficeTemplateEntity } from "../data/OfficeTemplate";
import { OfficeClient } from "./OfficeClient";

// Port of Signum.Word's WordSearchMenu.tsx — the search-control toolbar button that offers one template per
// menu item and renders it for the CURRENT query request.
//
// altea divergence (the same one @altea/altea-email's MailingMenu documents): Signum read the applicable
// templates off `queryDescription.wordTemplates`, an extension the server pushed into the QueryDescription
// DTO. altea has no such DTO, so they are FETCHED here with visibleOn "Query"; the button renders nothing
// until they arrive and nothing at all when there are none — which is what Signum's `!wordReports.length`
// guard did.

export interface OfficeSearchMenuProps {
    searchControl: SearchControlLoaded;
}

export default function OfficeSearchMenu(p: OfficeSearchMenuProps): React.JSX.Element | null {

    const queryKey = getQueryKey(p.searchControl.props.findOptions.queryKey);

    const templates = useAPI(
        () => OfficeClient.API.getOfficeTemplates(queryKey, "Query", { lite: null })
            .catch(() => [] as Lite<OfficeTemplateEntity>[]),
        [queryKey]);

    async function handleClick(ot: Lite<OfficeTemplateEntity>): Promise<void> {
        const template = await Navigator.API.fetch(ot);
        if (template.model == null)
            throw new Error(`The template '${template.name}' has no model, so it cannot be rendered for a whole query`);

        const constructorType = await OfficeClient.API.getConstructorType(template.model);
        const setting = OfficeClient.settings[constructorType];
        if (setting?.createFromQuery == undefined)
            throw new Error(`No 'createFromQuery' is registered in the OfficeModelSettings of '${constructorType}'`);

        const model = await setting.createFromQuery(ot, p.searchControl.getQueryRequest());
        if (model != null)
            await OfficeClient.createAndDownloadReport({ template: ot, entity: model });
    }

    if (templates == null || templates.length === 0)
        return null;

    const label = (
        <span>
            <FontAwesomeIcon aria-hidden={true} icon="file-word" />
            {p.searchControl.props.largeToolbarButtons === true
                ? <>&nbsp;{OfficeTemplateMessage.OfficeReport.niceToString()}</>
                : undefined}
        </span>
    );

    return (
        <DropdownButton id="officeTemplateDropDown" variant="light" className="sf-office-dropdown" title={label}>
            {templates.map((ot, i) =>
                <Dropdown.Item key={i} onClick={() => void handleClick(ot)}>
                    {ot.toString()}
                </Dropdown.Item>)}
        </DropdownButton>
    );
}
