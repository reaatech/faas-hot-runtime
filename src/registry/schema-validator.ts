import type { z } from 'zod';
import { FunctionDefinitionSchema } from '../types/schemas.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Schema Validator - validates function YAML configurations
 */
export class SchemaValidator {
  private existingFunctionNames: Set<string> = new Set();
  private existingToolNames: Set<string> = new Set();

  /**
   * Validate a function definition
   */
  validateFunctionDefinition(data: unknown): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate against Zod schema
    const parseResult = FunctionDefinitionSchema.safeParse(data);
    if (!parseResult.success) {
      parseResult.error.errors.forEach((err) => {
        errors.push(`${err.path.join('.')}: ${err.message}`);
      });
      return { valid: false, errors, warnings };
    }

    const functionDef = parseResult.data;

    // Check for duplicate function names
    if (this.existingFunctionNames.has(functionDef.name)) {
      errors.push(`Duplicate function name: ${functionDef.name}`);
    }

    // Check for duplicate MCP tool names
    if (functionDef.mcp.enabled) {
      if (this.existingToolNames.has(functionDef.mcp.tool_name)) {
        errors.push(`Duplicate MCP tool name: ${functionDef.mcp.tool_name}`);
      }
    }

    // Validate pool configuration
    if (functionDef.pool.min_size > functionDef.pool.max_size) {
      errors.push('pool.min_size cannot be greater than pool.max_size');
    }

    // Validate container resources
    if (!this.isValidCPU(functionDef.container.resources.cpu)) {
      errors.push(`Invalid CPU resource format: "${functionDef.container.resources.cpu}". Expected format like "250m" or "0.5"`);
    }
    if (!this.isValidMemory(functionDef.container.resources.memory)) {
      errors.push(`Invalid memory resource format: "${functionDef.container.resources.memory}". Expected format like "128Mi" or "1Gi"`);
    }

    // Validate triggers
    const httpPaths = new Set<string>();
    for (const trigger of functionDef.triggers) {
      if (trigger.type === 'http') {
        if (httpPaths.has(trigger.path)) {
          errors.push(`Duplicate HTTP path: ${trigger.path}`);
        }
        httpPaths.add(trigger.path);
      }
    }

    // Add warnings for best practices
    if (functionDef.pool.min_size === 0) {
      warnings.push('pool.min_size is 0 - cold starts may occur');
    }
    if (!functionDef.observability.tracing_enabled) {
      warnings.push('Tracing is disabled - observability will be limited');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check if a resource string is valid (e.g., "250m", "128Mi")
   */
  private isValidCPU(resource: string): boolean {
    return /^(\d+\.?\d*|\d*\.?\d+)m?$/.test(resource);
  }

  private isValidMemory(resource: string): boolean {
    return /^\d+(\.\d+)?(Ki|Mi|Gi|Ti)?$/.test(resource);
  }

  /**
   * Register a function name as existing
   */
  registerFunction(name: string, toolName?: string): void {
    this.existingFunctionNames.add(name);
    if (toolName) {
      this.existingToolNames.add(toolName);
    }
  }

  /**
   * Unregister a function name
   */
  unregisterFunction(name: string, toolName?: string): void {
    this.existingFunctionNames.delete(name);
    if (toolName) {
      this.existingToolNames.delete(toolName);
    }
  }

  /**
   * Clear all registered functions
   */
  clear(): void {
    this.existingFunctionNames.clear();
    this.existingToolNames.clear();
  }

  /**
   * Validate input against MCP tool schema
   */
  validateInput(schema: z.ZodType, input: unknown): z.SafeParseReturnType<unknown, unknown> {
    return schema.safeParse(input);
  }
}
