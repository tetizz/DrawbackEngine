import type { JsonValue } from "@drawbackengine/simulation-trace";

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function toTraceJsonValue(
  value: unknown,
  path: string,
  depth = 0,
): JsonValue {
  if (depth > 64) {
    throw new TypeError(`${path} exceeds the maximum JSON nesting depth.`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Array.from(value, (entry, index) =>
      toTraceJsonValue(entry, `${path}[${String(index)}]`, depth + 1));
  }
  if (
    typeof value === "object"
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  ) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    const stringKeys = ownKeys.filter(
      (key): key is string => typeof key === "string",
    );
    if (stringKeys.length !== ownKeys.length) {
      throw new TypeError(`${path} must not contain symbol keys.`);
    }
    const entries: [string, JsonValue][] = [];
    for (const key of stringKeys.sort(compareOrdinal)) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError(
          `${path}.${key} must be an enumerable JSON data property.`,
        );
      }
      entries.push([
        key,
        toTraceJsonValue(descriptor.value, `${path}.${key}`, depth + 1),
      ]);
    }
    return Object.fromEntries(entries);
  }
  throw new TypeError(`${path} must contain only plain JSON-safe values.`);
}
