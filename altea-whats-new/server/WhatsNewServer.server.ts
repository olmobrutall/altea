import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Clock } from "@altea/altea/data/utils/clock";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { mimeType } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import {
    WhatsNewEntity, WhatsNewLogEntity, WhatsNewMessage, WhatsNewState,
    type NumWhatsNews, type WhatsNewFull, type WhatsNewShort,
} from "../data/WhatsNew";
import { WhatsNewLogic } from "./WhatsNewLogic.server";

// Port of Signum.WhatsNew's WhatsNewController.cs — the six routes the bullhorn, the overview and the news
// page call.
//
// altea divergences:
//  - **`setNewsLog` inserts row by row instead of Signum's set-based `UnsafeInsert`.** Signum's projection
//    (`wn => new WhatsNewLogEntity { … UserEntity.Current … }`) reads the current user inside a query
//    lambda, and a call there has no SQL translation in altea; the set is at most a handful of lites (it is
//    "the toasts I just closed"), so the loop is cheaper than the machinery to avoid it.
//  - the preview-picture route stays AUTHENTICATED, where Signum marks it `[SignumAllowAnonymous]`. The
//    picture belongs to a news item whose visibility is exactly what this module computes, so serving it to
//    anyone would hand out the one part of an unpublished item that has no other gate. The same call
//    @altea/altea-mailing-microsoft-graph's attachment download made.
export namespace WhatsNewServer {

    export function start(ws: WebBuilder): void {

        // Signum's MyNewsCount — what the navbar badge shows.
        ws.get("/api/whatsnew/myNewsCount",
            { res: CustomType<NumWhatsNews>() },
            async (_req, res) => {
                const news = await WhatsNewLogic.getWhatNews();
                return res.jsonTyped({
                    numWhatsNews: news.filter(t => t.wn.status === WhatsNewState.Publish && !t.isRead).length,
                });
            });

        // Signum's MyNews — the unread, published items the dropdown lists.
        ws.get("/api/whatsnew/myNews",
            { res: CustomType<WhatsNewShort[]>() },
            async (_req, res) => {
                const news = await WhatsNewLogic.getWhatNews();
                return res.jsonTyped(news
                    .filter(t => !t.isRead && t.wn.status === WhatsNewState.Publish)
                    .map(t => {
                        const cm = WhatsNewLogic.getCurrentMessage(t.wn);
                        return {
                            whatsNew: t.wn.toLite(),
                            creationDate: t.wn.creationDate.toString(),
                            title: cm.title,
                            description: cm.description,
                            status: WhatsNewState[t.wn.status],
                        };
                    }));
            });

        // Signum's GetAllNews — the overview page, read and unread alike.
        ws.get("/api/whatsnew/all",
            { res: CustomType<WhatsNewFull[]>() },
            async (_req, res) => {
                const news = await WhatsNewLogic.getWhatNews();
                return res.jsonTyped(news.map(t => toFull(t.wn, t.isRead)));
            });

        // Signum's GetPreviewPicture. Streamed by the same helper the file module uses for its own
        // owner-addressed downloads, so an ETag / caching behaves identically.
        ws.get("/api/whatsnew/previewPicture/:id",
            { params: CustomType<{ id: string }>() },
            async (req, res) => {
                const wn = await WhatsNewLogic.getWhatNew(req.params.id);
                if (wn?.previewPicture == null) {
                    res.status(404).end();
                    return;
                }
                const bytes = await FilePathEmbeddedLogic.readAllBytes(wn.previewPicture);
                res.setHeader("Content-Type", mimeType(wn.previewPicture.fileName) ?? "application/octet-stream");
                res.send(Buffer.from(bytes));
            });

        // Signum's SpecificNews — the news page, which is ALSO what marks the item read.
        ws.get("/api/whatsnew/:id",
            { params: CustomType<{ id: string }>(), res: CustomType<WhatsNewFull>() },
            async (req, res) => {
                const wn = await WhatsNewLogic.getWhatNew(req.params.id);
                if (wn == null)
                    throw new Error(WhatsNewMessage.ThisNewIsNoLongerAvailable.niceToString());

                if (!await WhatsNewLogic.isReadByCurrentUser(wn))
                    await markRead([wn.toLite()]);

                return res.jsonTyped(toFull(wn, true));
            });

        // Signum's setNewsLogRead — "I have seen these", from closing a toast.
        ws.post("/api/whatsnew/setNewsLog",
            { req: CustomType<Lite<WhatsNewEntity>[]>(), res: CustomType<void>() },
            async (req, res) => {
                await markRead(await req.jsonTyped());
                return res.jsonTyped(undefined);
            });
    }

    function toFull(wn: WhatsNewEntity, isRead: boolean): WhatsNewFull {
        const cm = WhatsNewLogic.getCurrentMessage(wn);
        return {
            whatsNew: wn.toLite(),
            creationDate: wn.creationDate.toString(),
            title: cm.title,
            description: cm.description,
            attachments: wn.attachments.length,
            previewPicture: wn.previewPicture != null,
            status: WhatsNewState[wn.status],
            read: isRead,
        };
    }

    /**
     * Write one log row per not-yet-read item (Signum's `UnsafeInsert` over the same set). In
     * `ExecutionMode.global`, as Signum's `AuthLogic.Disable()` is: a user must be able to record having
     * read something whatever their rules on the log table say.
     */
    async function markRead(lites: Lite<WhatsNewEntity>[]): Promise<void> {
        const user = UserHolder.currentUserLite();
        if (user == null || lites.length === 0)
            return;

        await ExecutionMode.global(async () => {
            const alreadyRead = new Set((await table(WhatsNewLogEntity)
                .filter(l => l.user.is(user))
                .map(l => l.whatsNew)
                .toArray() as Lite<WhatsNewEntity>[]).map(l => l.key()));

            for (const lite of lites) {
                if (alreadyRead.has(lite.key()))
                    continue;
                await WhatsNewLogEntity.create({ whatsNew: lite, user: user as Lite<UserEntity>, readOn: Clock.now }).save();
            }
        });
    }

}
