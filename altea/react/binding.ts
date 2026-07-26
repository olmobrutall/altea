// Client form-binding (Signum's Binding), extracted from Reflection.ts. Reads/writes a value at a
// member path so a Line can edit one property of an entity graph. Swept to altea:
//   - setValue sets NO `.modified` flag (altea is snapshot-based; isDirty() reflects the write).
//   - getError computes LIVE from the field's validators via FieldInfo.validate (the same method
//     entityIntegrityCheck uses) — no stored error side-table.
//   - collections are plain arrays: a collection element binds by numeric index (no MListElement).

import { BaseEntity } from '../entities/entity';
import { tryGetTypeInfo } from '../entities/reflection';

export interface IBinding<T> {
  getValue(): T;
  setValue(val: T): void;
  suffix: string;
  getIsReadonly(): boolean;
  getIsHidden(): boolean;
  getError(): string | undefined;
  setError(value: string | undefined): void;
}

export class Binding<T> implements IBinding<T> {

  initialValue: T; // For deep compare
  suffix: string;
  constructor(
    public parentObject: any,
    public member: string | number,
    suffix?: string) {
    this.initialValue = this.parentObject[member];
    this.suffix = suffix || ("." + member);
  }

  static create<F, T>(parentValue: F, fieldAccessor: (from: F) => T): Binding<T> {
    const memberName = Binding.getSingleMember(fieldAccessor);
    return new Binding<T>(parentValue, memberName, "." + memberName);
  }

  static getSingleMember(fieldAccessor: (from: any) => any): string {
    const members = getLambdaMembers(fieldAccessor);
    if (members.length != 1 || members[0].type != "Member")
      throw Error("invalid function 'fieldAccessor'");
    return members[0].name;
  }

  getValue(): T {
    if (!this.parentObject)
      throw new Error(`Impossible to get '${this.member}' from '${this.parentObject}'`);
    return this.parentObject[this.member];
  }

  setValue(val: T): void {
    if (!this.parentObject)
      throw new Error(`Impossible to set '${this.member}' from '${this.parentObject}'`);
    // ALTEA: no `.modified` flag — snapshot-based isDirty() reflects this write.
    this.parentObject[this.member] = val;
    this.initialValue = val;
  }

  deleteValue(): void {
    if (!this.parentObject)
      throw new Error(`Impossible to delete '${this.member}' from '${this.parentObject}'`);
    delete this.parentObject[this.member];
  }

  forceError: string | undefined;

  // ALTEA: entities carry no `.error` map. The validation error is computed LIVE from the field's
  // validators (FieldInfo.validate — shared with entityIntegrityCheck), so it can never drift.
  getError(): string | undefined {
    if (this.forceError)
      return this.forceError;
    const parent = this.parentObject;
    if (!(parent instanceof BaseEntity))
      return undefined;
    const fi = tryGetTypeInfo(parent)?.fields[String(this.member)];
    return fi?.validate(parent) ?? undefined;
  }

  // Server ModelState errors are applied per-binding as a forced override (there is no entity-level
  // error store to write to).
  setError(value: string | undefined): void {
    this.forceError = value;
  }

  getIsReadonly(): boolean { return false; } // TODO: property-level readonly from the reflection types blob.
  getIsHidden(): boolean { return false; }   // TODO: property-level visibility from the reflection types blob.
}

export class ReadonlyBinding<T> implements IBinding<T> {
  constructor(
    public value: T,
    public suffix: string) {
  }

  getValue(): T { return this.value; }
  setValue(val: T): void { throw new Error("Readonly Binding"); }
  getIsReadonly(): boolean { return true; }
  getIsHidden(): boolean { return false; }
  getError(): string | undefined { return undefined; }
  setError(value: string | undefined): void { }
}

