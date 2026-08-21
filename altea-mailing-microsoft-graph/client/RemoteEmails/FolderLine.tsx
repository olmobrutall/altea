import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { RemoteEmailFolderModel } from "../../data/RemoteEmailMessage";
import { RemoteEmailsClient } from "./RemoteEmailsClient";

// Port of Signum.Mailing.MicrosoftGraph/RemoteEmails' FolderLine.tsx — the folder FILTER editor: a plain
// <select> over the mailbox's real folders, fetched for whichever user the query is filtered by.
//
// The effect is the interesting part and is kept as-is: a folder that arrived from a URL carries its own id as
// its displayName (see RemoteEmailsClient's decodeModel), so once the real folder list lands the name is
// filled in; and a folder that is NOT in the list at all is cleared, because it belongs to another mailbox.
//
// altea divergences: the import paths, and the user's mailbox is addressed by the USER's own lite (the routes
// resolve the directory object id server-side — see RemoteEmailsServer's header) instead of by reading
// `UserLiteModel.externalId`, which altea has no lite model to hold.
export function FolderLine(p: {
    ctx: TypeContext<RemoteEmailFolderModel | null>;
    user: Lite<UserEntity> | undefined;
    label?: string;
    mandatory?: boolean;
    onChange: () => void;
}): React.JSX.Element {

    const userId = p.user?.id;
    const folders = useAPI(() => userId == null ? Promise.resolve([]) : RemoteEmailsClient.API.getRemoteFolders(userId), [userId]);
    const forceUpdate = useForceUpdate();

    const allFolders: (RemoteEmailFolderModel | null)[] = [
        null,
        // Keep the CURRENT value in the list while it is not (yet) among the fetched ones, so the select does
        // not silently show something else.
        ...(folders?.some(f => f.folderId === p.ctx.value?.folderId) || p.ctx.value == null ? [] : [p.ctx.value]),
        ...(folders ?? []),
    ];

    React.useEffect(() => {
        const mod = p.ctx.value;
        if (mod == null || folders == null)
            return;

        const same = folders.find(a => a.folderId === mod.folderId);
        if (same != null) {
            // Came from a URL: the id was used as the display name until the real list arrived.
            if (mod.folderId === mod.displayName) {
                mod.displayName = same.displayName;
                forceUpdate();
            }
        } else {
            // Not this mailbox's folder — drop it rather than filter by something invisible.
            p.ctx.value = null;
            p.onChange();
            forceUpdate();
        }
    }, [folders]);

    function handleOnChange(event: React.ChangeEvent<HTMLSelectElement>): void {
        const value = event.currentTarget.value;

        if (value !== p.ctx.value?.folderId)
            p.ctx.value = value === "" ? null : (folders ?? []).find(a => a.folderId === value) ?? null;

        p.onChange();
        forceUpdate();
    }

    return (
        <FormGroup ctx={p.ctx} label={p.label}>
            {id => (
                <select id={id}
                    className={classes(p.ctx.formSelectClass, p.mandatory && "sf-mandatory")}
                    onChange={handleOnChange}
                    value={p.ctx.value?.folderId ?? ""}
                    title={p.ctx.value?.toString()}>
                    {allFolders.map((r, i) => (
                        <option key={i} value={r ? r.folderId : ""}>{r != null ? r.displayName : " - "}</option>
                    ))}
                </select>
            )}
        </FormGroup>
    );
}
