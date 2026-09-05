import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { EmailConfigurationEmbedded } from "../../data/Email";

// Port of Signum.Mailing's Templates/EmailConfiguration.tsx — the app's mail settings.
//
// altea divergence: Signum filters the combo to the NON-NEUTRAL cultures
// (`IsNeutral == false`, free there because `[AutoExpressionField]` makes it a query token; altea
// registers no such expression). Dropped rather than reproduced: eastwind seeds only neutral cultures,
// so the filter would hide every row INCLUDING the configured one — a combo that cannot offer the value
// it is displaying. The whole supported-culture table is a handful of rows either way.
export default function EmailConfiguration(p: { ctx: TypeContext<EmailConfigurationEmbedded> }): React.JSX.Element {
    const sc = p.ctx;
    const ac = p.ctx.subCtx({ formGroupStyle: "Basic" });

    return (
        <div>
            <AutoLine ctx={sc.subCtx(ca => ca.reciveEmails)} />
            <AutoLine ctx={sc.subCtx(ca => ca.sendEmails)} />
            <AutoLine ctx={sc.subCtx(ca => ca.overrideEmailAddress)} />
            <EntityCombo ctx={sc.subCtx(ca => ca.defaultCulture)} />
            <AutoLine ctx={sc.subCtx(ca => ca.urlLeft)} />

            <fieldset>
                <legend>Async</legend>
                <div className="row">
                    <div className="col-sm-6">
                        <AutoLine ctx={ac.subCtx(ca => ca.avoidSendingEmailsOlderThan)} />
                        <AutoLine ctx={ac.subCtx(ca => ca.chunkSizeSendingEmails)} />
                    </div>
                    <div className="col-sm-6">
                        <AutoLine ctx={ac.subCtx(ca => ca.maxEmailSendRetries)} />
                        <AutoLine ctx={ac.subCtx(ca => ca.asyncSenderPeriod)} />
                    </div>
                </div>
            </fieldset>
        </div>
    );
}
