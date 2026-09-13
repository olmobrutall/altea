import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { SubTokensOptions, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import {
    GraphFieldUsage, MicrosoftGraphQueryConverter,
} from "@altea/altea-auth-azuread/server/MicrosoftGraphQueryConverter";
import { ActiveDirectoryUsersRowModel } from "@altea/altea-auth-azuread/data/ActiveDirectoryQueries";
import { MessageMicrosoftGraphQueryConverter } from "../server/RemoteEmailsLogic";
import { RemoteEmailMessageRowModel } from "../data/RemoteEmailMessage";

// The token → Microsoft Graph FIELD NAME translation, for both converters.
//
// This is the one part of the Graph integration that cannot be checked any other way without a tenant: the
// `$select` / `$filter` / `$orderby` strings only fail against the live API, and they fail as an opaque
// 400. So the names are pinned here against the documented Graph resource fields
// (https://learn.microsoft.com/en-us/graph/api/resources/message and /user).
//
// The rule the whole file exists to hold down: **a query TOKEN key is PascalCase
// (`EntityPropertyToken.key` is `fieldInfo.name.firstUpper()`), a GRAPH field is camelCase.**
// `toGraphField` is the crossing, and it lowers each key — Signum's own `a.Key.FirstLower()`, a line this
// port had dropped back when altea's token key was the camelCase field name verbatim.

const O = SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll;

/** A token by its PascalCase path, as a stored column/filter names it. */
function tok(root: RootToken, path: string): QueryToken {
    let t: QueryToken = root;
    for (const step of path.split(".")) {
        const next = t.subToken(step, O);
        assert.ok(next != undefined, `'${step}' of '${path}' did not resolve — is the key PascalCase?`);
        t = next;
    }
    return t;
}

describe("toGraphField — the message converter", () => {

    const conv = new MessageMicrosoftGraphQueryConverter();
    const root = new RootToken(RemoteEmailMessageRowModel);
    const field = (path: string, usage = GraphFieldUsage.Select) => conv.toGraphField(tok(root, path), usage);

    test("a plain column is Graph's camelCase field", () => {
        assert.equal(field("Subject"), "subject");
        assert.equal(field("IsRead"), "isRead");
        assert.equal(field("IsDraft"), "isDraft");
        assert.equal(field("HasAttachments"), "hasAttachments");
        assert.equal(field("ReceivedDateTime"), "receivedDateTime");
        assert.equal(field("SentDateTime"), "sentDateTime");
        assert.equal(field("CreatedDateTime"), "createdDateTime");
        assert.equal(field("LastModifiedDateTime"), "lastModifiedDateTime");
        assert.equal(field("Categories"), "categories");
    });

    // The row model cannot call it `id` — a member of that name is excluded from a query's token tree —
    // so the token is `MessageId` and Graph's field is `id`.
    test("MessageId is Graph's id", () => {
        assert.equal(field("MessageId"), "id");
    });

    // A folder column collapses to the id Graph filters on, whatever member was named.
    test("any Folder column collapses to parentFolderId", () => {
        assert.equal(field("Folder"), "parentFolderId");
        assert.equal(field("Folder.DisplayName"), "parentFolderId");
    });

    // RecipientEmbedded's two members live under Graph's `emailAddress` complex property.
    test("a recipient's members map under emailAddress", () => {
        assert.equal(field("From.EmailAddress"), "from/emailAddress/address");
        assert.equal(field("From.Name"), "from/emailAddress/name");
    });

    // ...and that mapping is keyed to the MEMBER, as Signum's `PropertyEquals(ept.PropertyInfo,
    // piEmailAddress)` is — not to how the assembled field happens to END, which is what this used to do
    // (`.replace(/\/name$/, "/emailAddress/name")`). A suffix rule is right for this row model only because
    // nothing else in it has a member called `name`, which is a fact about today's model rather than about
    // the rule; today it cannot even be made to misfire from this root, so the check is made against a
    // FOREIGN one.
    test("a same-named member on another type is left alone", () => {
        const other = new RootToken(ActiveDirectoryUsersRowModel);
        assert.equal(conv.toGraphField(tok(other, "DisplayName"), GraphFieldUsage.Select), "displayName");
        assert.equal(conv.toGraphField(tok(other, "OnPremisesExtensionAttributes.ExtensionAttribute1"),
            GraphFieldUsage.Filter), "onPremisesExtensionAttributes/extensionAttribute1");
    });

    test("every field is camelCase — no key survives PascalCase", () => {
        for (const p of ["Subject", "IsRead", "ReceivedDateTime", "From.EmailAddress", "MessageId", "Categories"])
            assert.doesNotMatch(field(p), /(^|\/)[A-Z]/, `${p} leaked a PascalCase segment`);
    });
});

describe("the token-keyed guards around it", () => {

    const conv = new MessageMicrosoftGraphQueryConverter();
    const root = new RootToken(RemoteEmailMessageRowModel);

    // `getSelect` drops the Extension columns (they arrive through $expand, not $select). The predicate is
    // on the TOKEN key, so PascalCase — and `Extension` and `extension` are the same length, which is why
    // the index parse survived either spelling.
    test("Extension columns are dropped from $select and drive $expand", () => {
        const cols = ["Subject", "Extension0"].map(p => ({ token: tok(root, p) })) as any;
        assert.deepEqual(conv.getSelect(cols), ["subject"]);

        // Inert until an app names its extended properties, which is the documented default.
        assert.equal(conv.getExpand(cols), null);
    });

    test("a non-Graph column is recognised by its PascalCase token key", () => {
        // `inMicrosoftGraph` is private; the rule it encodes is that Entity/User are altea-side columns.
        // Asserting the KEYS is what catches a camelCase regression, since that is what it compares.
        assert.equal(tok(root, "User").fullKey(), "User");
        assert.equal(tok(root, "Subject").fullKey(), "Subject");
    });
});

describe("toGraphField — the base converter (directory search)", () => {

    const conv = new MicrosoftGraphQueryConverter();
    const root = new RootToken(ActiveDirectoryUsersRowModel);
    const field = (path: string, usage = GraphFieldUsage.Select) => conv.toGraphField(tok(root, path), usage);

    test("a plain column is Graph's camelCase field", () => {
        assert.equal(field("DisplayName"), "displayName");
        assert.equal(field("UserPrincipalName"), "userPrincipalName");
        assert.equal(field("JobTitle"), "jobTitle");
    });

    // The alias table is in GRAPH vocabulary, so it is applied AFTER the key is lowered.
    test("ObjectId is Graph's id", () => {
        assert.equal(field("ObjectId"), "id");
    });

    // Graph only lets you $select the whole complex property, never one of its members — and that check
    // reads the BUILT field, so it stays camelCase.
    test("an extension attribute collapses for $select but not for $filter", () => {
        assert.equal(field("OnPremisesExtensionAttributes.ExtensionAttribute1"), "onPremisesExtensionAttributes");
        assert.equal(field("OnPremisesExtensionAttributes.ExtensionAttribute1", GraphFieldUsage.Filter),
            "onPremisesExtensionAttributes/extensionAttribute1");
    });
});
