import { Dictionary, HashSet } from "./collections";

declare global {

  type Comparable = number | string | { valueOf: () => any };

  interface Array<T> {
    groupBy<K extends string>(this: Array<T>, keySelector: (element: T) => K): { key: K; elements: T[] }[];
    groupBy<K>(this: Array<T>, keySelector: (element: T) => K, keyStringifier?: (key: K) => string): { key: K; elements: T[] }[];
    groupBy<K, E>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: ((key: K) => string) | undefined, elementSelector: (element: T) => E): { key: K; elements: E[] }[];
    groupToObject(this: Array<T>, keySelector: (element: T) => string): { [key: string]: T[] };
    groupToObject<E>(this: Array<T>, keySelector: (element: T) => string, elementSelector: (element: T) => E): { [key: string]: E[] };
    groupReduceToObject<R>(this: Array<T>, keySelector: (element: T) => string, reduceElements: (gr: { key: string, elements: T[] }) => R): { [key: string]: R };
    groupToMap<K>(this: Array<T>, keySelector: (element: T) => K): Map<K, T[]>;
    groupToMap<K, E>(this: Array<T>, keySelector: (element: T) => K, elementSelector: (element: T) => E): Map<K, E[]>;
    groupReduceToMap<K, R>(this: Array<T>, keySelector: (element: T) => K, reduceElements: (gr: { key: string, elements: T[] }) => R): Map<K, R>;
    groupToDictionary<K>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string): Dictionary<K, T[]>;
    groupToDictionary<K, E>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string, elementSelector: (element: T) => E): Dictionary<K, E[]>;
    groupReduceToDictionary<K, R>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string, reduceElements: (gr: { key: string, elements: T[] }) => R): Dictionary<K, R>;

    groupWhen(this: Array<T>, condition: (element: T) => boolean, includeKeyInGroup?: boolean, beforeFirstKey?: "throw" | "skip" | "defaultGroup"): { key: T, elements: T[] }[];
    groupWhenChange<K>(this: Array<T>, keySelector: (element: T) => K, keyStringifier?: (key: K) => string): { key: K, elements: T[] }[];

    orderBy<V extends Comparable>(this: Array<T>, keySelector: (element: T) => V | null | undefined): T[];
    orderByDescending<V extends Comparable>(this: Array<T>, keySelector: (element: T) => V | null | undefined): T[];

    toObject(this: Array<T>, keySelector: (element: T) => string): { [key: string]: T };
    toObject<V>(this: Array<T>, keySelector: (element: T) => string, valueSelector: (element: T) => V): { [key: string]: V };
    toObjectDistinct(this: Array<T>, keySelector: (element: T) => string): { [key: string]: T };
    toObjectDistinct<V>(this: Array<T>, keySelector: (element: T) => string, valueSelector: (element: T) => V): { [key: string]: V };


    toMap<K>(this: Array<T>, keySelector: (element: T) => K): Map<K, T>;
    toMap<K, V>(this: Array<T>, keySelector: (element: T) => K, valueSelector: (element: T) => V): Map<K, V>;
    toMapDistinct<K>(this: Array<T>, keySelector: (element: T) => K): Map<K, T>;
    toMapDistinct<K, V>(this: Array<T>, keySelector: (element: T) => V, valueSelector: (element: T) => V): Map<K, V>;

    toDictionary<K>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string): Dictionary<K, T>;
    toDictionary<K, V>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string, valueSelector: (element: T) => V): Dictionary<K, V>;
    toDictionaryDistinct<K>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string): Dictionary<K, T>;
    toDictionaryDistinct<K, V>(this: Array<T>, keySelector: (element: T) => K, keyStringifier: (key: K) => string, valueSelector: (element: T) => V): Dictionary<K, V>;

    toHashSet(this: Array<T>, keyStringifier: (element: T) => string): HashSet<T>;

    distinctBy(this: Array<T>, keySelector?: (element: T) => unknown): T[];

    clear(this: Array<T>): void;
    groupsOf(this: Array<T>, groupSize: number, elementSize?: (item: T) => number): T[][];

    minBy<V>(this: Array<T>, keySelector: (element: T) => V): T | undefined;
    maxBy<V>(this: Array<T>, keySelector: (element: T) => V): T | undefined;
    max<V extends Comparable>(this: Array<V | null | undefined>): V | null;
    max<V extends Comparable>(this: Array<T>, selector: (element: T, index: number, array: T[]) => V | null | undefined): V | null;
    min<V extends Comparable>(this: Array<V | null | undefined>): V | null;
    min<V extends Comparable>(this: Array<T>, selector: (element: T, index: number, array: T[]) => V | null | undefined): V | null;

    sum(this: Array<number>): number;
    sum(this: Array<T>, selector: (element: T, index: number, array: T[]) => number): number;

    // Standard-deviation aggregates (Signum's StdDev/StdDevP) — query-only (SQL STDEV/STDEVP).
    stdDev(this: Array<T>): number | null;
    stdDevP(this: Array<T>): number | null;

    avg(this: Array<number>): number;
    avg(this: Array<T>, selector: (element: T, index: number, array: T[]) => number): number;

    count(this: Array<T>, predicate: (element: T, index: number, array: T[]) => boolean): number;

    // Query-positional operators. In a quoted query lambda these are translated
    // to SQL (the binder steals __lambdaType/__resultType from Query<T>); the
    // bodies below are the in-memory fallbacks. Names/shapes mirror Query<T>.
    top(this: Array<T>, count: number): T[];
    skip(this: Array<T>, count: number): T[];
    distinct(this: Array<T>): T[];
    orderBy<V>(this: Array<T>, selector: (element: T) => V): T[];
    orderByDescending<V>(this: Array<T>, selector: (element: T) => V): T[];
    defaultIfEmpty(this: Array<T>, defaultValue?: T): T[];
    toArray(this: Array<T>): T[];

    first(this: Array<T>, errorContext?: string): T;
    first<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): S;
    first(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T;

    firstOrNull(this: Array<T>): T | null;
    firstOrNull<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): S | null;
    firstOrNull(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T | null;

    last(this: Array<T>, errorContext?: string): T;
    last<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): T;
    last(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T;

    lastOrNull(this: Array<T>): T | null;
    lastOrNull<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): S | null;
    lastOrNull(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T | null;

    single(this: Array<T>, errorContext?: string): T;
    single<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): S;
    single(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T;

    singleOrNull(this: Array<T>, errorContext?: string): T | null;
    singleOrNull<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): S | null;
    singleOrNull(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T | null;

    onlyOrNull(this: Array<T>): T | null;
    onlyOrNull<S extends T>(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => element is S): S | null;
    onlyOrNull(this: Array<T>, predicate?: (element: T, index: number, array: T[]) => unknown): T | null;

    contains(this: Array<T>, element: T): boolean;
    remove(this: Array<T>, element: T): boolean;
    removeAt(this: Array<T>, index: number): void;
    moveUp(this: Array<T>, index: number): number;
    moveDown(this: Array<T>, index: number): number;
    insertAt(this: Array<T>, index: number, element: T): void;

    notNull(this: Array<T>): NonNullable<T>[];
    clone(this: Array<T>,): T[];
    joinComma(this: Array<T>, lastSeparator: string): string;
    extract(this: Array<T>, filter: (element: T) => boolean): T[];
    findIndex(this: Array<T>, filter: (element: T, index: number, obj: Array<T>) => boolean): number;
    findLastIndex(this: Array<T>, filter: (element: T) => boolean): number;
    toTree(this: Array<T>, getKey: (element: T) => string, getParentKey: (element: T) => string | null | undefined): TreeNode<T>[];
  }

  interface TreeNode<T> {
    value: T;
    children: TreeNode<T>[];
  }

  interface ArrayConstructor {

    range(min: number, maxNotIncluded: number): number[];
    toArray<T>(arrayish: { length: number;[index: number]: T }): T[];
    repeat<T>(count: number, value: T): T[];
  }
}

