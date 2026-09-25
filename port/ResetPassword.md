# Signum.Authorization.ResetPassword → @altea/altea-auth-reset-password

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Authorization.ResetPassword/`

A single-use, time-limited code mailed to a user so they can set a new password without being logged in.
Three ANONYMOUS endpoints — ask for a link, consume a link, ask for a fresh link — and every path runs with
authorization DISABLED, because the caller is by definition not logged in.

## `isValid()` / `isExpired()` are QUERY-ONLY

Signum declares them `[ExpressionField] bool`, which in .NET works both ways. Here they are `@quoted`
methods — altea's one form for "a body that is both an in-memory function and a SQL expression" — but the
comparison inside is a RELATIONAL OPERATOR on Temporal values, which the LINQ provider translates and
JavaScript does not support (Temporal deliberately has no `valueOf`).

So the in-memory answer comes from `validate()`, which does the same comparison through
`Temporal.PlainDateTime.compare`. Signum needs no such split because .NET's `DateTime` supports both.

`Validate()` (Signum's entity-level hook) stays a plain method: it is a MESSAGE for the caller, not a field
validation, and altea has no entity-level PropertyValidation hook anyway.

## Divergences

- **`Random.Shared.NextString(32)` → `node:crypto` `randomBytes` → base64url**, and it moves to the logic
  layer (server-only). The code is a BEARER CREDENTIAL, so `Math.random()` would be a real weakness rather
  than a style choice.
- **`EmailModel<T>` classes** → the same two server classes (`ResetPasswordRequestEmail`, `UserLockedMail`)
  extending altea-email's `EmailModel<T>`; their names are the registry rows.
- **`CultureInfoLogic.ForEachCulture(culture => …)`** → `CultureInfoLogic.applicationCultures()` mapped
  inside `CultureInfo.withCultures`, so each message's text is resolved in ITS culture.
- `out string? passwordError` becomes a returned object (TypeScript has no out parameters).
- `OperationLogic.AllowSave<UserEntity>()` has no counterpart (no RequiresSaveOperation guard).
- **`ex.LogException()` → `ExceptionLogic.logException(e)` inside `Transaction.forceNew`**: a log write
  must not ride the failed transaction — the lesson the scheduler and processes ports record.
- `[Required, FromBody] string code` (a bare JSON string body) is kept as a bare string body, so the
  client's `ajaxPost(url, code)` needs no wrapper object.
- **`ModelError(field, msg)` → `res.status(400).json({ field: msg })`**, altea's flat ModelState: a field
  maps to ONE message where Signum's is a `string[]`, and the server's 400 body has exactly that shape — so
  the client's `error(field)` is a direct lookup.
- `ChangeLogClient.registerChangeLogModule` has no counterpart; `LoginOptions` is imported from
  altea-auth's LoginPage (that is where the React-typed login options live — the AuthClient hub itself is
  React-free); `Link` comes from react-router directly rather than `react-router-dom`.
- Signum's `<AutoFocus>` wrapper has no counterpart, so the input carries `autoFocus` itself.

## A Signum typo fixed rather than mirrored

The forgot-password form declares `type="texbox"`, which no browser recognises, so it silently falls back
to `text`. Written as `type="email"` here, which is what it was meant to be.
