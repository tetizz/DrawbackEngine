/**
 * Reads a closed parameter object without invoking accessors.
 *
 * Object literals are the sole accepted representation. Arrays, null
 * prototypes, inherited prototypes, symbols, accessors, and extra keys are
 * rejected so serialized and TypeScript callers share one exact schema.
 */
export function parseExactParameterObject(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(
      `${label} must contain exactly: ${expectedKeys.join(", ") || "no keys"}.`,
    );
  }
  const parsed: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable data property.`);
    }
    parsed[key] = descriptor.value;
  }
  return Object.freeze(parsed);
}
