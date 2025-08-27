import { Tool as MCPTool, ListToolsResult } from './schema/draft/schema';
import { Validator } from '@cfworker/json-schema';
import { 
  ParameterValidationError, 
  ToolNotFoundError, 
  ToolExecutionError,
  EntityTypeAlreadyExistsError,
  EntityTypeNotFoundError,
  EntityNotFoundError,
  EntityDeletedError
} from './errors';

// Handler function type for tool execution - uses generic object types and relies on schema validation
// This approach eliminates TypeScript type duplication by trusting runtime JSON schema validation
export type ToolHandler = (args?: Record<string, any>) => Promise<Record<string, any>> | Record<string, any>;

// Extended tool interface that includes MCP Tool plus handler and required outputSchema
export interface Tool extends MCPTool {
  name: string;          // Unique identifier for the tool
  description?: string;  // Human-readable description
  inputSchema: {         // JSON Schema for the tool's parameters
    type: "object";
    properties?: { [key: string]: any };  // Tool-specific parameters
    [key: string]: any;  // Allow additional JSON Schema properties
  };
  outputSchema: {        // Required JSON Schema for the tool's output (must be object per MCP spec)
    type: "object";
    properties?: { [key: string]: any };
    required?: string[];
    [key: string]: any;  // Allow additional JSON Schema properties
  };
  annotations?: {        // Optional hints about tool behavior
    title?: string;      // Human-readable title for the tool
    readOnlyHint?: boolean;    // If true, the tool does not modify its environment
    destructiveHint?: boolean; // If true, the tool may perform destructive updates
    idempotentHint?: boolean;  // If true, repeated calls with same args have no additional effect
    openWorldHint?: boolean;   // If true, tool interacts with external entities
  };
  handler: ToolHandler;  // Function to execute when the tool is called
}

export class ToolRegistry {
  readonly #registry: Map<string, Tool>;

  constructor() {
    this.#registry = new Map();
  }

  /**
   * Validates that a tool name follows the required format:
   * - Only lowercase letters, digits, hyphens (-), and underscores (_)
   * - Must not be empty
   */
  #validateToolName(name: string): void {
    if (!name) {
      throw new ParameterValidationError("Tool name cannot be empty");
    }
    
    const validPattern = /^[a-z0-9_-]+$/;
    if (!validPattern.test(name)) {
      throw new ParameterValidationError("Tool name must contain only lowercase letters, digits, hyphens (-), and underscores (_)");
    }
  }

  #getByName(name: string): Tool | null {
    return this.#registry.get(name) || null;
  }

  add(tool: Tool): string | null {
    this.#validateToolName(tool.name);
    
    // Validate inputSchema structure
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new ParameterValidationError("Tool must have inputSchema property as an object");
    }
    
    if (tool.inputSchema.type !== "object") {
      throw new ParameterValidationError("Tool inputSchema must have type 'object'");
    }
    
    // Validate outputSchema structure (now required)
    if (!tool.outputSchema || typeof tool.outputSchema !== 'object') {
      throw new ParameterValidationError("Tool must have outputSchema property as an object");
    }
    
    if (tool.outputSchema.type !== "object") {
      throw new ParameterValidationError("Tool outputSchema must have type 'object'");
    }
    
    // Validate handler is a function
    if (!tool.handler || typeof tool.handler !== 'function') {
      throw new ParameterValidationError("Tool must have handler property as a function");
    }
    
    const existingTool = this.#getByName(tool.name);
    
    if (existingTool) {
      throw new ParameterValidationError(`Tool with name "${tool.name}" is already registered`);
    }
    
    this.#registry.set(tool.name, tool);
    return tool.name;
  }

  /**
   * Validate parameters against a tool's input schema using @cfworker/json-schema
   */
  #validateParams(tool: Tool, params: any): void {
    const validator = new Validator(tool.inputSchema);
    const result = validator.validate(params ?? {});
    
    if (!result.valid) {
      // Collect all validation errors into a readable message
      const errors = result.errors.map(error => {
        // Log error object to understand its structure during development
        return error.error ?? 'Validation failed';
      }).join('; ');
      
      throw new ParameterValidationError(`Invalid params: ${errors}`);
    }
  }
  
  /**
   * Execute a tool by name with given arguments
   */
  execute(name: string, args?: { [key: string]: any }): any {
    const tool = this.#getByName(name);
    
    if (!tool) {
      throw new ToolNotFoundError(`Tool "${name}" not found`);
    }

    // Validate args against tool.inputSchema using @cfworker/json-schema
    this.#validateParams(tool, args);  // ParameterValidationError is caught by the caller
    
    try {
      return tool.handler(args);
    } catch (error) {
      // Let our custom error types propagate without wrapping
      if (error instanceof ParameterValidationError || 
          error instanceof ToolNotFoundError || 
          error instanceof ToolExecutionError ||
          error instanceof EntityTypeAlreadyExistsError ||
          error instanceof EntityTypeNotFoundError ||
          error instanceof EntityNotFoundError ||
          error instanceof EntityDeletedError) {
        throw error;
      }
      
      // Wrap other unknown errors in ToolExecutionError
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolExecutionError(`Tool execution failed: ${message}`);
    }
  }

  list(): Tool[] {
     return Array.from(this.#registry.values());
   }
  
  /**
   * Generate MCP-compatible list tools result
   */
  listToolsForMCP(): ListToolsResult {
    const tools = this.list();
    
    // Convert our Tool format to MCP Tool format
    const mcpTools: MCPTool[] = tools.map(tool => {
      const mcpTool: MCPTool = {
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema // Include outputSchema in MCP tools list
      };
      
      if (tool.description) {
        mcpTool.description = tool.description;
      }
      
      return mcpTool;
    });

    const result: ListToolsResult = {
      tools: mcpTools
    };

    // TODO: Add nextCursor only if we have one
    // For now, no pagination is implemented
    
    return result;
  }

}
