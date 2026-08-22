import { S3Client } from "@aws-sdk/client-s3";

// Port of Signum.Files.S3's S3Configuration.cs — the strongly typed "how do we reach the object store"
// settings, plus the factory that turns them into a client. Reads the same shape Signum documents:
//
//   "S3": {
//     "Endpoint": "http://localhost:9000",
//     "AccessKey": "…",
//     "SecretKey": "…",
//     "ForcePathStyle": "true"
//   }
//
// altea divergences, documented inline:
//  - `AWSSDK.S3` (C#) -> `@aws-sdk/client-s3` (v3, for JS): `AmazonS3Config { ServiceURL, ForcePathStyle,
//    RegionEndpoint }` becomes the `S3ClientConfig` object literal, and `BasicAWSCredentials` /
//    `SessionAWSCredentials` collapse into the one `credentials: { accessKeyId, secretAccessKey, sessionToken? }`
//    (the session token being present is what makes them temporary credentials).
//  - `config.UseHttp` has no v3 counterpart and needs none: the SDK derives the scheme from the endpoint URL,
//    which is also why the presigner needs no `https:` -> `http:` fixup (see S3FileTypeAlgorithm.fullWebPath).
//  - `RegionEndpoint.GetBySystemName(Region)` becomes the plain `region` string the v3 client takes.
//  - v3 REQUIRES a region even when talking to a MinIO endpoint that ignores it, so an endpoint-only
//    configuration falls back to "us-east-1" (what every S3-compatible server accepts) instead of failing
//    with the SDK's own "Region is missing" at the first call.
//  - `SharedBucketName` and `CreateBucket` are carried here exactly as in Signum (the algorithm reads them),
//    even though this class does not use them itself.

export interface S3Configuration {
    /** S3 endpoint URL, e.g. `http://localhost:9000` (MinIO). Empty for real AWS. */
    endpoint?: string | null;
    /** AWS Access Key. */
    accessKey?: string | null;
    /** AWS Secret Key. */
    secretKey?: string | null;
    /** Port, for an endpoint given WITHOUT a scheme — OpenShift's OBC exposes BUCKET_HOST / BUCKET_PORT that
     *  way (Signum's own comment). */
    port?: number | null;
    /** AWS Session Token (optional — its presence means temporary credentials). */
    sessionToken?: string | null;
    /** AWS Region, e.g. `eu-west-1`. */
    region?: string | null;
    /** Forces path-style URLs (`endpoint/bucket/key` instead of `bucket.endpoint/key`). Default true. */
    forcePathStyle?: boolean;
    /** Used in multi-tenant scenarios to share ONE bucket, each tenant getting a key prefix. */
    sharedBucketName?: string | null;
    createBucket?: boolean | null;
}

/**
 * Signum's `S3Configuration.ToAmazonS3Client()` — the client for these settings, or null when no credentials
 * are configured at all (which is Signum's way of saying "this app is not using S3"). Supplying only one half
 * of the key pair is an error, not a fallback to anonymous access.
 */
export function toS3Client(config: S3Configuration): S3Client | null {
    if (!config.accessKey && !config.secretKey)
        return null;

    if (!config.accessKey || !config.secretKey)
        throw new Error("S3 configuration must provide both accessKey and secretKey.");

    const endpoint = resolveEndpoint(config);

    return new S3Client({
        forcePathStyle: config.forcePathStyle ?? true,
        credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
            ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
        },
        ...(endpoint != null ? { endpoint } : {}),
        // See the header: v3 insists on a region even where the server ignores it.
        region: config.region || (endpoint != null ? "us-east-1" : undefined),
    });
}

/**
 * Signum's endpoint fixup: an endpoint given without a scheme is prefixed from the PORT, because that is how
 * OpenShift's object-bucket claim exposes it (BUCKET_HOST + BUCKET_PORT). Note Signum's `Port == 433` — the
 * transposed 443 — is kept, because a deployment relying on it would otherwise break silently; 443 is
 * accepted too.
 */
export function resolveEndpoint(config: S3Configuration): string | undefined {
    const endpoint = config.endpoint;
    if (!endpoint)
        return undefined;

    if (/^https?:/i.test(endpoint) || config.port == null)
        return endpoint;

    const scheme = config.port === 443 || config.port === 433 ? "https://" : "http://";
    return scheme + endpoint;
}


// The connection half, kept in the MODULE so an application supplies only credentials and names.
// `toS3Client` above builds a client per call; these two cache it and hold the bucket-name convention, which
// is what every app would otherwise re-write (Signum leaves both to the app because a C# app already has the
// SDK and its own configuration plumbing).
export namespace S3Storage {

    const clients = new Map<string, S3Client>();

    /** The (cached) client for a configuration. Throws with a precise message when credentials are missing. */
    export function client(config: S3Configuration): S3Client {
        const key = `${config.endpoint ?? ""}|${config.accessKey ?? ""}|${config.region ?? ""}`;

        let result = clients.get(key);
        if (result != undefined)
            return result;

        result = toS3Client(config) ?? undefined as unknown as S3Client;
        if (result == undefined)
            throw new Error("S3Storage: the configuration needs accessKey + secretKey"
                + " (and an endpoint for a non-AWS server such as MinIO).");

        clients.set(key, result);
        return result;
    }

    /** S3 bucket names accept only lower-case letters, digits and hyphens. */
    export function bucketNameOf(storeName: string, prefix?: string): string {
        const clean = storeName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
        return prefix == null || prefix === "" ? clean : `${prefix}-${clean}`;
    }
}
