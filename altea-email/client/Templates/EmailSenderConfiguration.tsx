import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import { SearchValueLine } from "@altea/altea/client/SearchControl/SearchValueLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EmailMessageEntity } from "../../data/EmailMessage";
import type { EmailSenderConfigurationEntity } from "../../data/EmailSenderConfiguration";

// Port of Signum.Mailing's Templates/EmailSenderConfiguration.tsx — a named "how do we send" configuration.
// altea divergence: `EntityAccordion` is not ported, so the additional recipients use `EntityRepeater`.
export default function EmailSenderConfiguration(p: { ctx: TypeContext<EmailSenderConfigurationEntity> }): React.JSX.Element {
    const sc = p.ctx;

    return (
        <div>
            <AutoLine ctx={sc.subCtx(s => s.name)} />
            <EntityDetail ctx={sc.subCtx(s => s.defaultFrom)} />
            <EntityRepeater ctx={sc.subCtx(s => s.additionalRecipients)} />

            {!sc.value.isNew &&
                <SearchValueLine ctx={sc} findOptions={EmailMessageEntity.findOptions(token => ({
                    filterOptions: [{ token: token(a => a.sentBy), value: sc.value }],
                }))} />}

            <EntityDetail ctx={sc.subCtx(s => s.service)} />
        </div>
    );
}
