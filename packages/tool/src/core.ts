import { Service, type Context } from '@karaka/cordis'
import {
  defineTool,
  type JsonValue,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolInvocationContext,
} from '@karaka/sdk/tool'
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

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

declare module '@karaka/cordis' {
  interface Context {
    tools: ToolService
  }
}

export type ToolErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_TOOL'
  | 'NOT_ALLOWED'
  | 'UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'INVOCATION_FAILED'
  | 'ABORTED'

export class ToolError extends Error {
  override readonly name = 'ToolError'

  constructor(readonly code: ToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export interface ToolInvokeRequest {
  readonly id: string
  readonly input: JsonValue
}

export interface ToolSet {
  readonly descriptors: readonly ToolDescriptor[]
  invoke(
    request: Readonly<ToolInvokeRequest>,
    context?: Readonly<ToolInvocationContext>,
  ): Promise<JsonValue>
}

interface RegisteredTool {
  readonly descriptor: ToolDescriptor
  readonly invoke: ToolHandler
  readonly validateInput: ValidateFunction
  readonly validateOutput: ValidateFunction
  invocations: number
  active: boolean
  resolveDrained?: () => void
}

/** Effect-owned registry and validated invocation boundary for logical tools. */
export class ToolService extends Service {
  static readonly provide = 'tools'

  private readonly registrations = new Map<string, RegisteredTool>()

  constructor(ctx: Context) {
    super(ctx, ToolService.provide)
  }

  /** Register one local or remote implementation until its plugin unloads. */
  register(contribution: Readonly<ToolContribution>) {
    if (!contribution || typeof contribution !== 'object' || typeof contribution.invoke !== 'function') {
      throw new TypeError('tool contribution requires an invocation handler')
    }
    const descriptor = defineTool(contribution.descriptor)
    const registration: RegisteredTool = {
      descriptor,
      invoke: contribution.invoke,
      validateInput: this.compile(descriptor.input, descriptor.id, 'input'),
      validateOutput: this.compile(descriptor.output, descriptor.id, 'output'),
      invocations: 0,
      active: true,
    }

    return this.ctx.effect(() => {
      if (this.registrations.has(descriptor.id)) throw new Error(`tool "${descriptor.id}" is already registered`)
      this.registrations.set(descriptor.id, registration)
      return async () => {
        if (this.registrations.get(descriptor.id) === registration) this.registrations.delete(descriptor.id)
        registration.active = false
        if (registration.invocations) {
          await new Promise<void>(resolve => {
            registration.resolveDrained = resolve
          })
        }
      }
    }, `tools.register(${JSON.stringify(descriptor.id)})`)
  }

  /** List the currently contributed descriptors in registration order. */
  list(): readonly ToolDescriptor[] {
    return [...this.registrations.values()].map(registration => registration.descriptor)
  }

  /** Resolve and bind the exact allowlist for one agent activation or turn. */
  bind(allowedIds: readonly string[]): ToolSet {
    if (!Array.isArray(allowedIds)) throw requestError('tool allowlist must be an array')
    const allowed = new Map<string, RegisteredTool>()
    for (const value of allowedIds) {
      const id = requestText(value, 'tool ID')
      if (allowed.has(id)) throw requestError(`tool "${id}" appears more than once in the allowlist`)
      const registration = this.registrations.get(id)
      if (!registration) throw new ToolError('UNKNOWN_TOOL', `tool "${id}" is not registered`)
      allowed.set(id, registration)
    }

    return Object.freeze({
      descriptors: Object.freeze([...allowed.values()].map(registration => registration.descriptor)),
      invoke: (request: Readonly<ToolInvokeRequest>, context?: Readonly<ToolInvocationContext>) => {
        return this.invokeBound(allowed, request, context)
      },
    })
  }

  private async invokeBound(
    allowed: ReadonlyMap<string, RegisteredTool>,
    request: Readonly<ToolInvokeRequest>,
    context: Readonly<ToolInvocationContext> = {},
  ): Promise<JsonValue> {
    const id = requestText(request?.id, 'tool ID')
    const registration = allowed.get(id)
    if (!registration) throw new ToolError('NOT_ALLOWED', `tool "${id}" is not allowed`)
    if (!registration.active) throw new ToolError('UNAVAILABLE', `tool "${id}" is no longer available`)
    assertNotAborted(context.signal)

    const input = jsonBoundaryValue(request?.input, 'tool input', 'INVALID_INPUT')
    if (!registration.validateInput(input)) {
      throw schemaError('INVALID_INPUT', id, registration.validateInput.errors)
    }

    registration.invocations++
    try {
      let output: unknown
      try {
        output = await registration.invoke(input, context)
      } catch (error) {
        if (context.signal?.aborted) throw aborted(error)
        if (error instanceof ToolError) throw error
        throw new ToolError('INVOCATION_FAILED', `tool "${id}" failed`, { cause: error })
      }
      assertNotAborted(context.signal)
      const result = jsonBoundaryValue(output, 'tool output', 'INVALID_OUTPUT')
      if (!registration.validateOutput(result)) {
        throw schemaError('INVALID_OUTPUT', id, registration.validateOutput.errors)
      }
      return result
    } finally {
      registration.invocations--
      if (!registration.active && !registration.invocations) registration.resolveDrained?.()
    }
  }

  private compile(schema: ToolDescriptor['input'], id: string, boundary: 'input' | 'output') {
    try {
      return new Ajv2020({ allErrors: true, strict: true }).compile(schema)
    } catch (error) {
      throw new TypeError(`tool "${id}" has an invalid ${boundary} schema`, { cause: error })
    }
  }
}

function jsonBoundaryValue(
  value: unknown,
  label: string,
  code: 'INVALID_INPUT' | 'INVALID_OUTPUT',
): JsonValue {
  const ancestors = new Set<object>()
  return freezeJson(value, label, code, ancestors)
}

function freezeJson(
  value: unknown,
  label: string,
  code: 'INVALID_INPUT' | 'INVALID_OUTPUT',
  ancestors: Set<object>,
): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new ToolError(code, `${label} must contain only finite JSON numbers`)
  }
  if (!value || typeof value !== 'object') throw new ToolError(code, `${label} must be JSON-compatible`)
  if (ancestors.has(value)) throw new ToolError(code, `${label} must not contain cycles`)
  ancestors.add(value)

  if (Array.isArray(value)) {
    const result = value.map(item => freezeJson(item, label, code, ancestors))
    ancestors.delete(value)
    return Object.freeze(result)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolError(code, `${label} must contain only plain objects`)
  }
  const result: { [key: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: freezeJson(item, label, code, ancestors),
      writable: true,
    })
  }
  ancestors.delete(value)
  return Object.freeze(result)
}

function schemaError(code: 'INVALID_INPUT' | 'INVALID_OUTPUT', id: string, errors: ErrorObject[] | null | undefined) {
  const boundary = code === 'INVALID_INPUT' ? 'input' : 'output'
  const details = errors?.slice(0, 3).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
  return new ToolError(code, `tool "${id}" ${boundary} is invalid${details ? `: ${details}` : ''}`)
}

function requestText(value: unknown, label: string) {
  if (typeof value === 'string' && value.trim()) return value
  throw requestError(`${label} must be a non-empty string`)
}

function requestError(message: string) {
  return new ToolError('INVALID_REQUEST', message)
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw aborted(signal.reason)
}

function aborted(cause?: unknown) {
  return new ToolError('ABORTED', 'tool invocation was aborted', cause === undefined ? undefined : { cause })
}

export default ToolService
