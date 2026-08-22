import { BlobServiceClient, StorageSharedKeyCredential, type ContainerClient } from "@azure/storage-blob";

// The connection half of the Azure file store, in the MODULE rather than in every application.
//
// Signum's counterpart is `Starter.AzureStorageConnectionString` plus the `GetClient` lambda each app writes
// in its Starter — i.e. Signum leaves this to the app because a C# app already has `BlobServiceClient` and
// its own configuration plumbing. altea puts the boring half here: an app supplies the CREDENTIALS (which
// stay in the environment, exactly as Signum keeps them in appsettings) and names its containers; caching
// the service client and the container clients is the module's business.
export interface AzureBlobStorageConfiguration {
    /** A full connection string — takes precedence over the account/key pair. */
    connectionString?: string | null;
    /** The storage account name (used with `accountKey`, or alone with a credential-less public account). */
    accountName?: string | null;
    accountKey?: string | null;
}

export namespace AzureBlobStorage {

    const services = new Map<string, BlobServiceClient>();
    const containers = new Map<string, ContainerClient>();

    /** The (cached) service client for a configuration. Throws with a precise message when it is incomplete. */
    export function service(config: AzureBlobStorageConfiguration): BlobServiceClient {
        const key = config.connectionString ?? `${config.accountName}:${config.accountKey}`;

        let client = services.get(key);
        if (client != undefined)
            return client;

        if (config.connectionString != null && config.connectionString !== "")
            client = BlobServiceClient.fromConnectionString(config.connectionString);
        else if (config.accountName != null && config.accountName !== "" && config.accountKey != null && config.accountKey !== "")
            client = new BlobServiceClient(
                `https://${config.accountName}.blob.core.windows.net`,
                new StorageSharedKeyCredential(config.accountName, config.accountKey));
        else
            throw new Error("AzureBlobStorage: the configuration needs a connectionString, or an accountName"
                + " + accountKey pair.");

        services.set(key, client);
        return client;
    }

    /** The (cached) container client of one named container. */
    export function container(config: AzureBlobStorageConfiguration, containerName: string): ContainerClient {
        const key = `${config.connectionString ?? config.accountName}/${containerName}`;

        let client = containers.get(key);
        if (client == undefined) {
            client = service(config).getContainerClient(containerName);
            containers.set(key, client);
        }
        return client;
    }

    /** Azure container names accept only lower-case letters, digits and hyphens (3-63 chars). */
    export function containerNameOf(storeName: string, prefix?: string): string {
        const clean = storeName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
        return (prefix == null || prefix === "" ? clean : `${prefix}-${clean}`).substring(0, 63);
    }
}
