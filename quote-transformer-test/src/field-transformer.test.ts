import { describe, test } from "vitest";
import * as assert from 'node:assert/strict';
import { transformSource, normalize } from './transform-utils';

// Declares field and entity without imports — the transformer identifies decorators
// by name, so no module resolution is needed for @field/@entity to work.
const FIELD_HEADER = `
declare function field(value: undefined, context: ClassFieldDecoratorContext): void;
declare function field(options: { typeName: string; name?: string; nullable?: boolean; lite?: boolean; array?: boolean; enum?: boolean; }): (value: undefined, context: ClassFieldDecoratorContext) => void;
declare function entity(...args: any[]): any;
class Lite<T> {}
`;

let cachedPrintedFieldHeader: string | null = null;
function getPrintedFieldHeader(): string {
    if (cachedPrintedFieldHeader === null)
        cachedPrintedFieldHeader = transformSource(FIELD_HEADER);
    return cachedPrintedFieldHeader;
}

// Asserts a field-related transformation. The FIELD_HEADER (field/entity declarations + Lite<T>)
// is prepended automatically so test bodies don't need to redeclare those.
function assertFieldTransform(input: string, expected: string): void {
    const result = transformSource(FIELD_HEADER + input);
    const headerNorm = normalize(getPrintedFieldHeader());
    // A registration-bearing file emits one `const __fileInfo = new FileInfo(...)`
    // (inserted after imports). Remove that deterministic declaration wherever it
    // lands so the header stays the prefix; the trailing __fileInfo.register*(...)
    // calls remain part of the asserted body.
    const fileInfoDecl = `const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };`;
    const resultNorm = normalize(normalize(result).replace(fileInfoDecl, ''));
    assert.strictEqual(resultNorm.startsWith(headerNorm), true);
    const body = resultNorm.slice(headerNorm.length).trim();
    assert.strictEqual(body, normalize(expected));
}

