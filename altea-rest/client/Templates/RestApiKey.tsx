import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { RestApiKeyMessage, type RestApiKeyEntity } from "../../data/Rest";
import { RestApiKeyClient } from "../RestApiKeyClient";

// Port of Signum.Rest's Templates/RestApiKey.tsx — the user, and the key with a "generate" button.
export default function RestApiKeyComponent(p: { ctx: TypeContext<RestApiKeyEntity> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    function generateApiKey(e: React.MouseEvent): void {
        e.preventDefault();
        RestApiKeyClient.API.generateRestApiKey().then(key => {
            ctx.value.apiKey = key;
            // ALTEA: no `modified = true` — dirtiness is snapshot-based here (see CLAUDE.md), so writing
            // the field IS what makes the entity dirty. Signum's flag has no counterpart.
            forceUpdate();
        });
    }

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(e => e.user)} />
            <TextBoxLine ctx={ctx.subCtx(e => e.apiKey)}
                extraButtons={() =>
                    <LinkButton className={classes("sf-line-button", "sf-view", "btn input-group-text")}
                        title={RestApiKeyMessage.GenerateApiKey.niceToString()}
                        onClick={generateApiKey}>
                        <FontAwesomeIcon icon="key" />
                    </LinkButton>} />
        </div>
    );
}
