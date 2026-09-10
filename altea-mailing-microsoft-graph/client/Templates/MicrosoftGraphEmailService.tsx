import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { MicrosoftGraphEmailServiceEntity } from "../../data/MailingMicrosoftGraph";

// The three Azure fields appear only when the service does NOT borrow the app's own Entra registration.
// The stored client secret is shown READ-ONLY and edited through `newAzure_ClientSecret` — see the data
// module on why it is encrypted.
export default function MicrosoftGraphEmailService(p: { ctx: TypeContext<MicrosoftGraphEmailServiceEntity> }): React.JSX.Element {
    const sc = p.ctx;
    const forceUpdate = useForceUpdate();

    return (
        <div>
            <AutoLine ctx={sc.subCtx(ca => ca.useActiveDirectoryConfiguration)} onChange={forceUpdate} />
            {!sc.value.useActiveDirectoryConfiguration &&
                <div>
                    <AutoLine ctx={sc.subCtx(ca => ca.azure_DirectoryID)} />
                    <AutoLine ctx={sc.subCtx(ca => ca.azure_ApplicationID)} />
                    <AutoLine ctx={sc.subCtx(ca => ca.azure_ClientSecret, { readOnly: true })} />
                    <AutoLine ctx={sc.subCtx(ca => ca.newAzure_ClientSecret)} />
                </div>}
        </div>
    );
}
