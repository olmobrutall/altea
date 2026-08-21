import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { EmailMessageEntity } from "../../data/EmailMessage";
import { EmailReceptionMixin, type EmailReceptionEntity } from "../../data/EmailReception";

// Port of Signum.Mailing/Reception's Templates/EmailReception.tsx — one poll of one mailbox, with counts of
// what it stored and what it could not.
//
// altea divergences:
//  - Signum's token is `token(a => a.entity).mixin(EmailReceptionMixin).append(a => a.receptionInfo!.reception)`;
//    altea's tokens are ROOTLESS and its mixins are FLATTENED onto the owner, so the mixin step is navigated
//    inside ONE lambda (`a.mixin(…).receptionInfo!.reception`) — see TypeContext.subCtx's note.
//  - The exception count reaches its rows through the registered `pop3Reception` expression by NAME (the
//    string overload of the token function), Signum's `.expression("Pop3Reception")`.
export default function EmailReception(p: { ctx: TypeContext<EmailReceptionEntity> }): React.JSX.Element {
    const sc = p.ctx;

    return (
        <div>
            <EntityLine ctx={sc.subCtx(s => s.emailReceptionConfiguration)} />
            <AutoLine ctx={sc.subCtx(s => s.startDate)} />
            <AutoLine ctx={sc.subCtx(s => s.endDate)} />
            <AutoLine ctx={sc.subCtx(s => s.serverEmails)} />
            <AutoLine ctx={sc.subCtx(s => s.newEmails)} />
            <AutoLine ctx={sc.subCtx(s => s.lastServerMessageUID)} />
            <AutoLine ctx={sc.subCtx(s => s.mailsFromDifferentAccounts)} />
            <EntityLine ctx={sc.subCtx(s => s.exception)} />

            {!sc.value.isNew && <>
                <SearchValueLine ctx={sc} findOptions={EmailMessageEntity.findOptions(token => ({
                    filterOptions: [{
                        token: token(a => a.mixin(EmailReceptionMixin).receptionInfo!.reception),
                        value: sc.value,
                    }],
                }))} />
                <SearchValueLine ctx={sc} findOptions={ExceptionEntity.findOptions(token => ({
                    filterOptions: [{ token: token("pop3Reception"), value: sc.value }],
                }))} />
            </>}
        </div>
    );
}
