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
    expect(resultNorm.startsWith(headerNorm)).toBe(true);
    const body = resultNorm.slice(headerNorm.length).trim();
    expect(body).toBe(normalize(expected));
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
    @field({ type: () => Person, typeName: "Person", nullable: true, lite: true }) bestFriend!: Lite<Person> | null;
    @field({ type: () => Person, typeName: "Person", array: true }) otherFriends!: Person[];
}`
        );
    });

    test('auto-injects @field for @entity classes', () => {
        assertFieldTransform(
            `function ignore(_value: undefined, _context: ClassFieldDecoratorContext): void { }
@entity
class PersonEntity {
    name!: string;
    age!: number;
    static count: number;
    @ignore hidden!: string;
}`,
            `function ignore(_value: undefined, _context: ClassFieldDecoratorContext): void { }
@entity
class PersonEntity {
    @field({ typeName: "String" }) name!: string;
    @field({ typeName: "Number" }) age!: number;
    static count: number;
    @ignore hidden!: string;
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
    @field({ type: () => EmployeeEntity, typeName: "EmployeeEntity", nullable: true, lite: true }) manager!: Lite<EmployeeEntity> | null;
    @field({ type: () => EmployeeEntity, typeName: "EmployeeEntity", array: true }) reports!: EmployeeEntity[];
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
    @field({ typeName: "Number", name: "int" }) quantity!: int;
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
    @field({ typeName: "Number", name: "int", nullable: true, array: true }) nums!: (int | null)[];
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
    @field({ type: () => Color, typeName: "Color", enum: true }) color!: Color;
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
        expect(normalize(transformSource(
            `import { reflect } from "./reflection";
@reflect
class Person {
    name!: string;
}`
        ))).toBe(normalize(
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
        expect(normalize(transformSource(
            `enum Sex { Male, Female }
registerEnum(Sex);`
        ))).toBe(normalize(
            `const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
enum Sex { Male, Female }
registerEnum(Sex, "Sex", __fileInfo);`
        ));
    });

    test('manual registerObject(X) gets the name + __fileInfo injected', () => {
        expect(normalize(transformSource(
            `registerObject(SomeMessage);`
        ))).toBe(normalize(
            `const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
registerObject(SomeMessage, "SomeMessage", __fileInfo);`
        ));
    });

    test('same-file enum referenced by a reflected field is auto-registered', () => {
        expect(normalize(transformSource(
            `import { reflect } from "./reflection";
enum Sex { Male, Female }
@reflect
class ArtistEntity {
    sex!: Sex;
}`
        ))).toBe(normalize(
            `import { reflect, field, registerType, registerEnum } from "./reflection";
const __fileInfo = { packageName: "quote-test", fileName: "__test__.ts" };
enum Sex { Male, Female }
@reflect
class ArtistEntity {
    @field({ type: () => Sex, typeName: "Sex", enum: true }) sex!: Sex;
}
registerType(ArtistEntity, "ArtistEntity", __fileInfo);
registerEnum(Sex, "Sex", __fileInfo);`
        ));
    });

    test('already-augmented registerEnum is left untouched (idempotent)', () => {
        expect(normalize(transformSource(
            `registerEnum(Sex, "Sex", "pkg", "f.ts");`
        ))).toBe(normalize(
            `registerEnum(Sex, "Sex", "pkg", "f.ts");`
        ));
    });

    test('unrelated single-arg calls are not augmented', () => {
        expect(normalize(transformSource(
            `doSomething(Sex);`
        ))).toBe(normalize(
            `doSomething(Sex);`
        ));
    });

});
