import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Graph } from "@altea/altea/server/graph";
import { table } from "@altea/altea/server/table";
import type { Lite } from "@altea/altea/data/lite";
import {
    EmailSenderConfigurationEntity, EmailSenderConfigurationOperation, SmtpEmailServiceEntity,
    EmailServiceEntity,
} from "../data/EmailSenderConfiguration";

// Port of Signum.Mailing's EmailSenderConfigurationLogic.cs — the sender-configuration table, its cache, and
// the Save / Clone operations. The SmtpClient factory it also held lives in SmtpSender.server.ts (nodemailer).
//
// altea divergences, documented inline:
//  - `WithDeletePart(a => a.Service)` (cascade the service row when the configuration goes) is expressed as
//    an explicit Delete handler — altea has no WithDeletePart fluent step.
//  - The cache is a plain array behind a globalLazy (altea's ResetLazy holds a value, not a FrozenDictionary);
//    `retrieveFromCache(lite)` looks up by id STRING, since a PrimaryKey may be a number or a uuid.
//  - `EncryptPassword` / `DecryptPassword` default to identity in Signum too — an app that stores real
//    credentials MUST supply them (see start's options). The stored `password` is never shown in the editor:
//    the user types into `newPassword`, which Save encrypts into `password` and clears.

export namespace EmailSenderConfigurationLogic {

    /** Signum's `EmailSenderCache` — every sender configuration, by id. */
    export let emailSenderCache: ResetLazy<EmailSenderConfigurationEntity[]> = null!;

    let encrypt: (s: string) => string = s => s;
    let decrypt: (s: string) => string = s => s;

    export function encryptPassword(value: string): string { return encrypt(value); }
    export function decryptPassword(value: string): string { return decrypt(value); }

    export function start(sb: SchemaBuilder, options?: {
        encryptPassword?: (s: string) => string;
        decryptPassword?: (s: string) => string;
    }): void {
        if (sb.alreadyDefined(start))
            return;

        if (options?.encryptPassword != null)
            encrypt = options.encryptPassword;
        if (options?.decryptPassword != null)
            decrypt = options.decryptPassword;

        // The SERVICE (a polymorphic @implementedBy target), its network row and that row's certificate rows
        // are all reached from this entity's fields, so the SchemaBuilder includes them itself.
        sb.include(EmailSenderConfigurationEntity)
            .withQuery();

        emailSenderCache = sb.globalLazy(
            () => table(EmailSenderConfigurationEntity).toArray() as Promise<EmailSenderConfigurationEntity[]>,
            { invalidateWith: [EmailSenderConfigurationEntity] });

        // Signum's Save: turn the typed-in `newPassword` into the stored (encrypted) `password`.
        new Graph.Execute(EmailSenderConfigurationOperation.Save, {
            canBeNew: true,
            canBeModified: true,
            execute: (sc: EmailSenderConfigurationEntity) => {
                const network = (sc.service as SmtpEmailServiceEntity).network;
                if (network?.newPassword != null) {
                    network.password = encryptPassword(network.newPassword);
                    network.newPassword = null;
                }
            },
        }).register();

        new Graph.ConstructFrom(EmailSenderConfigurationOperation.Clone, {
            construct: (sc: EmailSenderConfigurationEntity) => sc.clone(),
        }).register();
    }

    /** Signum's `config.RetrieveFromCache()`. */
    export async function retrieveFromCache(config: Lite<EmailSenderConfigurationEntity>): Promise<EmailSenderConfigurationEntity> {
        const all = await emailSenderCache.value();
        const found = all.find(c => String(c.id) === String(config.id));
        if (found == null)
            throw new Error(`EmailSenderConfiguration '${String(config.id)}' not found`);
        return found;
    }

    /** The service row a configuration points at goes WITH it (Signum's WithDeletePart). */
    export async function deleteWithService(sc: EmailSenderConfigurationEntity): Promise<void> {
        const service: EmailServiceEntity = sc.service;
        await sc.delete();
        await service.delete();
    }
}
