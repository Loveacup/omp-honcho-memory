declare module "@oh-my-pi/pi-coding-agent" {
  import type { z as ZodNamespace } from "zod";

  export type AgentMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | Array<{ type: string; text?: string }>;
    [name: string]: unknown;
  };

  export type AgentToolResult<TDetails = unknown> = {
    content: Array<{ type: "text"; text: string }>;
    details?: TDetails;
    isError?: boolean;
  };

  export type AgentToolUpdateCallback<TDetails = unknown> = (update: {
    content?: Array<{ type: "text"; text: string }>;
    details?: TDetails;
  }) => void;

  export type ExtensionContext = {
    cwd: string;
    mode: "tui" | "rpc" | "json" | "print";
    hasUI: boolean;
    sessionManager: {
      getSessionId(): string;
      getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
    };
    ui: {
      notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
      input(message: string, options?: { default?: string }): Promise<string | null>;
      confirm(message: string): Promise<boolean>;
      select<T>(
        message: string,
        options: { items: Array<{ label: string; value: T }> },
      ): Promise<T | null>;
      setStatus(key: string, text: string | undefined): void;
    };
    models: {
      list(): Array<unknown>;
      current(): unknown | undefined;
    };
    getSystemPrompt(): string[];
    hasPendingMessages(): boolean;
    isIdle(): boolean;
    abort(): void;
    shutdown(): void;
  };

  export type ExtensionCommandContext = ExtensionContext & {
    waitForIdle(): Promise<void>;
    newSession(options?: { cwd?: string }): Promise<void>;
    switchSession(sessionId: string): Promise<void>;
    reload(): Promise<void>;
  };

  export type ContextEvent = {
    type: "context";
    messages: AgentMessage[];
  };

  export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
  }

  export type BeforeAgentStartEvent = {
    type: "before_agent_start";
    prompt: string;
    images?: ImageContent[];
    systemPrompt: string[];
  };

  export type AgentEndEvent = {
    type: "agent_end";
    messages?: AgentMessage[];
  };


  export type ToolDefinition<TParams = unknown, TDetails = unknown> = {
    name: string;
    label?: string;
    description: string;
    parameters: TParams;
    hidden?: boolean;
    defaultInactive?: boolean;
    deferrable?: boolean;
    approval?: "read" | "write" | "exec";
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<TDetails>>;
  };

  export type ExtensionAPI = {
    readonly logger: unknown;
    readonly zod: typeof ZodNamespace;
    readonly pi: unknown;

    on(
      event: "session_start",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    on(
      event: "session_switch",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    on(
      event: "session_shutdown",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    on(
      event: "session_before_compact",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    on(
      event: "before_agent_start",
      handler: (
        event: BeforeAgentStartEvent,
        ctx: ExtensionContext,
      ) =>
        | Promise<{ systemPrompt?: string[] } | void>
        | { systemPrompt?: string[] }
        | void,
    ): void;
    on(
      event: "agent_end",
      handler: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    on(
      event: "context",
      handler: (
        event: ContextEvent,
        ctx: ExtensionContext,
      ) =>
        | Promise<{ messages?: AgentMessage[] } | void>
        | { messages?: AgentMessage[] }
        | void,
    ): void;

    registerTool<TParams = unknown, TDetails = unknown>(
      tool: ToolDefinition<TParams, TDetails>,
    ): void;
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string[], ctx: ExtensionCommandContext) => Promise<void> | void;
      },
    ): void;
    registerShortcut(
      shortcut: string,
      options: {
        description?: string;
        handler: (ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void;
    registerFlag(
      name: string,
      options: {
        description?: string;
        type: "boolean" | "string";
        default?: boolean | string;
      },
    ): void;

    setLabel(label: string): void;
    getFlag(name: string): boolean | string | undefined;

    sendMessage(
      message: unknown,
      options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
    ): void;
    sendUserMessage(
      content: string,
      options?: { deliverAs?: "steer" | "followUp" },
    ): void;
    appendEntry<T = unknown>(customType: string, data?: T): void;
    exec(
      command: string,
      args: string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    getActiveTools(): string[];
    getAllTools(): string[];
    setActiveTools(toolNames: string[]): Promise<void>;
    getCommands(): Array<{ name: string; description?: string }>;
    setModel(model: unknown): Promise<boolean>;
    getThinkingLevel(): string | undefined;
    setThinkingLevel(level: string): void;
    getSessionName(): string | undefined;
    setSessionName(name: string): Promise<void>;
  };
}
