import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { graph } from "@altea/altea/server/graphBuilder";
import { table } from "@altea/altea/server/table";
import type { Lite } from "@altea/altea/data/lite";
import type { Type } from "@altea/altea/data/entity";
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
//  - Signum implements that last step with a JSON PROPERTY CONVERTER per service type (each sender package
//    registers a `CustomReadJsonProperty` that encrypts on the way in and writes nothing on the way out).
//    altea does it in the SAVE OPERATION instead, through `registerEmailServiceSave` — so a sender package
//    in another workspace package (Exchange WS, POP3's reception twin) supplies the one line that knows which
//    of ITS fields holds the password, without this module knowing the type.

export namespace EmailSenderConfigurationLogic {

    /** Signum's `EmailSenderCache` — every sender configuration, by id. */
    export let emailSenderCache: ResetLazy<EmailSenderConfigurationEntity[]> = null!;

    let encrypt: (s: string) => string = s => s;
    let decrypt: (s: string) => string = s => s;

    // altea-only (see the header): per service type, what Save must do before the row is written.
    const serviceSaves = new Map<Function, (service: EmailServiceEntity) => void>();

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

        // The SMTP service's own "fold the typed-in password into the stored one" step. Registered here
        // rather than written inline in Save, so every sender type goes through the same seam.
        registerEmailServiceSave(SmtpEmailServiceEntity, smtp => {
            const network = smtp.network;
            if (network?.newPassword != null) {
                network.password = encryptPassword(network.newPassword);
                network.newPassword = null;
            }
        });

        EmailSenderConfigurationGraph.register();
    }

    /** altea-only (see the header): what the Save operation should do to this service type before it is
     *  written — in practice, encrypt the typed-in password into the stored field. Call it from the sender
     *  package's own `start`. */
    export function registerEmailServiceSave<T extends EmailServiceEntity>(
        serviceType: Type<T>,
        prepareForSave: (service: T) => void,
    ): void {
        serviceSaves.set(serviceType as unknown as Function,
            prepareForSave as unknown as (service: EmailServiceEntity) => void);
    }

    /** Run the registered pre-save step for this service instance's type, or for a base of it (the
     *  prototype-chain walk Signum's Polymorphic does). */
    export function prepareServiceForSave(service: EmailServiceEntity): void {
        for (let ctor: Function | null = service.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor) as Function | null) {
            const prepare = serviceSaves.get(ctor);
            if (prepare != null) {
                prepare(service);
                return;
            }
        }
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

    // Signum's Save: turn the typed-in `newPassword` into the stored (encrypted) `password`.
    const EmailSenderConfigurationGraph = graph(EmailSenderConfigurationEntity, g => {
        g.Execute(EmailSenderConfigurationOperation.Save, {
        canBeNew: true,
        canBeModified: true,
        execute: (sc: EmailSenderConfigurationEntity) => {
            prepareServiceForSave(sc.service);
        },
        });

        g.ConstructFrom(EmailSenderConfigurationEntity, EmailSenderConfigurationOperation.Clone, {
        construct: (sc: EmailSenderConfigurationEntity) => sc.clone(),
        });
    });
}