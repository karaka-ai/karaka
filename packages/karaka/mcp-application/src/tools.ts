/** Application MCP input validation before authorization or remote dispatch. */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { assertObjectJsonSchema, ToolArgsError, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * Require a supported object input schema and validate arguments before invoking an MCP executor.
 * @param definition - DSH MCP definition retaining its original server input schema.
 * @param tool - Original MCP descriptor; task-required tools retain the upstream unsupported-task rejection.
 * @returns Definition with dialect annotation removed and local argument rejection; invalid schemas throw.
 */
export function prepareApplicationTool(definition: ToolDefinition, tool: Readonly<Tool>): ToolDefinition {
  const { $schema: _dialect, ...parameters } = definition.parameters
  assertObjectJsonSchema(parameters)
  if (tool.execution?.taskSupport === 'required') return { ...definition, parameters }
  return {
    ...definition,
    parameters,
    async execute(args, execution) {
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return definition.execute(args, execution)
    },
  }
}