Array.prototype.clear = function (): void {
  this.length = 0;
};

Array.prototype.groupBy = function (this: any[],
  keySelector: (element: any) => any,
  keyStringifier?: (element: any) => string,
  elementSelector?: (element: any) => unknown): { key: any /*string*/; elements: any[] }[] {

  const result: { key: any; elements: any[] }[] = [];
  const obj: { [key: string]: any[] } = {};
  keyStringifier ??= v => v.toString();

  for (const elem of this) {

    var key = keySelector(elem);
    var elem2 = elementSelector == null ? elem : elementSelector(elem);
    var gr = obj[keyStringifier(key)];
    if (gr) {
      gr.push(elem2);
    } else {
      var group = {
        key: key,
        elements: [elem2]
      };
      result.push(group);
      obj[keyStringifier(key)] = group.elements;
    }
  }
  return result;
};

Array.prototype.groupToObject = function (this: any[], keySelector: (element: any) => string | number, elementSelector?: (element: any) => unknown): { [key: string | number]: any[] } {
  const result: { [key: string | number]: any[] } = {};

  for (let i = 0; i < this.length; i++) {
    const element: any = this[i];
    const key = keySelector(element);
    if (!result[key])
      result[key] = [];
    result[key].push(elementSelector ? elementSelector(element) : element);
  }
  return result;
};


