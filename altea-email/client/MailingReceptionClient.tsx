import * as React from "react";
import { Tab } from "react-bootstrap";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EmailMessageEntity } from "../data/EmailMessage";
import {
    EmailReceptionConfigurationEntity, EmailReceptionEntity, EmailReceptionExceptionEntity,
    EmailReceptionMixin,
} from "../data/EmailReception";

// Port of Signum.Mailing/Reception's MailingReceptionClient.tsx — the reception half's client registration:
// the two entity editors, and the extra TAB an EmailMessage grows when it turns out to be a RECEIVED one.
//
// Call it from the app's client bootstrap AFTER MailingClient.start (the tab override needs EmailMessage's
// EntitySettings to exist, and the reception default columns extend the ones MailingClient registered).
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(T, view))` becomes `cb.configure(T).withView(...)`; the
//    `overrideView` that adds the tab still goes through `Navigator.getSettings(EmailMessageEntity)`, since
//    the builder has no fluent step for it.
//  - Signum re-declares the SERVER query to add the reception `SentDate` column; altea resolves query columns
//    client-side, so the column is added here as a default column on EmailMessage instead.
//  - `getMixin(entity, EmailReceptionMixin)` becomes `entity.mixin(EmailReceptionMixin)` (altea flattens a
//    mixin's fields onto the owner, and `mixin()` is the typed accessor + declaration assertion).

export namespace MailingReceptionClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(EmailReceptionConfigurationEntity)
            .withView(() => import("./Templates/EmailReceptionConfiguration"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(c => c.id),
                    token(c => c.emailAddress),
                    token(c => c.active),
                    token(c => c.service),
                ],
            }));

        cb.configure(EmailReceptionEntity)
            .withView(() => import("./Templates/EmailReception"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(r => r.id),
                    token(r => r.emailReceptionConfiguration),
                    token(r => r.startDate),
                    token(r => r.endDate),
                    token(r => r.serverEmails),
                    token(r => r.newEmails),
                    token(r => r.exception),
                ],
            }));

        cb.configure(EmailReceptionExceptionEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(e => e.id),
                    token(e => e.reception),
                    token(e => e.exception),
                ],
            }));

        // A received message shows where it came from — Signum's insertTabAfter("mainTab", …). The override
        // returns early for a message that was SENT, whose reception info is null.
        Navigator.getSettings(EmailMessageEntity)!.overrideView(rep => {
            if (rep.ctx.value.mixin(EmailReceptionMixin).receptionInfo == null)
                return;

            const riCtx = rep.ctx.subCtx(a => a.mixin(EmailReceptionMixin).receptionInfo!);

            rep.insertTabAfter("mainTab",
                <Tab title={riCtx.niceName()} eventKey="receptionMixin" key="receptionMixin">
                    <fieldset>
                        <legend>{EmailReceptionEntity.niceName()}</legend>
                        <EntityLine ctx={riCtx.subCtx(f => f.reception)} />
                        <AutoLine ctx={riCtx.subCtx(f => f.uniqueId)} />
                        <AutoLine ctx={riCtx.subCtx(f => f.sentDate)} />
                        <AutoLine ctx={riCtx.subCtx(f => f.receivedDate)} />
                        <AutoLine ctx={riCtx.subCtx(f => f.deletionDate)} />
                    </fieldset>
                    <h3>{riCtx.niceName(a => a.rawContent)}</h3>
                    <pre style={{ maxHeight: "600px", overflow: "auto" }}>{riCtx.value.rawContent?.text}</pre>
                </Tab>);
        });
    }
}