describe('field-transformer', () => {

    test('field decorator infers runtime type', () => {
        assertFieldTransform(
            `class Person {
    @field isActive!: boolean;
    @field dateOfBirth!: Date;
    @field dateOfDeath!: Date | null;
    @field bestFriend!: Lite<Person> | null;
    @field otherFriends!: Person[];
}`,
            `class Person {
    @field({ typeName: "Boolean" }) isActive!: boolean;
    @field({ typeName: "Date" }) dateOfBirth!: Date;
    @field({ typeName: "Date", nullable: true }) dateOfDeath!: Date | null;
    @field({ type: () => Person, nullable: true, lite: true }) bestFriend!: Lite<Person> | null;
    @field({ type: () => Person, array: true }) otherFriends!: Person[];
}`
        );
    });

    test('auto-injects @field for @entity classes', () => {
        assertFieldTransform(
            `@entity
class PersonEntity {
    name!: string;
    age!: number;
    static count: number;
    @field(false) hidden!: string;
}`,
            `@entity
class PersonEntity {
    @field({ typeName: "String" }) name!: string;
    @field({ typeName: "Number" }) age!: number;
    static count: number;
    @field(false) hidden!: string;
}
registerType(PersonEntity, "PersonEntity", __fileInfo);`
        );
    });

    test('auto-injects @field with options for generic types in @entity classes', () => {
        assertFieldTransform(
            `@entity
class EmployeeEntity {
    name!: string;
    manager!: Lite<EmployeeEntity> | null;
    reports!: EmployeeEntity[];
}`,
            `@entity
class EmployeeEntity {
    @field({ typeName: "String" }) name!: string;
    @field({ type: () => EmployeeEntity, nullable: true, lite: true }) manager!: Lite<EmployeeEntity> | null;
    @field({ type: () => EmployeeEntity, array: true }) reports!: EmployeeEntity[] = [];
}
registerType(EmployeeEntity, "EmployeeEntity", __fileInfo);`
        );
    });

    test('field decorator resolves primitive type aliases to typeName + name', () => {
        assertFieldTransform(
            `type int = number;
class Order {
    @field quantity!: int;
    @field price!: number;
}`,
            `type int = number;
class Order {
    @field({ typeName: "Number", subTypeName: "int" }) quantity!: int;
    @field({ typeName: "Number" }) price!: number;
}`
        );
    });

    test('field decorator handles nullable element in container', () => {
        assertFieldTransform(
            `type int = number;
class Order {
    @field nums!: (int | null)[];
    @field tags!: string[];
}`,
            `type int = number;
class Order {
    @field({ typeName: "Number", subTypeName: "int", nullable: true, array: true }) nums!: (int | null)[];
    @field({ typeName: "String", array: true }) tags!: string[];
}`
        );
    });

    test('field decorator handles enum types', () => {
        assertFieldTransform(
            `enum Color { Red, Green, Blue }
class Item {
    @field color!: Color;
    @field name!: string;
}`,
            `enum Color { Red, Green, Blue }
class Item {
    @field({ type: () => Color }) color!: Color;
    @field({ typeName: "String" }) name!: string;
}`
        );
    });

    test('field decorator handles field-level nullable', () => {
        assertFieldTransform(
            `class Order {
    @field amount!: number | null;
    @field middleName!: string | null;
    @field nums!: number[] | null;
}`,
            `class Order {
    @field({ typeName: "Number", nullable: true }) amount!: number | null;
    @field({ typeName: "String", nullable: true }) middleName!: string | null;
    @field({ typeName: "Number", array: true }) nums!: number[] | null;
}`
        );
    });

    test('@field(false) suppresses auto-inject', () => {
        assertFieldTransform(
            `@entity
class Order {
    @field(false) name!: string;
    amount!: number;
}`,
            `@entity
class Order {
    @field(false) name!: string;
    @field({ typeName: "Number" }) amount!: number;
}
registerType(Order, "Order", __fileInfo);`
        );
    });

    // Auto-inject adds 'field' and 'registerType' to whichever import already
    // brings in 'reflect' (they live in the same module as reflect), and appends
    // the registerType(...) call with the resolved package + relative file.
    test('auto-inject adds field/registerType to the import that contains reflect', () => {
        assert.strictEqual(normalize(transformSource(
            `import { reflect } from "./reflection";
@reflect
class Person {
    name!: string;
}`
        )), normalize(
            `import { reflect, field, registerType } from "./reflection";
const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
@reflect
class Person {
    @field({ typeName: "String" }) name!: string;
}
registerType(Person, "Person", __fileInfo);`
        ));
    });

    // A reflected class gets field(...) injected, and with no import from the reflection module there is
    // nothing to anchor the 'field' import on. tsc has already checked by the time the call is injected,
    // so it reports nothing: the emit references an undefined binding and the first sign is a
    // ReferenceError when the module loads, far from the file that caused it.
    test('injecting field with no reflection import to anchor on is a transform-time error', () => {
        assert.throws(
            () => transformSource(
                `import { entity } from "./decorators";
@entity
class Person {
    name!: string;
}`
            ),
            /injected field\(\.\.\.\) but the file has no value import from the reflection module/);
    });

    // The anchor is the MODULE, not the 'reflect' binding: an @entity / @part file has no reason to
    // import 'reflect' (see the redundancy tests below), so anchoring on that name would leave it with
    // nothing to hang 'field' and 'registerType' on.
    test('field/registerType anchor on any value import from the reflection module', () => {
        assert.strictEqual(normalize(transformSource(
            `import { part } from "./decorators";
import { Quoted } from "./reflection";
@part
class Person {
    name!: string;
}`
        )), normalize(
            `import { part } from "./decorators";
import { Quoted, field, registerType } from "./reflection";
const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
@part
class Person {
    @field({ typeName: "String" }) name!: string;
}
registerType(Person, "Person", __fileInfo);`
        ));
    });

});

