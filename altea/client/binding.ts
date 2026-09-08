// Client form-binding (Signum's Binding), extracted from Reflection.ts. Reads/writes a value at a
// member path so a Line can edit one property of an entity graph. Swept to altea:
//   - setValue sets NO `.modified` flag (altea is snapshot-based; isDirty() reflects the write).
//   - getError computes LIVE from the field's validators via FieldInfo.validate (the same method
//     entityIntegrityCheck uses) — no stored error side-table.
//   - collections are plain arrays: a collection element binds by numeric index (no MListElement).

import { BaseEntity } from '../data/entity';
import { resolveField } from '../data/reflection';
import { setParentEntity } from '../data/parentEntity';
import { getLambdaMembers, getFieldMembers } from '../data/lambdaMembers';
import type { LambdaMember, MemberType } from '../data/lambdaMembers';
import type { Quoted } from 'quote-transformer/quoted';

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

  static create<F, T>(parentValue: F, fieldAccessor: Quoted<(from: F) => T>): Binding<T> {
    const memberName = Binding.getSingleMember(fieldAccessor);
    return new Binding<T>(parentValue, memberName, "." + memberName);
  }

  static getSingleMember(fieldAccessor: Quoted<(from: any) => any>): string {
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
    this.bindParentOfValue(val);
  }

  /**
   * altea's counterpart of the property setter Signum hooks. Signum stamps the parent back-pointer from
   * `Set(ref field, value)` and again from `ChildCollectionChanged`, and needs `[BindParent]` partly so
   * those two know which fields to act on. Here there is ONE funnel for every write a form makes — a
   * scalar, a reference, and a collection too, because EntityListBase's add/remove mutate the array and
   * then call `setValue(list)` — so the two mechanisms collapse into this.
   *
   * It is what makes the LIVE rules work: a `@validate` or an `@isReadOnly` on a child that reads its
   * owner has to answer while the user is still building the graph, before any save or round-trip.
   *
   * The whole array is re-stamped on a collection write rather than just the new element: `setValue` is
   * handed the same array every time, so there is no diff to work from, and a stamp is a WeakMap set over
   * a list the UI is rendering anyway.
   */
  private bindParentOfValue(val: unknown): void {
    if (val == null || typeof this.member !== "string" || !(this.parentObject instanceof BaseEntity))
      return;
    if (resolveField(this.parentObject, this.member)?.bindParent !== true)
      return;

    for (const child of Array.isArray(val) ? val : [val])
      if (child instanceof BaseEntity)
        setParentEntity(child, this.parentObject, this.member);
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
    // Through `resolveField`, not `TypeInfo.fields`: a MIXIN's field is not on the owner's TypeInfo, so the
    // direct lookup answered undefined for one and its validators — the implicit NotNull included — never
    // ran in the live pass at all. The server enforced them, so the user only found out on save.
    const fi = resolveField(parent, String(this.member));
    // Live per-field validation runs in the "Client" environment (the browser, before send) — so a
    // validator disabled on the client (`disabled: env => env === "Client"`) stays quiet here and is
    // only enforced server-side.
    return fi?.validate(parent, "Client") ?? undefined;
  }

  // Server ModelState errors are applied per-binding as a forced override (there is no entity-level
  // error store to write to).
  setError(value: string | undefined): void {
    this.forceError = value;
  }

  // Signum's `Binding.getIsReadonly`, which reads the `propsMeta` array the server computed for this
  // instance. altea resolves it LOCALLY through `FieldInfo.isReadOnlyFor` (@isReadOnly on the field, then
  // the class-level ones): those all live in the isomorphic data layer, so the same rules run
  // on both tiers — so the answer is re-evaluated on every RENDER and follows the entity in hand, where
  // Signum's array is fixed at serialization, and it holds for an entity the client just constructed,
  // which never had a propsMeta at all. The server applies the same resolver as a write gate
  // (data/serializer), so nothing rests on the client honouring it.
  //
  // A numeric member is a collection INDEX, which no rule names.
  getIsReadonly(): boolean {
    if (typeof this.member !== "string" || !(this.parentObject instanceof BaseEntity))
      return false;

    // A member with no FieldInfo is not a reflected field: there is nothing for a field-level rule to
    // hang off and nothing for a class-level rule to be asked ABOUT, since both are keyed by FieldInfo.
    return resolveField(this.parentObject, this.member)?.isReadOnlyFor(this.parentObject) ?? false;
  }

  // Signum reads `"!" + member` out of the same propsMeta, and its ONLY writer is property
  // authorization — there is no entity-level visibility hook to mirror. altea-auth enforces that
  // dimension through its own line task and `PropertyRoute.isAllowedCallback` (see AuthAdminClient), so
  // this stays false rather than growing a second path to the same answer.
  getIsHidden(): boolean { return false; }
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
// MOVED to entities/lambdaMembers.ts (so PropertyRoute.addLambda can use it); re-exported here so
// binding's existing importers (TypeContext, QueryTokenString, FindOptions, EntityTable…) are unchanged.
export { getLambdaMembers, getFieldMembers };
export type { LambdaMember, MemberType };
