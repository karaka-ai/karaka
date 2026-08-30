/** A value safe to carry through Karaka's language-neutral tool protocol. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** JSON Schema 2020-12 document used at a tool boundary. */
export type ToolJsonSchema = boolean | { readonly [key: string]: JsonValue }

/** Author-written tool metadata. Version defaults to `1`. */
export interface ToolDefinition {
  readonly id: string
  readonly version?: string
  readonly description: string
  readonly input: ToolJsonSchema
  readonly output: ToolJsonSchema
  readonly permission?: string
}

/** Normalized metadata shared by manifests, registries, and model adapters. */
export interface ToolDescriptor {
  readonly id: string
  readonly version: string
  readonly description: string
  readonly input: ToolJsonSchema
  readonly output: ToolJsonSchema
  readonly permission?: string
}

/** Runtime-only invocation context; it is never part of model arguments. */
export interface ToolInvocationContext {
  readonly signal?: AbortSignal
}

/** A local or remote implementation behind one logical tool descriptor. */
export type ToolHandler = (
  input: JsonValue,
  context: Readonly<ToolInvocationContext>,
) => unknown | Promise<unknown>

/** Effect-owned contribution consumed by the Tool core registry. */
export interface ToolContribution {
  readonly descriptor: ToolDefinition | ToolDescriptor
  readonly invoke: ToolHandler
}

const metadataSymbol = Symbol.for('@karaka/tool/metadata')
const toolIdPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/

type Method<This, Args extends unknown[], Result> = (this: This, ...args: Args) => Result

export interface ToolDecorator {
  <This, Args extends unknown[], Result>(
    value: Method<This, Args, Result>,
    context: ClassMethodDecoratorContext<This, Method<This, Args, Result>>,
  ): Method<This, Args, Result>
  (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void
}

/** Attach immutable tool metadata to one public instance method. */
export function tool(definition: Readonly<ToolDefinition>): ToolDecorator {
  const descriptor = defineTool(definition)

  return function decorate(...args: [unknown, unknown] | [object, string | symbol, PropertyDescriptor]) {
    if (args.length === 2 && isDecoratorContext(args[1])) {
      const [method, context] = args
      if (context.kind !== 'method' || context.private || context.static || typeof method !== 'function') {
        throw new TypeError('@tool can decorate only public instance methods')
      }
      attachMetadata(method, descriptor)
      return method
    }

    if (args.length === 3) {
      if (typeof args[0] === 'function') throw new TypeError('@tool can decorate only public instance methods')
      const method = args[2]?.value
      if (typeof method !== 'function') throw new TypeError('@tool can decorate only methods')
      attachMetadata(method, descriptor)
      return
    }

    throw new TypeError('@tool received an unsupported decorator target')
  } as ToolDecorator
}

/** Read metadata without registering the method or mutating global state. */
export function getToolMetadata(value: unknown): ToolDescriptor | undefined {
  if (typeof value !== 'function' || !Object.hasOwn(value, metadataSymbol)) return undefined
  return Reflect.get(value, metadataSymbol) as ToolDescriptor
}

/** Normalize a descriptor for decorators and direct plugin contributions. */
export function defineTool(definition: Readonly<ToolDefinition | ToolDescriptor>): ToolDescriptor {
  if (!definition || typeof definition !== 'object') throw new TypeError('tool definition must be an object')
  const id = requireText(definition.id, 'tool ID')
  if (!toolIdPattern.test(id)) throw new TypeError('tool ID must be a stable name of at most 128 characters')
  const version = requireText(definition.version ?? '1', 'tool version')
  const description = requireText(definition.description, 'tool description')
  const input = jsonSchema(definition.input, 'tool input schema')
  const output = jsonSchema(definition.output, 'tool output schema')
  const permission = definition.permission === undefined
    ? undefined
    : requireText(definition.permission, 'tool permission')

  return Object.freeze({
    id,
    version,
    description,
    input,
    output,
    ...(permission === undefined ? {} : { permission }),
  })
}

function attachMetadata(method: Function, descriptor: ToolDescriptor) {
  if (Object.hasOwn(method, metadataSymbol)) throw new TypeError('method already has @tool metadata')
  Object.defineProperty(method, metadataSymbol, {
    configurable: false,
    enumerable: false,
    value: descriptor,
    writable: false,
  })
}

function isDecoratorContext(value: unknown): value is ClassMethodDecoratorContext {
  return !!value && typeof value === 'object' && 'kind' in value
}

function jsonSchema(value: unknown, label: string): ToolJsonSchema {
  if (typeof value === 'boolean') return value
  const copied = jsonObject(value, label, new Set<object>())
  return deepFreeze(copied)
}

function jsonObject(value: unknown, label: string, ancestors: Set<object>): { [key: string]: JsonValue } {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a JSON Schema object or boolean`)
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`)
  ancestors.add(value)
  const result: { [key: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value)) {
    defineJsonProperty(result, key, jsonValue(item, label, ancestors))
  }
  ancestors.delete(value)
  return result
}

function jsonValue(value: unknown, label: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new TypeError(`${label} must contain only finite JSON numbers`)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`)
    ancestors.add(value)
    const result = value.map(item => jsonValue(item, label, ancestors))
    ancestors.delete(value)
    return result
  }
  return jsonObject(value, label, ancestors)
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function defineJsonProperty(target: { [key: string]: JsonValue }, key: string, value: JsonValue) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function requireText(value: unknown, label: string) {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}