Array.prototype.groupToMap = function (this: any[], keySelector: (element: any) => string, elementSelector?: (element: any) => unknown): Map<any, any[]> {
  const result = new Map<any, any[]>();

  for (let i = 0; i < this.length; i++) {
    const element: any = this[i];
    const key = keySelector(element);
    if (!result.has(key))
      result.set(key, []);
    result.get(key)!.push(elementSelector ? elementSelector(element) : element);
  }
  return result;
};

Array.prototype.groupToDictionary = function (this: any[], keySelector: (element: any) => unknown, keyStringified: (key: unknown) => string, elementSelector?: (element: any) => unknown): Dictionary<any, any[]> {
  const result = new Dictionary<any, any[]>(keyStringified);

  for (let i = 0; i < this.length; i++) {
    const element: any = this[i];
    const key = keySelector(element);
    if (!result.has(key))
      result.set(key, []);
    result.get(key)!.push(elementSelector ? elementSelector(element) : element);
  }
  return result;
};


Array.prototype.groupReduceToObject = function (this: any[], keySelector: (element: any) => string, reduceElements: (gr: { key: string, elements: any[] }) => any): { [key: string]: any } {
  return this.groupBy(keySelector).toObject(gr => gr.key, gr => reduceElements(gr));
};

Array.prototype.groupReduceToMap = function (this: any[], keySelector: (element: any) => any, reduceElements: (gr: { key: any, elements: any[] }) => any): Map<any, any> {
  return this.groupBy(keySelector).toMap(gr => gr.key, gr => reduceElements(gr));
};

Array.prototype.groupReduceToDictionary = function (this: any[], keySelector: (element: any) => any, keyStringifier: (key: any) => string, reduceElements: (gr: { key: any, elements: any[] }) => any): Dictionary<any, any> {
  return this.groupBy(keySelector, keyStringifier).toDictionary(gr => gr.key, keyStringifier, gr => reduceElements(gr));
};

Array.prototype.groupWhen = function (this: any[], isGroupKey: (element: any) => boolean, includeKeyInGroup = false, beforeFirstKey: "throw" | "skip" | "defaultGroup" = "throw"): { key: any, elements: any[] }[] {
  const result: { key: any, elements: any[] }[] = [];

  let group: { key: any, elements: any[] } | undefined = undefined;

  for (let i = 0; i < this.length; i++) {
    const item: any = this[i];
    if (isGroupKey(item)) {
      group = { key: item, elements: includeKeyInGroup ? [item] : [] };
      result.push(group);
    }
    else {
      if (group == undefined) {
        switch (beforeFirstKey) {
          case "throw": throw new Error("Parameter initialGroup is false");
          case "skip": break;
          case "defaultGroup": {
            group = { key: undefined, elements: [] };
            result.push(group);
            group!.elements.push(item);
          }
        }
      }
      else {
        group!.elements.push(item);
      }
    }
  }
  return result;
};

