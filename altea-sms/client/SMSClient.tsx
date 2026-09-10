import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import {
    MultipleSMSModel, SMSMessageEntity, SMSSendPackageEntity, SMSTemplateEntity, SMSUpdatePackageEntity,
} from "../data/SMS";

// The five entity views, plus the "SMS messages" quick link on every type that can be the subject of one.
// The default columns are registered here because `withQuery()` is parameterless — the client owns the
// column list.
//
// See docs/port/Sms.md.
export namespace SMSClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(SMSMessageEntity)
            .withView(() => import("./Templates/SMSMessage"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.from),
                    token(a => a.destinationNumber),
                    token(a => a.state),
                    token(a => a.sendDate),
                    token(a => a.template),
                    token(a => a.referred),
                    token(a => a.exception),
                ],
            }));

        cb.configure(SMSTemplateEntity)
            .withView(() => import("./Templates/SMSTemplate"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.name),
                    token(a => a.isActive),
                    token(a => a.from),
                    token(a => a.query),
                    token(a => a.model),
                ],
            }));

        cb.configure(SMSSendPackageEntity).withView(() => import("./Templates/SMSSendPackage"));
        cb.configure(SMSUpdatePackageEntity).withView(() => import("./Templates/SMSUpdatePackage"));
        cb.configure(MultipleSMSModel).withView(() => import("./Templates/MultipleSMS"));

        // A global quick link, gated on the type being a registered SMS owner. The type list is
        // fetched ONCE and shared by every evaluation.
        let cachedAllTypes: Promise<string[]> | undefined;
        QuickLinkClient.registerGlobalQuickLink(entityType =>
            (cachedAllTypes ??= API.getAllTypes()).then(allTypes => [
                new QuickLinkAction("smsMessages", () => SMSMessageEntity.nicePluralName(),
                    ctx => { void openSMSMessages(ctx.lite); },
                    {
                        isVisible: allTypes.includes(entityType) && !Navigator.isReadOnly(SMSMessageEntity),
                        icon: "comment-sms",
                        iconColor: "green",
                    }),
            ]));
    }

    /** The messages about this entity, with the (constant) Referred
     *  column removed. */
    function openSMSMessages(referred: Lite<Entity>): Promise<unknown> {
        return Finder.find(SMSMessageEntity.findOptions(token => ({
            filterOptions: [{ token: token(a => a.referred), value: referred }],
            columnOptionsMode: "Remove",
            columnOptions: [{ token: token(a => a.referred) }],
        })));
    }

    export namespace API {

        export function getRemainingCharacters(message: string, removeNoSMSCharacters: boolean): Promise<number> {
            return ajaxPost({ url: "/api/sms/remainingCharacters" }, { message, removeNoSMSCharacters });
        }

        export function getAllTypes(signal?: AbortSignal): Promise<string[]> {
            return ajaxGet({ url: "/api/sms/getAllTypes", signal });
        }
    }
}
