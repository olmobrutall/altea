import * as React from "react";
import { DropdownButton, Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { EmailMessageEntity } from "../data/EmailMessage";
import type { EmailTemplateEntity } from "../data/EmailTemplate";
import { MailingClient } from "./MailingClient";
import type { Lite } from "@altea/altea/data/lite";

// Port of Signum.Mailing's MailingMenu.tsx — the search-control toolbar button that renders one template per
// menu item and sends it for the CURRENT query request.
//
// altea divergence: Signum read the applicable templates off `queryDescription.emailTemplates` (an extension
// the server pushed into the QueryDescription DTO). altea has no such DTO, so the templates are FETCHED here
// (visibleOn "Query"); the button renders nothing until they arrive, and nothing at all if there are none —
// which is what Signum's `!emailTemplates.length` guard did.

export interface MailingMenuProps {
    searchControl: SearchControlLoaded;
}

export default function MailingMenu(p: MailingMenuProps): React.JSX.Element | null {

    const queryKey = getQueryKey(p.searchControl.props.findOptions.queryKey);

    const emailTemplates = useAPI(
        () => MailingClient.API.getEmailTemplates(queryKey, "Query", { lite: null }).catch(() => [] as Lite<EmailTemplateEntity>[]),
        [queryKey]);

    async function handleClick(et: Lite<EmailTemplateEntity>): Promise<void> {
        const template = await Navigator.API.fetch(et);
        if (template.model == null)
            throw new Error(`The template '${template.name}' has no model, so it cannot be sent for a whole query`);

        const constructorType = await MailingClient.API.getConstructorType(template.model);
        const setting = MailingClient.settings[constructorType];
        if (setting?.createFromQuery == undefined)
            throw new Error(`No 'createFromQuery' is registered in the EmailModelSettings of '${constructorType}'`);

        const model = await setting.createFromQuery(et, p.searchControl.getQueryRequest());
        if (model != null)
            await MailingClient.createAndViewEmail(et, model);
    }

    if (emailTemplates == null || emailTemplates.length === 0)
        return null;

    const label = <span><FontAwesomeIcon aria-hidden={true} icon="envelope" /> &nbsp; {EmailMessageEntity.nicePluralName()}</span>;

    return (
        <DropdownButton id="mailingDropDown" variant="light" className="sf-mailing-dropdown" title={label}>
            {emailTemplates.map((et, i) =>
                <Dropdown.Item key={i} onClick={() => void handleClick(et)}>
                    {et.toString()}
                </Dropdown.Item>)}
        </DropdownButton>
    );
}
