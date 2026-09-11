# Signum.Files.AzureBlobs / .S3 → @altea/altea-files-azure, @altea/altea-files-s3

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Files.AzureBlobs/`, `old/Framework/Extensions/Signum.Files.S3/`

Two `IFileTypeAlgorithm` implementations whose store is remote. They share every structural divergence,
because all of them follow from the store being a network away.

## What a REMOTE store cannot do

- **`RenameAlgorithm` is REFUSED, not silently ignored.** The collision probe is a network round-trip, and
  altea assigns the suffix in a SYNCHRONOUS hook before the INSERT — so a rename decided later could not be
  written back to a row that already carries the old suffix. Signum defaults it to null in both backends
  and says why on the field: *"ExistBlob is too slow, consider using CalculateSuffix with a GUID!"* — which
  is exactly what the default suffix generator does. Declaring the option and throwing means passing one
  FAILS instead of being ignored.
- **`readAllBytesSync` THROWS.** There is no synchronous read of a remote blob or object. The one altea
  caller that needs it is `BigStringLogic` (from the synchronous `retrieved` event), so **a BigString
  column must not be backed by either store**.
- **`SaveFile` / `SaveFileAsync` collapse into the TWO-PHASE save** altea-files defines: `prepareSuffix`
  (SYNC — validate, hash, assign the suffix/key, so the row can be INSERTed with it) and `writePrepared`
  (ASYNC — upload on `Transaction.preRealCommit`, so a rollback leaves no orphan). Signum ships both a sync
  and an async version of one method.
- **`MoveFile` throws** — neither store has a rename. Signum throws there too.
- **the chunked-upload API is not ported at all** (StartUpload / UploadChunk / FinishUpload / AbortUpload),
  because altea-files has no chunk protocol: a file reaches the server inside the entity graph. Azure's
  `stageBlock` / `commitBlockList` and S3's `CreateMultipartUploadCommand` are what to reach for if it ever
  lands.

## The CONNECTION half lives in the module

Signum leaves it to the app — `Starter.AzureStorageConnectionString` plus the `GetClient` lambda each
Starter writes — because a C# app already has `BlobServiceClient` / the AWS SDK and its own configuration
plumbing. altea puts the boring half in the module: an app supplies the CREDENTIALS (which stay in the
environment, exactly as Signum keeps them in appsettings) and names its containers/buckets; caching the
service client and the per-container clients is the module's business.

Container and bucket names are validated at registration — both services accept only lower-case letters,
digits and hyphens. Southwind hits the same rule by hand, since it passes the configured folder straight to
`new BlobContainerClient`.

## Azure-specific

- `Azure.Storage.Blobs` → `@azure/storage-blob`: `BlobContainerClient` → `ContainerClient`,
  `blobClient.Upload(stream, headers)` → `blockBlobClient.upload(body, length, { blobHTTPHeaders })`,
  `client.GetBlobs(new GetBlobsOptions { Prefix })` → `listBlobsFlat({ prefix })`.
- **the SAS credential is read publicly.** Signum reads the account key out of the client by COMPILED
  REFLECTION (an Expression over the private `ClientConfiguration.SharedKeyCredential`) so the app needn't
  repeat its credentials just to sign a SAS token. The JS SDK exposes the same thing as
  `StorageClient.credential`, so `fullWebPath` reads it straight off the client — same intent, no
  reflection.
- SAS signing is SYNC in the JS SDK, so it stays in `fullWebPath`. Signum's 5 minutes of backdating is kept
  (it absorbs clock skew against the service), and `Resource = "b"` is implied by passing a blob name.
- **the Defender poll's timeout ends the same way as a bad verdict**, made explicit: Signum's loop cannot
  exit any other way, so a verdict that never arrives falls into the same catch and the blob goes. The
  point is that an upload must not be reported as successful while a file Defender has not cleared is
  sitting in the container.
- Signum swallows `ContainerAlreadyExists` — two hosts racing to create it is not an error. Kept.
- `GetAsString` (download a blob as text) has no caller and is not ported.

## S3-specific

- `AWSSDK.S3` → `@aws-sdk/client-s3` (v3): every `client.XxxAsync(...)` becomes
  `client.send(new XxxCommand({...}))`, and `GetObjectResponse.ResponseStream` becomes
  `response.Body.transformToByteArray()`. `DoesS3BucketExistV2Async` becomes a `HeadBucketCommand`, which
  is what it does under the covers.
- **the PRESIGNED url is `presignedUrl()`, not `fullWebPath()`**, because SigV4 presigning is ASYNCHRONOUS
  in the v3 SDK. `fullWebPath` says so rather than quietly returning nothing; `DirectUrl` is unaffected.
  (Azure's SAS signing is sync, which is why its equivalent stays in `fullWebPath`.) Signum's
  `https:` → `http:` fixup is not needed: v3 signs against the endpoint's own scheme.
- `AmazonS3Config { ServiceURL, ForcePathStyle, RegionEndpoint }` becomes the `S3ClientConfig` object
  literal, and `BasicAWSCredentials` / `SessionAWSCredentials` collapse into one `credentials` object — the
  session token being present is what makes them temporary.
- `config.UseHttp` has no v3 counterpart and needs none: the SDK derives the scheme from the endpoint URL.
- **v3 REQUIRES a region** even against a MinIO endpoint that ignores it, so an endpoint-only configuration
  falls back to `"us-east-1"` (what every S3-compatible server accepts) instead of failing with the SDK's
  own "Region is missing" at the first call.
- **the endpoint fixup keeps Signum's transposed `433`.** An endpoint given without a scheme is prefixed
  from the PORT, because that is how OpenShift's object-bucket claim exposes it (BUCKET_HOST +
  BUCKET_PORT). Signum tests `Port == 433`; a deployment relying on that would break silently if it were
  "corrected", so 433 is kept and 443 accepted too.
- **the delete narrows Signum's bare `catch { }`** to the one case that legitimately means "already gone",
  so a permission problem is not hidden as a no-op. The create still swallows
  `BucketAlreadyOwnedByYou` / `BucketAlreadyExists`, as Signum does.
- `SharedBucketName` and `CreateBucket` are carried on the configuration exactly as in Signum (the
  algorithm reads them), even though the configuration class does not use them itself.

## The two S3 addressing modes

Kept as they are, because they are the reason the class is not just "bucket + key":

- **bucket mode** — `getBucketNameOrSubDirectory` names the BUCKET, the key is the suffix.
- **shared-bucket mode** — `sharedBucketName` is the one bucket everybody shares and
  `getBucketNameOrSubDirectory` becomes a key PREFIX (a per-tenant folder).

What that means for the stored row: `suffix` holds the key WITHOUT the prefix, so moving a tenant between
modes does not rewrite its rows — `getBucketAndKey` re-derives the full key on every access.

## Option-name correspondence

Both classes keep Signum's option names, so a registration reads the same in either framework.

| Signum | altea | notes |
| --- | --- | --- |
| `GetClient` / `IAmazonS3 Client` | `getClient` / `client` | |
| `WebDownload` | `webDownload` | default `None` |
| `CalculateSuffix` / `CalculateKey` | `calculateSuffix` / `calculateKey` | default `Safe.yearMonth_Guid_Filename` — its GUID is what makes the refused `RenameAlgorithm` unnecessary |
| `WeakFileReference` | `weakFileReference` | the app does not own these blobs: never write, never delete |
| `CreateBlobContainerIfNotExists` / `CreateBucketIfNotExists` | same, camelCased | |
| `GetBlobAction` | `getBlobAction` | default Download, or Open when `onlyImages` is set |
| `SASTokenExpires` | `sasTokenExpires` | ms; default 15 min |
| `GetCacheControl` | `getCacheControl` | |
| `AzureDefenderPolling` | `azureDefenderPolling` | ms, where Signum's `TotalWaitTime` / `PollInterval` are TimeSpans |
| (S3) hard-coded 15 min | `presignedUrlExpiresSeconds` | seconds |
| `RenameAlgorithm` | declared, THROWS | see above |

`GetProperties`, `ReadAllBytes`/`OpenRead`, `ExistsObject`/`ExistsBlob`, `UpdateHttpHeaders`,
`GetFullPhysicalPath`, `GetFullWebPath` and `GetBlobHttpHeaders` all keep their names too (camelCased).
`ExistsBlob` is kept even though the rename loop that used it is gone: it is the one question a caller may
still want to ask, and Signum's prefix listing is cheaper than a 404-per-probe.
