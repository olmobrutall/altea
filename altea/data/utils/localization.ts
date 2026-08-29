import { pluralize, detectGender, spacePascalOrUnderscores } from './naturalLanguage';
import { CultureInfo } from './cultureInfo';
import { Metadata } from '../metadata';
// Code-declared default-language nice names (the @niceName/@nicePluralName decorators, operation
// init({ niceName })). Stored in the import-free leaf; consulted BELOW any loaded translation, so a
// translation file for the current UI culture always wins.
import { getDefaultDescription } from '../registration';

// Re-exported from the import-free registration leaf so the quote-transformer can
// attach `registerObject` to the `msg` import in localization files (which don't
// import reflect) to auto-register msg() containers. The leaf imports nothing, so
// this does not create a cycle with reflection.
export { registerObject } from '../registration';

// The name-resolution ENGINE behind the display-name API. It is deliberately NOT the API: application
// and extension code never calls into here, it calls the fluent surface —
//
//   OrderEntity.niceName() / .nicePluralName() / .gender() / .newNiceName()
//   OrderEntity.nicePropertyName(a => a.orderNumber)   ·   AddressEmbedded.nicePropertyName(a => a.city)
//   Enum.niceName(ColorEnum, "Red")                    ·   Container.niceName(OrderOperation, "Ship")
//   fieldInfo.niceToString()                           ·   SomeMessage.SomeMember.niceToString()
//
// — which keeps the FileInfo-backed registration and the type parameters intact. Everything the engine
// exposes therefore sits under `Localization.Internal`, whose only legitimate callers are the four
// front-ends that implement that surface (data/entity, data/enum, data/container, data/reflection) plus
// the framework internals that hold a bare name (the LINQ provider lowering `Type.niceName()` to SQL).
// A `Localization.Internal.` in application code is a bug; the nesting makes it greppable.
//
// The translation STORE itself is not here at all — it lives in data/metadata (`Metadata.merge` /
// `Metadata.forCulture`), because nice names are one section of the per-culture, per-role metadata blob
// rather than a thing of their own. The culture context lives in `CultureInfo` (utils/cultureInfo).
//
// The one bare top-level export below is `msg` (and its LocalizableMessage): the quote-transformer
// detects hand-written `msg(...)` calls by that exact identifier, and authors write it bare.
export namespace Localization {

    export namespace Internal {

        // --- Type-level names --------------------------------------------------------------------

        // Human-readable name of a type, by its REGISTERED name (Signum's `Type.NiceName()`): the loaded
        // translation for the current UI culture, else the code-declared default (@niceName), else the
        // class name with a trailing "Entity" dropped and PascalCase split into words —
        // `GrammyAwardEntity` → "Grammy Award".
        export function typeNiceName(typeName: string): string {
            return typeDescription(typeName) ?? niceNameFromName(typeName);
        }

        // Plural of the type's nice name (Signum's `Type.NicePluralName()`). Signum runs a real
        // pluralizer keyed on the UI culture; altea uses a naive English "+s" stand-in for now (good
        // enough for the default query/expression display names — swap for a culture-aware one later).
        export function typeNicePluralName(typeName: string): string {
            return typePluralDescription(typeName)
                ?? pluralize(typeNiceName(typeName), CultureInfo.currentUICulture());
        }

        // Grammatical gender of a type (Signum's Type gender): the translation's Gender attribute, else
        // detected from the (localised) nice name for the current UI culture (English has none).
        export function typeNiceGender(typeName: string): string | undefined {
            return typeGender(typeName)
                ?? detectGender(typeNiceName(typeName), CultureInfo.currentUICulture());
        }

        // Display name of a new (unsaved) instance of this type (Signum's `Type.NewNiceName()`).
        export function typeNewNiceName(typeName: string): string {
            return "New " + typeNiceName(typeName);
        }

        // De-camelCase a raw type identifier into a display label: "GrammyAwardEntity" → "Grammy Award",
        // "FilterOperation" → "Filter Operation". The string-only core of `typeNiceName`, shared with the
        // `Enum` / `Container` helpers so their type names humanise identically.
        //
        // The suffix set is Signum's `Reflector.CleanTypeName` verbatim — Entity / Embedded / Model /
        // Symbol — which is what its `DefaultTypeDescription` humanises. NOTE this is the DISPLAY name
        // only: altea's own `cleanTypeName` (data/registration) strips "Entity" ALONE, because there it
        // is the reflection IDENTITY (the `$type` / `$lite` wire discriminator, TypeEntity.cleanName,
        // an @implementedBy column's suffix) and "CustomerModel" / "AddressEmbedded" must stay distinct
        // from any "Customer" / "Address" beside them.
        export function niceNameFromName(name: string): string {
            const raw = name.replace(/(Entity|Embedded|Model|Symbol)$/, "");
            return raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim();
        }

        // --- Member-level names ------------------------------------------------------------------

        // A property route's display name for the current UI culture, resolved: loaded translation →
        // code-declared default (a @niceName field decorator) → humanised identifier. `path` is a
        // `PropertyRoute.propertyString()`, so an embedded's member resolves under its OWNER
        // ("shipAddress.city"); when the owner carries no entry the LAST segment is humanised, which is
        // what a reader wants next to the field ("City", not "Ship Address City").
        export function routeNiceName(typeName: string, path: string): string {
            return tryRouteNiceName(typeName, path) ?? niceMemberName(lastSegment(path));
        }

