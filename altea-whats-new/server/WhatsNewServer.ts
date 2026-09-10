import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { Clock } from "@altea/altea/data/utils/clock";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic";
import { mimeType } from "@altea/altea-files/server/FileTypeAlgorithm";
import {
    WhatsNewEntity, WhatsNewLogEntity, WhatsNewMessage, WhatsNewState,
    type NumWhatsNews, type WhatsNewFull, type WhatsNewShort,
} from "../data/WhatsNew";
import { WhatsNewLogic } from "./WhatsNewLogic";

// The six routes the bullhorn, the overview and the news page call.
//
// The preview-picture route is AUTHENTICATED: the picture belongs to a news item whose visibility is
// exactly what this module computes, so serving it to anyone would hand out the one part of an unpublished
// item that has no other gate.
//
// Port of Signum.WhatsNew's WhatsNewController.cs — see docs/port/WhatsNew.md.
export namespace WhatsNewServer {

    export function start(ws: WebBuilder): void {

        // What the navbar badge shows.
        ws.get("/api/whatsnew/myNewsCount",
            { res: CustomType<NumWhatsNews>() },
            async (_req, res) => {
                const news = await WhatsNewLogic.getWhatNews();
                return res.jsonTyped({
                    numWhatsNews: news.filter(t => t.wn.status === WhatsNewState.Publish && !t.isRead).length,
                });
            });

        // The unread, published items the dropdown lists.
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

        // The overview page, read and unread alike.
        ws.get("/api/whatsnew/all",
            { res: CustomType<WhatsNewFull[]>() },
            async (_req, res) => {
                const news = await WhatsNewLogic.getWhatNews();
                return res.jsonTyped(news.map(t => toFull(t.wn, t.isRead)));
            });

        // Streamed by the same helper the file module uses for its own owner-addressed downloads, so ETag
        // and caching behave identically.
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

        // The news page, which is ALSO what marks the item read.
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

        // "I have seen these", from closing a toast.
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
     * Write one log row per not-yet-read item, ROW BY ROW: a set-based insert would have to read the
     * current user inside a query lambda, which has no SQL translation. The set is at most a handful of
     * lites ("the toasts I just closed").
     *
     * In `ExecutionMode.global`: a user must be able to record having read something whatever their rules
     * on the log table say.
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
