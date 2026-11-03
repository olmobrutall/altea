import type { PoolConfig } from "pg";
import { DefaultAzureCredential } from "@azure/identity";

// Connection setup for Azure Database for PostgreSQL: TLS is switched on for an Azure host, and without a
// password the connection signs in with an Azure AD token (az login, managed identity, …), renewed every
// 10 minutes and retried after 30 seconds.
export namespace AzurePostgres {

    // Runs first, on the parsed connection string and the config being built: it may rewrite the URL (a
    // placeholder user → the logged-in one, say) and set any PoolConfig field. A password it sets — in the
    // URL or in the config — replaces the Azure AD token.
    export type Configure = (url: URL, config: PoolConfig) => void;

    export function config(connectionString: string, configure?: Configure): PoolConfig {
        if (!URL.canParse(connectionString))
            return { connectionString };

        const url = new URL(connectionString);
        const config: PoolConfig = {};
        configure?.(url, config);

        // Azure only accepts TLS, and pg (unlike Npgsql's `Ssl Mode=Require` in the Signum settings) uses
        // it only when told to. `verify-full` is what pg 8 makes of `require` anyway, minus its warning.
        if (url.hostname.endsWith(".postgres.database.azure.com") && !url.searchParams.has("sslmode"))
            url.searchParams.set("sslmode", "verify-full");

        config.connectionString = url.toString();
        if (url.password == "" && config.password == null)
            config.password = periodicToken();
        return config;
    }

    const refresh = 10 * 60 * 1000;
    const retry = 30 * 1000;

    function periodicToken(): () => Promise<string> {
        const credential = new DefaultAzureCredential();
        let token: string | undefined;
        let next = 0;

        return async () => {
            if (token == undefined || Date.now() >= next) {
                try {
                    token = (await credential.getToken("https://ossrdbms-aad.database.windows.net/.default")).token;
                    next = Date.now() + refresh;
                } catch (e) {
                    if (token == undefined)
                        throw e;
                    next = Date.now() + retry;
                }
            }
            return token;
        };
    }
}
