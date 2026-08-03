export function isNumber(n: any): boolean {
  return !isNaN(parseFloat(n)) && isFinite(n);
}

export function softCast<T>(val: T): T {
  return val;
}

export namespace Dic {

  var simplesTypes = ["number", "boolean", "string"];
  export const skipClasses: Function[] = [];

  export function equals<V>(objA: V, objB: V, deep: boolean, depth = 0, visited: any[] = []): boolean {

    if (objA === objB)
      return true;

    if (objA == null || objB == null)
      return false;

    if (simplesTypes.contains(typeof objA) ||
      simplesTypes.contains(typeof objB))
      return false;

    if (objA instanceof Date && objB instanceof Date)
      return objA.valueOf() === objB.valueOf();

    if (Array.isArray(objA) !== Array.isArray(objB))
      return false;

    if (visited.indexOf(objB) != -1)
      return false;
    visited.push(objB);

    if (visited.indexOf(objA) != -1)
      return false;
    visited.push(objA);

    if (Array.isArray(objA)) {
      var ar = objA as any as any[];
      var br = objB as any as any[];

      if (ar.length != br.length)
        return false;

      return Array.range(0, ar.length).every(i => equals(ar[i], br[i], deep, depth + 1, visited));
    }

    if (Object.getPrototypeOf(objA) !== Object.getPrototypeOf(objB))
      return false;

    if (skipClasses.some(c => objA instanceof c))
      return false;

    const akeys = Dic.getKeys(objA);
    const bkeys = Dic.getKeys(objB);

    if (akeys.length != bkeys.length)
      return false;

    return akeys.every(k => equals((objA as any)[k], (objB as any)[k], deep, depth + 1, visited));
  }

  export function assign<O extends P, P extends {}>(obj: O, other: P | undefined): void {
    if (!other)
      return;

    for (const key in other) {
      if (other.hasOwnProperty == null || other.hasOwnProperty(key))
        (obj as any)[key] = other[key];
    }
  }


  export function getValues<V>(obj: { [key: string]: V }): V[] {
    const result: V[] = [];

    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        result.push(obj[name]);
      }
    }

    return result;
  }

  export function getKeys(obj: { [key: string]: any }): string[] {
    const result: string[] = [];

    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        result.push(name);
      }
    }

    return result;
  }

  export function clear(obj: { [key: string]: any }): void {
    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        delete obj[name];
      }
    }
  }

  export function except(obj: { [key: string]: any }, keys: string[]): { [key: string]: any } {
    var result: { [key: string]: any } = {};
    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        if (!keys.contains(name))
          result[name] = obj[name];
      }
    }
    return result;
  }

  export function map<V, R>(obj: { [key: string]: V }, selector: (key: string, value: V, index: number) => R): R[] {
    let index = 0;
    const result: R[] = [];
    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        result.push(selector(name, obj[name], index++));
      }
    }
    return result;
  }

  export function mapObject<V, R>(obj: { [key: string]: V }, selector: (key: string, value: V, index: number) => R): { [key: string]: R } {
    let index = 0;
    const result: { [key: string]: R } = {};
    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        result[name] = selector(name, obj[name], index++);
      }
    }
    return result;
  }

  export function foreach<V>(obj: { [key: string]: V }, action: (key: string, value: V) => void): void {

    for (const name in obj) {
      if (obj.hasOwnProperty == null || obj.hasOwnProperty(name)) {
        action(name, obj[name]);
      }
    }
  }


  export function addOrThrow<V>(dic: { [key: string]: V }, key: string, value: V, errorContext?: string): void {
    if (dic[key])
      throw new Error(`Key ${key} already added` + (errorContext ? "in " + errorContext : ""));

    dic[key] = value;
  }

  export function simplify<T extends {}>(a: T): T;
  export function simplify<T extends {}>(a: undefined): undefined;
  export function simplify<T extends {}>(a: T | undefined): T | undefined;
  export function simplify<T extends {}>(a: T | undefined): T | undefined {
    if (a == null)
      return a;

    var result: T = {} as any;
    for (const key in a) {
      if ((a.hasOwnProperty == null || a.hasOwnProperty(key)) && a[key] !== undefined)
        result[key] = a[key];
    }
    return result;
  }

  export function deepFreeze<T extends object>(object: T): T {

    // Abrufen der definierten Eigenschaftsnamen des Objekts
    var propNames = Object.getOwnPropertyNames(object);

    // Eigenschaften vor dem eigenen Einfrieren einfrieren
    var result = {};

    for (let name of propNames) {
      let value = (object as any)[name];

      (result as any)[name] = value && typeof value === "object" ?
        deepFreeze(value) : value;
    }

    return Object.freeze(object);
  }
}

export function coalesce<T>(value: T | undefined | null, defaultValue: T): T {
  return value != null ? value : defaultValue;
}

export function classes(...classNames: (string | null | undefined | boolean /*false*/)[]): string {
  return classNames.filter(a => a && a != "").join(" ");
}
export function combineFunction<F extends Function>(func1?: F | null, func2?: F | null): F | null | undefined {
  if (!func1)
    return func2;

  if (!func2)
    return func1;

  return function combined(this: any, ...args: any[]) {
    func1.apply(this, args);
    func2.apply(this, args);
  } as any;
}

export function areEqual<T>(a: T | undefined, b: T | undefined, field: (value: T) => any): boolean {
  if (a == undefined)
    return b == undefined;

  if (b == undefined)
    return false;

  return field(a) == field(b);
}

export function ifError<E, T>(ErrorClass: { new(...args: any[]): E }, onError: (error: E) => T): (error: any) => T {
  return error => {
    if (error instanceof ErrorClass)
      return onError((error as E));
    throw error;
  };
}

export function bytesToSize(bytes: number): string {
  var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  if (bytes == 0) return '0 Bytes';
  var unit = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)) as any);
  return Math.round((bytes / Math.pow(1024, unit)) * 100) / 100 + ' ' + sizes[unit];
};

export class KeyGenerator {
  map: Map<object, number> = new Map<object, number>();
  maxIndex = 0;
  getKey(o: object): number {
    var result = this.map.get(o);
    if (result == undefined) {
      result = this.maxIndex++;
      this.map.set(o, result);
    }
    return result;
  }
}

export function roundTwoDecimals(num: number): number {

  var round3 = Math.round(num * 1000000) / 1000000; //convert 0.0049999999999 -> 0.005

  var round3m100 = round3 * 100;

  var mod = round3m100 % 10; //Simulate Midpoint to Even (C# decimal default) instead of Midpoint to +Inf (JS behaviour)
  if (mod == 0.5 || mod == 2.5 || mod == 4.5 || mod == 6.5 || mod == 8.5)
    round3m100 -= 0.001;

  return Math.round(round3m100) / 100; //https://stackoverflow.com/questions/11832914/round-to-at-most-2-decimal-places-only-if-necessary
}


export function getColorContrasColorBWByHex(hexcolor: string): "black" | "white" {
  hexcolor = hexcolor.replace("#", "");
  var r = parseInt(hexcolor.substr(0, 2), 16);
  var g = parseInt(hexcolor.substr(2, 2), 16);
  var b = parseInt(hexcolor.substr(4, 2), 16);
  var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  return (yiq >= 128) ? 'black' : 'white';
}

export function isPromise(value: any): value is Promise<any> {
  return value != null && value.then != null;
}

export function toPromise<T>(value: T | Promise<T>): Promise<T> {
  return isPromise(value) ? value : Promise.resolve(value);
}
