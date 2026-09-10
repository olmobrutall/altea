# Signum.Authorization.OpenID / .WindowsAD → @altea/altea-auth-openid, @altea/altea-auth-windowsad

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Authorization.OpenID/`,
`old/Framework/Extensions/Signum.Authorization.WindowsAD/`

Two of the three DIRECTORY login modules. `@altea/altea-auth-azuread` is the third and shares everything
structural below; it has no page here yet.

## ONE authorizer, ONE shared base

Signum copies ~120 lines of "match / create / update the local user + resolve the role" into each of
`AzureADAuthorizer`, `OpenIDAuthorizer` and `WindowsADAuthorizer`. altea factors them into
`altea-auth/server/ADAuthorizer` (`ADAuthorizer<TConfig>`), leaving each module only:

- the claim NAMES it reads, and
- ONE overridable hook, `getDirectoryGroups` — the only thing that genuinely differs.

So `ExtractRoles` becomes `directoryGroups`, feeding altea-auth's single role-mapping implementation
instead of a per-module copy, and "find or create the local user" is `ADAuthorizer.findOrCreateUser`.

The shared BaseAD half — the configuration embedded, `IAutoCreateUserContext`, `ExternalUser`,
`IDirectoryInviter`, the find/create-AD-user routes, the invite-a-user UI, `ProfilePhoto.urlProviders` —
likewise lives in altea-auth, exactly as it does in `Signum.Authorization`.

**`AuthLogic.authorizer` is a single slot**, so at most ONE directory owns the login flow; the app picks
(eastwind: `EASTWIND_AD_PROVIDER`). Signum leaves wiring it to the application's Starter; altea does it in
each module's `start`, because the authorizer is what every route in the module resolves its configuration
through — so `start(sb, getConfig)` is the ONE call a host makes.

## No server-rendered configuration blob

Signum injects the browser-visible configuration into `Index.cshtml` (`window.__openIDConfig`,
`window.__azureADConfig`). altea has no server-rendered page, so each module serves it from an ANONYMOUS
endpoint the client fetches once at boot — which makes `registerOpenIDAuthenticator` /
`registerAzureADAuthenticator` **async**, and makes them SELF-GATING: a module that is not configured
answers null and stands down.

`Options.getOpenIDConfig` stays as the override seam, so a host can still supply it another way.

That same payload carries the provider ENDPOINTS, so starting the redirect needs no extra round trip where
Signum calls `/api/auth/openIDEndpoints` at click time. The endpoints route is kept anyway, since a client
may need to re-read them after a provider change.

`Reflection.isStarted()` (Signum's "call me before autoLogin" guard) has no counterpart; the ordering
requirement is documented on `registerOpenIDAuthenticator` instead.

## OpenID

- **`ConfigurationManager<OpenIdConnectConfiguration>` + `JwtSecurityTokenHandler`** → altea-auth's
  `OpenIdConnect` helper: a discovery cache plus `jose` over a locally fetched JWKS, so OpenID's
  `avoidSSLVerify` applies to the JWKS request too. Same checks — signature against the published keys,
  issuer, audience, lifetime.
- **`ClaimsPrincipal` → the verified JWT payload** (a plain claims object). `GetClaim` / `TryGetClaim`
  become property reads; a claim that is an ARRAY (some providers repeat `email`) takes its first string,
  which is what `SingleOrDefaultEx` over ASP.NET's claim collection effectively did for the single-valued
  claims read here.
- `AuthServer.OnUserPreLogin` / `AddUserSession` → `UserHolder.setCurrent` + `AuthServer.userLogged`, which
  is what altea's AuthServer login route does.
- `PropertyValidation` override → per-field `@validate`: `authority` and `clientId` are required once
  `enabled`. `GetScopes()` / `GetDiscoveryEndpoint()` stay on the entity — pure string work over its own
  fields, needed by both the server and the config DTO.
- **`ToOpenIDConfigTS()`** becomes the `OpenIDClientConfig` interface, served by the anonymous endpoint.
- **`Lite.RegisterLiteModelConstructor`** is NOT ported: altea has no lite-model entity, so a
  `Lite<UserEntity>` carries just its id and toString. Nothing here needs the external id off a lite.
- **`ReflectionServer.RegisterLike(typeof(UserADMessage) / typeof(OpenIDMessage), …)`** is NOT ported:
  altea's message containers are plain objects bundled with the client, not blob entries.

### One Signum bug fixed rather than mirrored

**`OpenIDCallback`'s ternary was inverted**, so a successful callback showed "Error" and a failure showed
the spinner. The port renders the failure on the error branch and keeps the message, rather than only
rethrowing.

## Windows AD

`System.DirectoryServices` becomes LDAP (`ldapts`, in `altea-auth-windowsad/server/WindowsDirectory`):

| Signum | altea |
| --- | --- |
| `pc.ValidateCredentials(user, pass, ContextOptions.Negotiate)` | a simple bind |
| `UserPrincipal.GetGroups(pc)` | `LDAP_MATCHING_RULE_IN_CHAIN` — a plain `memberOf` read would silently miss NESTED groups |
| `Enabled` | `userAccountControl` bit 2 |
| `userName.TryBeforeLast('@') ?? userName.TryAfter('\\') ?? userName` | the sAMAccountName inside a UPN or a domain-qualified name |

The `objectSid` byte layout is formatted to the exact `S-1-5-…` string `externalId` stores.

Login order is Signum's and worth keeping: **the local database first** (a DB round trip beats an LDAP
bind), then the directory.

### What does NOT port: integrated authentication

Windows INTEGRATED authentication (SPNEGO / Kerberos) does not port — **Node has no SSPI**. It is an
injected seam (`WindowsADServer.negotiateProvider`, null by default → a clear error); everything else in
the module works without it. `AuthClient.Options.disableWindowsAuthentication` becomes a flag that skips
the silent attempt.

The silent path must return **null, not raise**, where Signum's `throwErrors ? throw … : false` decides per
call.

## Both

- `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(…)`; the Lines come from
  their own modules (there is no `@framework/Lines` barrel);
  `formGroupHtmlAttributes={{ style: { display: "block" } }}` is `inlineCheckbox="block"`.
- `PermissionLogic.RegisterTypes(typeof(ActiveDirectoryPermission))` — the same container, registered
  through altea's own permission registry.
- The admin (configuration) client is registered from **MainAdmin**, so an anonymous visitor never loads
  that chunk.
