// Custom keyed collections used by the Array extensions (toDictionary / toHashSet)
// and available as general-purpose helpers. Both mirror Map<K, V> / Set<T> but take a
// `keyStringifier` so complex keys can be compared by a derived string.

//Similar to Map<K, V> but with keyStringifier for custom formatter
export class Dictionary<K, V> {
  private map = new Map<string, V>();
  private keyStringifier: (key: K) => string;

  constructor(keyStringifier: (key: K) => string) {
    this.keyStringifier = keyStringifier;
  }

  set(key: K, value: V): this {
    this.map.set(this.keyStringifier(key), value);
    return this;
  }

  get(key: K): V | undefined {
    return this.map.get(this.keyStringifier(key));
  }

  has(key: K): boolean {
    return this.map.has(this.keyStringifier(key));
  }

  delete(key: K): boolean {
    return this.map.delete(this.keyStringifier(key));
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  values(): MapIterator<V> {
    return this.map.values();
  }
}

export class HashSet<T> {
  private map = new Map<string, T>();
  private keyStringifier: (item: T) => string;

  constructor(keyStringifier: (item: T) => string) {
    this.keyStringifier = keyStringifier;
  }

  add(item: T): this {
    this.map.set(this.keyStringifier(item), item);
    return this;
  }

  has(item: T): boolean {
    return this.map.has(this.keyStringifier(item));
  }

  delete(item: T): boolean {
    return this.map.delete(this.keyStringifier(item));
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  values(): MapIterator<T> {
    return this.map.values();
  }

  [Symbol.iterator](): MapIterator<T> {
    return this.map.values()
  }
}