        // As `routeNiceName`, but undefined when nothing is declared for the route (so a caller with its
        // own fallback — FieldInfo.niceToString, which humanises the field's own name — can use it).
        export function tryRouteNiceName(typeName: string, path: string): string | undefined {
            const fromBlob = Metadata.tryField(typeName, path)?.niceName;
            if (fromBlob != null)
                return fromBlob;
            // Signum's XML uses the PascalCase C# name; altea's members are camelCase. Probe both.
            const def = getDefaultDescription(typeName);
            return def?.members[path] ?? def?.members[capitalizePath(path)];
        }

        // Default display name of a member when nothing is declared (Signum's
        // DescriptionManager.DefaultMemberDescription → name.SpacePascalOrUnderscores()). altea member
        // identifiers are camelCase where Signum's C# names are PascalCase, so capitalise first:
        // "name" → "Name", "firstName" → "First Name", "isNew" → "Is New".
        export function niceMemberName(member: string): string {
            const pascal = member.charAt(0).toUpperCase() + member.slice(1);
            return spacePascalOrUnderscores(pascal);
        }

        // A CONTAINER member's translation (current UI culture): the XML <Member> under <Type
        // Name=container>. Used by the Enum helper (enum member names), messages (msg containers) and
        // symbol containers (operation labels) — their member names are already the PascalCase
        // identifiers the XML / key use. undefined when nothing is declared, so the caller picks its own
        // humanisation (Enum wants "In process", a message wants "be not null").
        export function translate(container: string, member: string): string | undefined {
            return Metadata.tryField(container, member)?.niceName
                ?? getDefaultDescription(container)?.members[member];
        }

        // --- Raw declared values (no humanisation fallback) ---------------------------------------
        // Loaded translation for the current UI culture, else the code-declared default. Used by the
        // metadata builder, which must OMIT a name that equals the humanised default rather than ship it.

        export function typeDescription(typeName: string): string | undefined {
            return Metadata.tryType(typeName)?.niceName ?? getDefaultDescription(typeName)?.description;
        }
        export function typePluralDescription(typeName: string): string | undefined {
            return Metadata.tryType(typeName)?.nicePluralName ?? getDefaultDescription(typeName)?.pluralDescription;
        }
        export function typeGender(typeName: string): string | undefined {
            return Metadata.tryType(typeName)?.gender ?? getDefaultDescription(typeName)?.gender;
        }

        // --- Messages ------------------------------------------------------------------------------

        export function lookup(msg: LocalizableMessage): string | undefined {
            if (msg.module == null || msg.member == null) return undefined;
            return translate(msg.module, msg.member);
        }

        // Infers a human-readable description from a member name.
        // Strips a leading '_', splits on PascalCase boundaries, lowercases,
        // and replaces each digit N with the placeholder {N}.
        // e.g. "_0IsNotSet" → "{0} is not set", "BeNotNull" → "be not null"
        export function inferDescription(member: string): string {
            const s = member.startsWith('_') ? member.slice(1) : member;
            const tokens: string[] = [];
            let i = 0;
            while (i < s.length) {
                const ch = s[i];
                if (ch >= '0' && ch <= '9') {
                    tokens.push(`{${ch}}`);
                    i++;
                    continue;
                }
                let word = ch.toLowerCase();
                i++;
                while (i < s.length && !(s[i] >= '0' && s[i] <= '9') && s[i] === s[i].toLowerCase()) {
                    word += s[i];
                    i++;
                }
                tokens.push(word);
            }
            // Sentence-case: capitalize the first letter of the whole description (Signum's NiceName), so a
            // PascalCase member reads "Enter your user name and password" / "Username", not all-lowercase.
            const text = tokens.join(' ');
            return text.charAt(0).toUpperCase() + text.slice(1);
        }
    }
}

// The last segment of a property path: "shipAddress.city" → "city", "[CorruptMixin].corrupt" → "corrupt".
function lastSegment(path: string): string {
    const i = Math.max(path.lastIndexOf("."), path.lastIndexOf("]"));
    return i < 0 ? path : path.slice(i + 1);
}

// Capitalize each dot/bracket-separated segment: "shipAddress.city" → "ShipAddress.City".
function capitalizePath(path: string): string {
    return path.replace(/(^|[.\]])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

// `msg` / LocalizableMessage stay bare top-level exports (NOT under Localization): the quote-transformer
// recognizes hand-written `msg(...)` calls by that exact identifier, and authors write it bare. (They
// can't move to the registration leaf — LocalizableMessage.niceToString depends on the translation
// lookups above, and the leaf must import nothing.)
export class LocalizableMessage {
    private _inferred?: string;

    constructor(
        readonly defaultDescription: string | undefined,
        readonly member: string | undefined,
        readonly module: string | undefined,
    ) { }

    niceToString(...args: unknown[]): string {
        const template = Localization.Internal.lookup(this) ?? this._getDefault();
        return args.length > 0 ? format(template, ...args) : template;
    }

    private _getDefault(): string {
        if (this.defaultDescription != null) return this.defaultDescription;
        if (this.member == null) return '?';
        return this._inferred ??= Localization.Internal.inferDescription(this.member);
    }
}

// Overload seen by developers — desc optional, member/module injected by transformer
export function msg(desc?: string): LocalizableMessage;
// Full signature used by transformer-generated code
export function msg(desc: string | undefined, member: string, module: string): LocalizableMessage;
export function msg(desc?: string, member?: string, module?: string): LocalizableMessage {
    return new LocalizableMessage(desc, member, module);
}

function format(template: string, ...args: unknown[]): string {
    return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}
