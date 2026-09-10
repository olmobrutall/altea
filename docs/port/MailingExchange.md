# Signum.Mailing.ExchangeWS → @altea/altea-mailing-exchange

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Mailing.ExchangeWS/`

One more implementation of "how do we send", alongside altea-email's own SMTP one.

## The substrate: the EWS Managed API becomes hand-built SOAP

Signum uses `Microsoft.Exchange.WebServices.Data`, a .NET-only library with no JS counterpart worth taking:
the JS ports of it are unmaintained and an order of magnitude larger than the three requests this module
actually makes. EWS is a plain SOAP 1.1 endpoint, so — exactly as altea-auth-azuread turned
`Microsoft.Graph` into plain REST — `server/ExchangeWebServices.ts` speaks it directly:

| request | what for |
| --- | --- |
| `CreateItem` | save or send a message |
| `CreateAttachment` | add one file to a saved draft |
| `SendItem` | send the draft |

`message.Send()` is not one request when there are attachments, and neither is this: EWS ignores an
`<Attachments>` element inside `CreateItem`, so the Managed API does CreateItem(SaveOnly) →
CreateAttachment per file → SendItem, and so does `sendWithAttachments`. With no attachments it is the
single CreateItem(SendAndSaveCopy) the Managed API also uses.

Two protocol details that are easy to get wrong and are kept deliberately:

- **`t:Message` is an xsd SEQUENCE** (Subject, Body, Attachments, … ToRecipients, CcRecipients,
  BccRecipients, … From), so Exchange rejects a message whose elements arrive out of order. The child order
  in `buildMessage` is not cosmetic.
- **every CreateAttachment bumps the parent's ChangeKey**, and SendItem needs the CURRENT one — so it is
  read back from the attachment's `RootItemId`, which is where EWS reports it.

## What does NOT port: integrated Windows authentication

`service.UseDefaultCredentials = true` means SPNEGO / Kerberos or NTLM. Node has no SSPI, and the native
modules that can do it are Windows-only node-gyp builds — the same wall altea-auth-windowsad hit for
integrated sign-in. So `ExchangeWebServices.negotiateProvider` is a SEAM, null by default: with none
installed, a service configured `useDefaultCredentials` fails with a clear message instead of silently
POSTing unauthenticated (which Exchange answers with a 401 and no explanation).

```ts
ExchangeWebServices.negotiateProvider = async url => ({ Authorization: await mySspi.token(url) });
```

Username + password (Basic over HTTPS, which is what `new WebCredentials(user, pass)` sends against a
modern Exchange) works with no provider at all.

## Autodiscover

The Managed API tries SCP lookup, the two well-known POX URLs, an unauthenticated GET redirect and a DNS
SRV record, in that order. **Only the two POX URLs are ported** (plus the `RedirectUrl` / `RedirectAddr`
responses they may return) — they are what works outside a domain-joined machine, and the SRV path needs a
DNS resolver this module has no other use for. A deployment the POX URLs cannot reach should configure
`url` explicitly, which is the common case anyway.

`RedirectionUrlValidationCallback` is kept verbatim in spirit: a redirect is followed ONLY to https,
because the credentials ride the very next request. Redirect hops are bounded, because a misconfigured
deployment can loop.

`Protocol` repeats in an Autodiscover response — EXCH (internal) / EXPR (external) / WEB — and the first
one carrying an `EwsUrl` wins, which is what the Managed API settles on for a client that is going to speak
EWS.

## Divergences

- **`ExchangeVersion` is SENT, where Signum ignores it.** Signum hard-codes
  `new ExchangeService(ExchangeVersion.Exchange2007_SP1)` and then never reads the entity's own field — it
  is stored, shown in the editor, and does nothing. altea sends it as the `RequestServerVersion` header,
  because a stored setting that does nothing is a bug, not a feature: picking the schema version is the
  whole point of the field.
- **the enum IS the protocol value.** Signum registers `ExchangeVersion` as an EXTERNAL enum
  (`DescriptionManager.ExternalEnums.Add`) so its .NET members get nice names; altea has no Exchange SDK to
  borrow it from, so it is declared here with the same members — and per altea's enum convention its wire
  value IS the member name, which is exactly the string
  `<t:RequestServerVersion Version="…"/>` wants. `ReflectionServer.OverrideIsNamespaceAllowed` (making the
  external enum's namespace visible) therefore has no counterpart either: altea ships ONE metadata blob
  whose per-type visibility already follows the type's own authorization.
- **`newPassword` is a REAL field.** Signum's server ADDS it as a virtual JSON property whose read handler
  encrypts into `Password`; altea declares a `@column(false)` field (what altea-email's own SMTP service
  already does) and the Save operation folds it in through `registerEmailServiceSave`. That also fixes the
  editor: Signum binds `password`, whose value the server never sends and whose typed value is not what is
  read back — so the field looks editable but is not the one being edited. Here the stored password is
  shown read-only and what you type goes into `newPassword`.
- **`AssertImplementedBy` is a CHECK, not a mutation.** `@implementedBy` lives on the field, and widening
  it must happen on BOTH TIERS before anything is (de)serialized — so the APP does it in its shared
  entity-overrides module and `start` fails loudly if that was forgotten. (Signum's `AssertImplementedBy`
  is likewise only an assertion.)
- **`From` is not set on the message**, as in Signum: Exchange sends as the authenticated mailbox, and
  setting it would need "Send As" rights the configuration says nothing about. `email.from` is still the
  address AUTODISCOVER looks up.
- **only real attachments are attached.** Signum drops LinkedResources (inline images) even though it sets
  their ContentId. Kept — changing it would silently alter what recipients receive — and noted because it
  looks like an oversight in the original and a reader will wonder.
- `ToEmailAddress()` (the extension pair honouring OverrideEmailAddress / SendEmails) is `mailbox()` /
  `recipientMailbox()`, matching altea's own SmtpSender.
- `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(…)`; Signum's `start`
  also takes `routes`, which this module never adds to.

## Reading the XML

A SOAP fault carries the real reason (a bad version header, a permission problem, …) in the BODY with an
HTTP 500, so it must be read out rather than surfaced as "request failed with 500". EWS also reports
per-item failures INSIDE a 200 response, as `ResponseClass="Error"` plus a MessageText.

`XmlElement` is a thin read-only wrapper over what `fast-xml-parser` produced: responses are read at three
or four known paths, and a parsed-object walk with `?.[0]?.["x"]` at every step is unreadable. Namespace
prefixes (s:/m:/t:) are stripped on parse — they are noise for a reader looking for one element by local
name — and an id lives in ATTRIBUTES only, so a text-only element must stay a string and never a parsed
number.