// @entity and @part both route through defineEntity, which does the same getOrCreateTypeInfo +
// registerType that @reflect does, and this transformer injects @field for all three names alike. Any
// two of them on one class is the same declaration written twice — rejected, rather than left to drift
// into rival spellings that a reader has to tell apart.
describe('a class declares exactly one of @reflect / @entity / @part', () => {

    test('@reflect + @part is a transform-time error', () => {
        assert.throws(
            () => transformSource(
                `import { reflect } from "./reflection";
import { part } from "./decorators";
@reflect
@part
class Person {
    name!: string;
}`
            ),
            /class Person carries @reflect and @part/);
    });

    test('@reflect + @entity(...) is a transform-time error', () => {
        assert.throws(
            () => transformSource(
                `import { reflect } from "./reflection";
import { entity } from "./decorators";
@reflect
@entity("Main", "Transactional")
class Person {
    name!: string;
}`
            ),
            /class Person carries @reflect and @entity/);
    });

    // @part IS @entity("Part"), so the two together are not a kind plus a refinement — they are two
    // kinds, and the one that wins is whichever decorator happens to run last.
    test('@entity(...) + @part is a transform-time error too', () => {
        assert.throws(
            () => transformSource(
                `import { entity, part } from "./decorators";
@entity("Main", "Transactional")
@part
class Person {
    name!: string;
}`
            ),
            /class Person carries @entity and @part/);
    });

    test('all three together names all three', () => {
        assert.throws(
            () => transformSource(
                `import { reflect } from "./reflection";
import { entity, part } from "./decorators";
@reflect
@entity("Main", "Transactional")
@part
class Person {
    name!: string;
}`
            ),
            /carries @reflect, @entity and @part/);
    });

    test('the order of the decorators does not matter', () => {
        assert.throws(
            () => transformSource(
                `import { reflect } from "./reflection";
import { part } from "./decorators";
@part
@reflect
class Person {
    name!: string;
}`
            ),
            /carries @part and @reflect/);
    });

    test('@reflect on its own is still accepted', () => {
        assert.strictEqual(normalize(transformSource(
            `import { reflect } from "./reflection";
@reflect
class Person {
    name!: string;
}`
        )), normalize(
            `import { reflect, field, registerType } from "./reflection";
const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
@reflect
class Person {
    @field({ typeName: "String" }) name!: string;
}
registerType(Person, "Person", __fileInfo);`
        ));
    });

});

describe('location registration calls', () => {

    test('manual registerEnum(X) gets the name + __fileInfo injected', () => {
        assert.strictEqual(normalize(transformSource(
            `enum Sex { Male, Female }
registerEnum(Sex);`
        )), normalize(
            `const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
enum Sex { Male, Female }
registerEnum(Sex, "Sex", __fileInfo);`
        ));
    });

    test('manual registerObject(X) gets the name + __fileInfo injected', () => {
        assert.strictEqual(normalize(transformSource(
            `registerObject(SomeMessage);`
        )), normalize(
            `const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
registerObject(SomeMessage, "SomeMessage", __fileInfo);`
        ));
    });

    test('same-file enum referenced by a reflected field is auto-registered', () => {
        assert.strictEqual(normalize(transformSource(
            `import { reflect } from "./reflection";
enum Sex { Male, Female }
@reflect
class ArtistEntity {
    sex!: Sex;
}`
        )), normalize(
            `import { reflect, field, registerType, registerEnum } from "./reflection";
const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
enum Sex { Male, Female }
@reflect
class ArtistEntity {
    @field({ type: () => Sex }) sex!: Sex;
}
registerType(ArtistEntity, "ArtistEntity", __fileInfo);
registerEnum(Sex, "Sex", __fileInfo);`
        ));
    });

    test('already-augmented registerEnum is left untouched (idempotent)', () => {
        assert.strictEqual(normalize(transformSource(
            `registerEnum(Sex, "Sex", "pkg", "f.ts");`
        )), normalize(
            `registerEnum(Sex, "Sex", "pkg", "f.ts");`
        ));
    });

    test('unrelated single-arg calls are not augmented', () => {
        assert.strictEqual(normalize(transformSource(
            `doSomething(Sex);`
        )), normalize(
            `doSomething(Sex);`
        ));
    });

});
