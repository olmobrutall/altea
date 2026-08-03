// STUB — NOT a faithful copy-and-fix (unlike the rest of the Operations cluster). Signum's 561-line
// MultiPropertySetter is built on the name-based client type-resolution altea DELIBERATELY REMOVED in
// T3 (`tryGetTypeInfos(name)` / `getTypeInfos` → `TypeReference.typeInfos()`), plus it needs new
// OperationMessages (BulkModifications/AddSetter/Operation/Condition/Setters), `PropertyOperation`/
// `FilterOperation` niceToString via the Enum helper, `member.isIgnoredEnum`, and several PropertyRoute
// method deltas. That is a re-engineering against altea's model, not a transform — so the full port is
// DEFERRED (TODO(port)). `show()` resolves to no setters, i.e. a bulk operation runs without the
// property-setter dialog (a safe degradation). See operations-client-port memory.
import type { TypeInfo, OperationInfo } from '../Reflection';
import type { Lite } from '../../data/lite';
import type { Entity } from '../../data/entity';
import type { PropertyRoute } from '../../data/propertyRoute';
import type { Operations } from '../Operations';

export interface PropertySetterComponentProps {
  root: PropertyRoute;
  setter: Operations.API.PropertySetter;
  onDeleteSetter: (pi: Operations.API.PropertySetter) => void;
  isPredicate: boolean;
  onSetterChanged: () => void;
}

export namespace MultiPropertySetterModal {
  export function show(typeInfo: TypeInfo, lites: Lite<Entity>[], operationInfo: OperationInfo, setters?: Operations.API.PropertySetter[]): Promise<Operations.API.PropertySetter[] | undefined> {
    return Promise.resolve([]);
  }
}