Array.prototype.groupWhenChange = function (this: any[], keySelector: (element: any) => any, keyStringifier?: (key: any) => string): { key: any, elements: any[] }[] {
  const result: { key: any, keyString: string, elements: any[] }[] = [];

  keyStringifier ??= a => a.toString();

  let current: { key: any, keyString: string, elements: any[] } | undefined = undefined;

  for (let i = 0; i < this.length; i++) {
    const item: any = this[i];
    const key = keySelector(item);
    const keyString = keyStringifier(key);
    if (current == undefined) {

      current = { key: key, keyString: keyString, elements: [item] };
    }
    else if (current.keyString == keyString) {
      current.elements.push(item);
    }
    else {
      result.push(current);
      current = { key: key, keyString: keyString, elements: [item] };
    }
  }

  if (current != undefined)
    result.push(current);

  return result;
};

Array.prototype.orderBy = function (this: any[], keySelector: (element: any) => any): any[] {
  const cloned = this.slice(0);
  cloned.sort((e1, e2) => {
    const v1 = keySelector(e1);
    const v2 = keySelector(e2);
    if (v1 > v2)
      return 1;
    if (v1 < v2)
      return -1;
    return 0;
  });
  return cloned;
};

Array.prototype.orderByDescending = function (this: any[], keySelector: (element: any) => any): any[] {
  const cloned = this.slice(0);
  cloned.sort((e1, e2) => {
    const v1 = keySelector(e1);
    const v2 = keySelector(e2);
    if (v1 < v2)
      return 1;
    if (v1 > v2)
      return -1;
    return 0;
  });
  return cloned;
};


Array.prototype.minBy = function (this: any[], keySelector: (element: any) => any): any {
  if (this.length == 0)
    return undefined;

  var min = keySelector(this[0]);
  var result = this[0];
  for (var i = 1; i < this.length; i++) {
    var val = keySelector(this[i]);
    if (val < min) {
      min = val;
      result = this[i];
    }
  }
  return result;
};

Array.prototype.maxBy = function (this: any[], keySelector: (element: any) => any): any {
  if (this.length == 0)
    return undefined;

  var max = keySelector(this[0]);
  var result = this[0];
  for (var i = 1; i < this.length; i++) {
    var val = keySelector(this[i]);
    if (val > max) {
      max = val;
      result = this[i];
    }
  }
  return result;
};

Array.prototype.toObject = function (this: any[], keySelector: (element: any) => any, valueSelector?: (element: any) => any): any {
  const obj: any = {};

  this.forEach(item => {
    const key = keySelector(item);

    if (obj[key])
      throw new Error("Repeated key {0}".formatWith(key));

    obj[key] = valueSelector ? valueSelector(item) : item;
  });

  return obj;
};

Array.prototype.toObjectDistinct = function (this: any[], keySelector: (element: any) => any, valueSelector?: (element: any) => any): any {
  const obj: any = {};

  this.forEach(item => {
    const key = keySelector(item);

    obj[key] = valueSelector ? valueSelector(item) : item;
  });

  return obj;
};

Array.prototype.toMap = function (this: any[], keySelector: (element: any) => any, valueSelector?: (element: any) => any): any {
  const map = new Map();

  this.forEach(item => {
    const key = keySelector(item);

    if (map.has(key))
      throw new Error("Repeated key {0}".formatWith(key));

    map.set(key, valueSelector ? valueSelector(item) : item);
  });

  return map;
};

Array.prototype.toMapDistinct = function (this: any[], keySelector: (element: any) => any, valueSelector?: (element: any) => any): any {
  const map = new Map();

  this.forEach(item => {
    const key = keySelector(item);

    map.set(key, valueSelector ? valueSelector(item) : item);
  });

  return map;
};

