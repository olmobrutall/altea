import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Entity, Type } from "@altea/altea/data/entity";
import { SMSCharacters } from "../data/SMSCharacters";
import { SMSLogic } from "./SMSLogic.server";

// Port of Signum.SMS's SMSController.cs (+ SMSServer.cs) — the two endpoints the client needs.
//
// altea divergences:
//  - **Signum's `SMSServer.Start` re-parses a POSTed SMSTemplate's query tokens** through an
//    `AfterDeserialization` hook. altea resolves query tokens CLIENT-side (there is no QueryDescription to
//    parse against — see CLAUDE.md), so there is nothing to re-parse and the hook has no counterpart; the
//    canonical-form re-print still happens, in the template's PreSaving.
//  - `getAllTypes` answers the clean names of the REGISTERED owner types (`SMSLogic.registerSMSOwner`),
//    where Signum scans for `ISMSOwnerEntity` implementors — see data/SMS.ts on why a registry.
export namespace SMSServer {

    export function start(ws: WebBuilder): void {

        // The character budget of a message, as the template editor types (Signum's same POST: the rules
        // live on the server so the two halves cannot disagree).
        ws.post("/api/sms/remainingCharacters",
            { req: CustomType<{ message: string; removeNoSMSCharacters: boolean }>(), res: CustomType<number>() },
            async (req, res) => {
                const { message, removeNoSMSCharacters } = await req.jsonTyped();
                const text = removeNoSMSCharacters ? SMSCharacters.removeNoSMSCharacters(message ?? "") : (message ?? "");
                res.jsonTyped(SMSCharacters.remainingLength(text));
            });

        // Which types can be the subject of an SMS — what the client's quick link checks against.
        ws.get("/api/sms/getAllTypes",
            { res: CustomType<string[]>() },
            (_req, res) => {
                res.jsonTyped(SMSLogic.allOwnerTypes().map(t => cleanTypeName(t as Type<Entity>)));
            });
    }
}