export function createBinding(parentValue: any, lambdaMembers: LambdaMember[]): IBinding<any> {

  if (lambdaMembers.length == 0)
    return new ReadonlyBinding<any>(parentValue, "");
  let suffix = "";
  let val = parentValue;

  const lastIsIndex = lambdaMembers[lambdaMembers.length - 1].type == "Indexer";

  for (let i = 0; i < lambdaMembers.length - (lastIsIndex ? 2 : 1); i++) {
    const member = lambdaMembers[i];
    switch (member.type) {
      case "Member":
        val = val[member.name];
        suffix += "." + member.name;
        break;
      case "Mixin":
        // altea inlines mixin fields onto the entity (entity.mixin() returns `this`).
        suffix += "[" + member.name + "]";
        break;
      case "Indexer":
        val = val[parseInt(member.name)];
        suffix += "[" + member.name + "]";
        break;
      default: throw new Error("Unexpected " + member.type);
    }
  }

  const lastMember = lambdaMembers[lambdaMembers.length - 1];
  switch (lastMember.type) {
    case "Member": return new Binding(val, lastMember.name, suffix + "." + lastMember.name);
    case "Mixin": return new ReadonlyBinding(val, suffix + "[" + lastMember.name + "]");
    case "Indexer": {
      // ALTEA: a collection is a plain array — bind the element by numeric index (no MListElement).
      const preLastMember = lambdaMembers[lambdaMembers.length - 2];
      const array = val[preLastMember.name];
      return new Binding(array, parseInt(lastMember.name), suffix + "." + preLastMember.name + "[" + lastMember.name + "]");
    }
    default: throw new Error("Unexpected " + lastMember.type);
  }
}

// ---- Member-path parsing (Signum's getLambdaMembers / getFieldMembers) --------------------------

const functionRegex = /^function\s*\(\s*(?<param>[$a-zA-Z_][0-9a-zA-Z_$]*)\s*\)\s*{\s*(\"use strict\"\;)?\s*(var [^;]*;)?\s*return\s*(?<body>[^;]*)\s*;?\s*}$/;
const lambdaRegex = /^\s*\(?\s*(?<param>[$a-zA-Z_][0-9a-zA-Z_$]*)\s*\)?\s*=>\s*(({\s*(\"use strict\"\;)?\s*(var [^;]*;)?\s*return\s*(?<body>[^;]*)\s*;?\s*})|(?<body2>[^;]*))\s*$/;
const memberRegex = /^(.*?)\??\.([$a-zA-Z_][0-9a-zA-Z_$]*)$/;
const memberIndexerRegex = /^(.*?)(\?\.)?\["([$a-zA-Z_][0-9a-zA-Z_$]*)"\]$/;
const indexRegex = /^(.*?)(\?\.)?\[(\d+)\]$/;

export function getLambdaMembers(lambda: Function): LambdaMember[] {

  const lambdaStr = (lambda as any).toString();

  const lambdaMatch = functionRegex.exec(lambdaStr) || lambdaRegex.exec(lambdaStr);

  if (lambdaMatch == undefined)
    throw Error("invalid function");

  const parameter = lambdaMatch.groups!.param;
  let body = lambdaMatch.groups!.body ?? lambdaMatch.groups!.body2;
  const result: LambdaMember[] = [];

  while (body != parameter) {
    let m: RegExpExecArray | null;

    if (m = memberRegex.exec(body)) {
      result.push({ name: m[2], type: "Member" });
      body = m[1];
    }
    else if (m = memberIndexerRegex.exec(body)) {
      result.push({ name: m[3], type: "Member" });
      body = m[1];
    }
    else if (m = indexRegex.exec(body)) {
      result.push({ name: m[3], type: "Indexer" });
      body = m[1];
    }
    else {
      throw new Error(`Impossible to extract the properties from: ${body}` +
        (body.contains("Mixin") ? "\n Consider using subCtx(MyMixin) directly." : ""));
    }
  }

  return result.reverse();
}

export function getFieldMembers(field: string): LambdaMember[] {
  if (field.contains(".")) {
    const mixinType = field.before(".").after("[").before("]");
    const fieldName = field.after(".");
    return [
      { type: "Mixin", name: mixinType },
      { type: "Member", name: fieldName.firstLower() }
    ];
  } else {
    return [
      { type: "Member", name: field.firstLower() }
    ];
  }
}

export interface LambdaMember {
  name: string;
  type: MemberType;
}

export type MemberType = "Member" | "Mixin" | "Indexer";