Array.prototype.toDictionary = function (this: any[], keySelector: (element: any) => any, keyStringifier: (elem: any) => string, valueSelector?: (element: any) => any): Dictionary<any, any> {
  const dic = new Dictionary<any, any>(keyStringifier);

  this.forEach(item => {
    const key = keySelector(item);

    if (dic.has(key))
      throw new Error("Repeated key {0}".formatWith(key));

    dic.set(key, valueSelector ? valueSelector(item) : item);
  });

  return dic;
};

Array.prototype.toDictionaryDistinct = function (this: any[], keySelector: (element: any) => any, keyStringifier: (elem: any) => string, valueSelector?: (element: any) => any): Dictionary<any, any> {
  const dic = new Dictionary<any, any>(keyStringifier);

  this.forEach(item => {
    const key = keySelector(item);

    dic.set(key, valueSelector ? valueSelector(item) : item);
  });

  return dic;
};

Array.prototype.toHashSet = function (this: any[], keyStringifier: (element: any) => string): HashSet<any> {
  const set = new HashSet<any>(keyStringifier)

  this.forEach(item => {
    set.add(item)
  })

  return set
};

Array.prototype.distinctBy = function (this: any[], keySelector: (element: any) => unknown): any[] {
  const keysFound = new Set<unknown>();

  keySelector ??= a => a.toString();

  const result: any[] = [];

  this.forEach(item => {
    const key = keySelector(item);

    if (!keysFound.has(key)) {
      result.push(item);
      keysFound.add(key);
    }
  });

  return result;
};

Array.prototype.groupsOf = function (this: any[], groupSize: number, elementSize?: (item: any) => number) {

  const result: any[][] = [];
  let newList: any[] = [];


  if (elementSize == null) {
    this.forEach(item => {
      newList.push(item);
      if (newList.length == groupSize) {
        result.push(newList);
        newList = [];
      }
    });
  }
  else {
    var accumSize = 0;
    this.forEach(item => {
      var size = elementSize(item);

      if ((accumSize + size) > groupSize && newList.length > 0) {
        result.push(newList);
        newList = [item];
        accumSize = size;
      }
      else {
        accumSize += size;
        newList.push(item);
      }
    });
  }

  if (newList.length != 0)
    result.push(newList);

  return result;
}

Array.prototype.max = function (this: any[], selector?: (element: any, index: number, array: any[]) => any) {

  var array: number[] = selector ?
    this.map(selector).filter(a => a != null) :
    this.filter(a => a != null);

  if (array.length == 0)
    return null;

  var max = array[0];
  for (var i = 1; i < array.length; i++) {
    var val = array[i];
    if (max < val) {
      max = val;
    }
  }
  return max;
};

Array.prototype.min = function (this: any[], selector?: (element: any, index: number, array: any[]) => any) {

  var array: number[] = selector ?
    this.map(selector).filter(a => a != null) :
    this.filter(a => a != null);

  if (array.length == 0)
    return null;

  var min = array[0];
  for (var i = 1; i < array.length; i++) {
    var val = array[i];
    if (val < min) {
      min = val;
    }
  }
  return min;
};

Array.prototype.sum = function (this: any[], selector?: (element: any, index: number, array: any[]) => any) {

  if (this.length == 0)
    return 0;

  var result = 0;
  if (selector) {
    for (var i = 0; i < this.length; i++) {
      result += selector(this[i], i, this) ?? 0;
    }
  } else {
    for (var i = 0; i < this.length; i++) {
      result += this[i];
    }
  }

  return result;
};

Array.prototype.count = function (this: any[], predicate: (element: any, index: number, array: any[]) => any) {

  if (this.length == 0)
    return 0;

  var result = 0;
  for (var i = 0; i < this.length; i++) {
    if (predicate(this[i], i, this))
      result++;
  }

  return result;
};


Array.prototype.first = function (this: any[], errorContextOrPredicate?: string | ((element: any, index: number, array: any[]) => unknown)) {

  var array = typeof errorContextOrPredicate == "function" ? this.filter(errorContextOrPredicate) : this;

  if (array.length == 0)
    throw new Error("No " + (typeof errorContextOrPredicate == "string" ? errorContextOrPredicate : "element") + " found");

  return array[0];
};


