import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { Entity, Type } from "@altea/altea/data/entity";
import { SMSCharacters } from "../data/SMSCharacters";
import { SMSLogic } from "./SMSLogic";

// The two endpoints the client needs.
//
// There is no deserialization hook re-parsing a POSTed template's query tokens: tokens are resolved
// CLIENT-side, so there is nothing to re-parse. The canonical-form re-print still happens, in the
// template's PreSaving.
//
// `getAllTypes` answers the clean names of the REGISTERED owner types (`SMSLogic.registerSMSOwner`) — see
// data/SMS.ts on why a registry rather than a scan.
export namespace SMSServer {

    export function start(ws: WebBuilder): void {

        // The character budget of a message, as the template editor types (a POST, because the rules
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
