import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { EmailConfigurationEmbedded } from "../../data/Email";

// Port of Signum.Mailing's Templates/EmailConfiguration.tsx — the app's mail settings.
//
// altea divergence: Signum's `defaultCulture` is an `EntityCombo` over CultureInfoEntity (filtered to the
// non-neutral cultures); altea has no CultureInfoEntity, so it is a plain locale text box.
export default function EmailConfiguration(p: { ctx: TypeContext<EmailConfigurationEmbedded> }): React.JSX.Element {
    const sc = p.ctx;
    const ac = p.ctx.subCtx({ formGroupStyle: "Basic" });

    return (
        <div>
            <AutoLine ctx={sc.subCtx(ca => ca.reciveEmails)} />
            <AutoLine ctx={sc.subCtx(ca => ca.sendEmails)} />
            <AutoLine ctx={sc.subCtx(ca => ca.overrideEmailAddress)} />
            <AutoLine ctx={sc.subCtx(ca => ca.defaultCulture)} />
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