Array.prototype.firstOrNull = function (this: any[], predicate?: ((element: any, index: number, array: any[]) => unknown)) {

  var array = typeof predicate == "function" ? this.filter(predicate) : this;

  if (array.length == 0)
    return null;

  return array[0];
};

Array.prototype.last = function (this: any[], errorContextOrPredicate?: string | ((element: any, index: number, array: any[]) => unknown)) {

  var array = typeof errorContextOrPredicate == "function" ? this.filter(errorContextOrPredicate) : this;

  if (array.length == 0)
    throw new Error("No " + (typeof errorContextOrPredicate == "string" ? errorContextOrPredicate : "element") + " found");

  return array[array.length - 1];
};


Array.prototype.lastOrNull = function (this: any[], predicate?: ((element: any, index: number, array: any[]) => unknown)) {

  var array = typeof predicate == "function" ? this.filter(predicate) : this;

  if (array.length == 0)
    return null;

  return array[array.length - 1];
};

Array.prototype.single = function (this: any[], errorContextOrPredicate?: string | ((element: any, index: number, array: any[]) => unknown)) {

  var array = typeof errorContextOrPredicate == "function" ? this.filter(errorContextOrPredicate) : this;

  if (array.length == 0)
    throw new Error("No " + (typeof errorContextOrPredicate == "string" ? errorContextOrPredicate : "element") + " found");

  if (array.length > 1)
    throw new Error("More than one " + (typeof errorContextOrPredicate == "string" ? errorContextOrPredicate : "element") + " found");

  return array[0];
};

Array.prototype.singleOrNull = function (this: any[], errorContextOrPredicate?: string | ((element: any, index: number, array: any[]) => unknown)) {

  var array = typeof errorContextOrPredicate == "function" ? this.filter(errorContextOrPredicate) : this;

  if (array.length == 0)
    return null;

  if (array.length > 1)
    throw new Error("More than one " + (typeof errorContextOrPredicate == "string" ? errorContextOrPredicate : "element") + " found");

  return array[0];
};


Array.prototype.onlyOrNull = function (this: any[], predicate?: (element: any, index: number, array: any[]) => unknown) {

  var array = predicate ? this.filter(predicate) : this;

  if (array.length == 0)
    return null;

  if (array.length > 1)
    return null;

  return array[0];
};

Array.prototype.contains = function (this: any[], element: any) {
  return this.indexOf(element) !== -1;
};

Array.prototype.avg = function (this: any[], selector?: (e: any, i: number, a: any[]) => number) {
  if (this.length == 0) return 0;
  const total = selector ? this.reduce((acc, e, i) => acc + selector(e, i, this), 0) : this.reduce((acc, e) => acc + e, 0);
  return total / this.length;
};

// Query-positional operators (in-memory fallbacks; the SQL path is the binder's).
Array.prototype.top = function (this: any[], count: number) {
  return this.slice(0, count);
};

Array.prototype.skip = function (this: any[], count: number) {
  return this.slice(count);
};

Array.prototype.distinct = function (this: any[]) {
  return Array.from(new Set(this));
};

