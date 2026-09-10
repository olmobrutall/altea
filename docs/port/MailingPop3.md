# Signum.Mailing.Pop3 → @altea/altea-mailing-pop3

Port ledger — see [Rest.md](Rest.md) for what belongs here rather than in the source.

Source: `old/Framework/Extensions/Signum.Mailing.Pop3/`

Receiving over POP3: one implementation of altea-email's abstract `EmailReceptionServiceEntity`, plus the
poll that turns a mailbox into `EmailMessageEntity` rows.

## The substrate: MailKit becomes ~200 lines over `node:tls`, and MIME becomes mailparser

MailKit has no equivalent on Node worth taking: the POP3 packages on npm are thin, unmaintained wrappers
over exactly the exchange `Pop3Client` implements. POP3 is a line protocol with five commands — and the
one thing that IS subtle is handled once, in `readMultiline`: a multi-line response ends with a lone `.`,
and a line of body text that happens to start with `.` is byte-stuffed to `..` (RFC 1939 §3).

- **only IMPLICIT TLS is offered** (`enableSSL` → connect with TLS, conventionally on port 995), matching
  what Signum actually passes: `Connect(host, port, true)` or `SecureSocketOptions.None`. STARTTLS (`STLS`)
  is NOT ported, because Signum never asks for it.
- **the socket is read as Latin-1.** POP3 is a byte protocol and a message body may be any encoding at
  all; decoding as UTF-8 would corrupt the bytes before the MIME parser (which reads the charset) ever
  sees them, and latin-1 is the one encoding that round-trips every byte. Lines are re-joined with CRLF,
  which is what the message was transmitted with and what a MIME parser expects.
- **`Pop3Capabilities.UIDL` becomes a `CAPA` probe with a fallback**: a server that does not implement CAPA
  at all (it is optional in RFC 2449) is still asked for UIDL, and it is the UIDL response that decides.
  Signum throws on the capability flag; this throws on the same condition one round-trip later, which is
  strictly more permissive and never wrong.
- **MailKit's message indices are 0-based; the WIRE is 1-based.** `MessageUid.number` keeps Signum's
  0-based index (it is what the reception log stores) and every command adds one.
- **a clean QUIT is what commits the DELEs** — a POP3 server only applies them then; RSET-on-drop is the
  server's behaviour otherwise.
- **the client returns RAW bytes**, where `client.GetMessage(...)` returned a parsed `MimeMessage`, so the
  protocol and the MIME mapping stay separable (`MimeToEmailMessage.ts`).

## The transaction structure is kept exactly

It is the point of `Pop3ConfigurationLogic`, and `Transaction.forceNew` appears where Signum's
`Transaction.ForceNew` does:

- the reception ROW is written in its own transaction UP FRONT, so a crash mid-poll still leaves a record
  of the attempt;
- each message is stored in its OWN transaction, so one bad message becomes an `EmailReceptionException`
  instead of losing the batch;
- the summary is written in a third.

## Divergences

- **`MList<ClientCertificationFileEmbedded>` becomes this owner's `@part` ROW**, with NO `@rowOrder`:
  Signum does not mark that MList `[PreserveOrder]`, so its table has no Order column and neither does
  this one. (The SMTP sender's twin says the same.)
- **the `EnableSSL` port flip moves to the CLIENT.** Signum's setter flips `Port` between 995 and 110;
  altea entities are plain field bags with no setters, so the port is a plain field with Signum's own
  default (110) and the checkbox does the flip where the user can see it — and only when it is TOGGLED, so
  a deliberately unusual port is not overwritten on every deserialization, which the setter would do.
- **`newPassword` is folded in by the Save operation** (`registerEmailReceptionServiceSave`), where Signum
  uses a JSON property converter. Signum declares the field too, `[Ignore]`.
- `[NumberIsValidator(GreaterThanOrEqualTo, -1)]` — `-1` means "no timeout" — becomes a `@validate`, the
  shape altea-chart / altea-scheduler already use for the same attribute.
- `OperationLogic.AllowSave<EmailMessageEntity>()` has no counterpart (altea has no save GUARD an operation
  must lift); a message is saved directly.
- **Signum has TWO `SaveEmail` overloads, one of them dead code** (nothing calls the 3-argument one). Only
  the live `ref bool anomalousReception` version is ported.
- `Pop3ConfigurationLogic.CancelationToken` (a module-level static) is dropped: the ScheduledTaskContext's
  own signal is the cancellation, and it is already threaded through.
- **`AreDuplicates` compares recipients by `GetHashCode()`**; altea has no value hash on an entity, so it
  compares the ADDRESS + KIND pairs, which is what that hash was over.
- **the `rawContent` an exception carried in its `Data` bag has no counterpart** (altea's ExceptionEntity
  has no data bag): the raw MIME is on the reception info of every message that WAS stored, and a message
  that failed to parse names its uid in the logged error instead.
- **the server-copy delete stamp is a retrieve + save, not a set-based UnsafeUpdate.**
  `EmailReceptionInfoEmbedded.uniqueId` carries a UNIQUE INDEX, so there is at most one row — and a single
  retrieve + save says the same thing through the mixin ACCESSOR, which a set-based setter object cannot
  reach (a mixin's fields are flattened onto the owner at runtime but deliberately absent from its TYPE).
- the RECEPTION side's own editors (EmailReceptionConfiguration / EmailReception) live in
  @altea/altea-email's `MailingReceptionClient`, as they do in Signum.Mailing.

## The two inbox-comparison modes

Both are Signum's and both are kept, because they answer the same question at very different costs:

- **`CompareInbox.Full`** asks the database whether each server uid is already stored — chunked, because an
  `IN (…)` over a whole mailbox is not a query anyone wants.
- **`LastNEmails`** instead finds the newest already-received message that is STILL on the server and takes
  what came after it: cheap, and enough for a mailbox that is polled regularly. The first ever poll takes
  only the last N, so a years-old mailbox does not arrive all at once; and when nothing already-stored is
  still on the server, it was all deleted, so everything there is gets taken.

`AssignEntities` is what makes a re-received copy cheap: a message already in the database reuses the
ORIGINAL's links — its target, its stored attachment FILES, and the email-owner each address resolved to.
Without it a duplicate would re-upload every attachment and lose whatever the app had associated.

## Not ported

**TNEF (`winmail.dat`) unpacking on reception** — Signum's MailKit gives it for free.