Array.prototype.orderBy = function (this: any[], selector: (e: any) => any) {
  return this.slice().sort((a, b) => { const ka = selector(a), kb = selector(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
};

Array.prototype.orderByDescending = function (this: any[], selector: (e: any) => any) {
  return this.slice().sort((a, b) => { const ka = selector(a), kb = selector(b); return ka < kb ? 1 : ka > kb ? -1 : 0; });
};

Array.prototype.defaultIfEmpty = function (this: any[], defaultValue?: any) {
  return this.length > 0 ? this : [defaultValue];
};

Array.prototype.toArray = function (this: any[]) {
  return this.slice();
};

if (!Array.prototype.includes) {
  Array.prototype.includes = function (this: any[], element: any, fromIndex?: number) {
    return this.indexOf(element, fromIndex) !== -1;
  };
}

Array.prototype.removeAt = function (this: any[], index: number) {
  this.splice(index, 1);
};

Array.prototype.moveUp = function (this: any[], index: number) {
  if (index == 0)
    return 0;

  const entity = this[index]
  this.removeAt(index);
  this.insertAt(index - 1, entity);
  return index - 1;
};

Array.prototype.moveDown = function (this: any[], index: number) {
  if (index == this.length - 1)
    return this.length - 1;

  const entity = this[index]
  this.removeAt(index);
  this.insertAt(index + 1, entity);
  return index + 1;
};

Array.prototype.remove = function (this: any[], element: any) {

  const index = this.indexOf(element);
  if (index == -1)
    return false;

  this.splice(index, 1);
  return true;
};

Array.prototype.insertAt = function (this: any[], index: number, element: any) {
  this.splice(index, 0, element);
};

Array.prototype.clone = function (this: any[]) {
  return this.slice(0);
};

Array.prototype.notNull = function (this: any[]) {
  return this.filter(a => a != null);
};

Array.prototype.joinComma = function (this: any[], lastSeparator: string) {
  const array = this as any[];

  if (array.length == 0)
    return "";

  if (array.length == 1)
    return array[0] == undefined ? "" : array[0].toString();

  const lastIndex = array.length - 1;

  const rest = array.slice(0, lastIndex).join(", ");

  return rest + lastSeparator + (array[lastIndex] == undefined ? "" : array[lastIndex].toString());
};

Array.prototype.extract = function (this: any[], predicate: (element: any) => boolean) {
  const result = this.filter(predicate);

  result.forEach(element => { this.remove(element) });

  return result;
};

if (!Array.prototype.find) {
  Array.prototype.find = function (this: any[], predicate: (element: any, index: number, array: Array<any>) => boolean, thisArg?: any) {
    for (var i = 0; i < this.length; i++) {
      if (predicate.call(thisArg, this[i], i, this)) {
        return this[i];
      }
    }
    return undefined;
  };
}

if (!Array.prototype.findIndex) {
  Array.prototype.findIndex = function (this: any[], predicate: (element: any, index: number, array: Array<any>) => boolean, thisArg?: any) {
    for (var i = 0; i < this.length; i++)
      if (predicate.call(thisArg, this[i], i, this))
        return i;

    return -1;
  };
}

if (!Array.prototype.findLastIndex) {
  Array.prototype.findLastIndex = function (this: any[], predicate: (element: any, index: number, array: Array<any>) => boolean, thisArg?: any) {
    for (var i = this.length - 1; i >= 0; i--)
      if (predicate.call(thisArg, this[i], i, this))
        return i;

    return -1;
  };
}

if (!Array.prototype.toTree) {
  Array.prototype.toTree = function toTree(this: any[], getKey: (element: any) => string, getParentKey: (element: any) => string | null | undefined) {

    var top: TreeNode<any> = { value: null, children: [] };

    var dic: { [key: string]: TreeNode<any> } = {};

    function createNode(item: any) {

      var key = getKey(item);
      if (dic[key])
        return dic[key];

      var itemNode: TreeNode<any> = { value: item, children: [] };

      var parentKey = getParentKey(item);
      var parent = parentKey ? dic[parentKey] : top;
      parent.children.push(itemNode);
      return dic[key] = itemNode;
    }

    this.forEach(n => createNode(n));

    return top.children;
  }
}

Array.range = function (min: number, maxNotIncluded: number) {
  const length = maxNotIncluded - min;

  const result = new Array(length);
  for (let i = 0; i < length; i++) {
    result[i] = min + i;
  }

  return result;
}

Array.repeat = function (count: number, val: any): any[] {

  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = val;
  }

  return result;
}

Array.toArray = function (arrayish: { length: number;[index: number]: any }): any[] {
  var result: any[] = [];
  for (var i = 0; i < arrayish.length; i++)
    result.push(arrayish[i]);
  return result;
}
