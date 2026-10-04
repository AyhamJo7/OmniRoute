import type { AgentProfile } from "./schema";

type Body = Record<string, unknown>;
function record(value: unknown): Body | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Body)
    : null;
}
function systemMessages(value: unknown): Body[] {
  return Array.isArray(value)
    ? value
        .map(record)
        .filter((message): message is Body =>
          Boolean(message && (message.role === "system" || message.role === "developer"))
        )
    : [];
}
function prependText(value: unknown, text: string): unknown {
  if (typeof value === "string") return value.includes(text) ? value : `${text}\n\n${value}`;
  if (Array.isArray(value)) {
    if (
      value.some(
        (item) =>
          typeof record(item)?.text === "string" && String(record(item)?.text).includes(text)
      )
    )
      return value;
    return [{ type: "text", text }, ...value];
  }
  return text;
}
function toolName(value: unknown): string | null {
  const tool = record(value);
  const name = record(tool?.function)?.name ?? tool?.name;
  return typeof name === "string" ? name : null;
}

function restoreNativeSystem(native: unknown, current: unknown): unknown {
  if (Array.isArray(native)) {
    if (Array.isArray(current)) {
      const present = new Set(current.map((block) => JSON.stringify(block)));
      return [...current, ...native.filter((block) => !present.has(JSON.stringify(block)))];
    }
    return typeof current === "string" && current ? prependText(native, current) : native;
  }
  if (typeof native === "string") {
    if (typeof current === "string") {
      return current.includes(native) ? current : `${current}\n\n${native}`;
    }
    return current === undefined ? native : prependText(current, native);
  }
  return current;
}

/** Restore native client prompts after target-combo overrides, without changing ordinary combos. */
export function prepareAgentRequestBody(inbound: Body, current: Body, profile: AgentProfile): Body {
  const next: Body = { ...current };
  if ("system" in inbound) {
    next.system = restoreNativeSystem(inbound.system, current.system);
    const extra = systemMessages(current.messages).filter((message) => message.role === "system");
    for (const message of extra) {
      if (typeof message.content === "string")
        next.system = prependText(next.system, message.content);
    }
    if (Array.isArray(current.messages)) {
      next.messages = current.messages.filter((message) => record(message)?.role !== "system");
    }
  } else if ("instructions" in inbound || "input" in inbound) {
    next.instructions = restoreNativeSystem(inbound.instructions ?? "", current.instructions);
  } else if (Array.isArray(current.messages)) {
    const existing = new Set(current.messages.map((message) => JSON.stringify(message)));
    const missing = systemMessages(inbound.messages).filter(
      (message) => !existing.has(JSON.stringify(message))
    );
    next.messages = [...missing, ...current.messages];
  }
  const nativeInstruction = record(inbound.systemInstruction);
  if (nativeInstruction) {
    const currentInstruction = record(current.systemInstruction);
    const currentParts = Array.isArray(currentInstruction?.parts) ? currentInstruction.parts : [];
    const nativeParts = Array.isArray(nativeInstruction.parts) ? nativeInstruction.parts : [];
    const present = new Set(currentParts.map((part) => JSON.stringify(part)));
    next.systemInstruction = {
      ...nativeInstruction,
      ...currentInstruction,
      parts: [...currentParts, ...nativeParts.filter((part) => !present.has(JSON.stringify(part)))],
    };
  }
  const instructions = profile.instructions.trim();
  if (instructions && profile.injection !== "client") {
    if ("system" in inbound) next.system = prependText(next.system, instructions);
    else if ("instructions" in inbound || "input" in inbound)
      next.instructions = prependText(next.instructions, instructions);
    else if (record(inbound.systemInstruction)) {
      const native = record(next.systemInstruction)!;
      const parts = Array.isArray(native.parts) ? native.parts : [];
      const containsRole = parts.some(
        (part) =>
          typeof record(part)?.text === "string" &&
          String(record(part)?.text).includes(instructions)
      );
      next.systemInstruction = {
        ...native,
        parts: containsRole ? parts : [{ text: instructions }, ...parts],
      };
    } else {
      const messages = Array.isArray(next.messages) ? next.messages : [];
      const containsRole = systemMessages(messages).some(
        (message) => typeof message.content === "string" && message.content.includes(instructions)
      );
      if (!containsRole) next.messages = [{ role: "system", content: instructions }, ...messages];
    }
  }
  if (profile.toolAllowlist !== null && Array.isArray(current.tools)) {
    const allowed = new Set(profile.toolAllowlist);
    next.tools = current.tools.flatMap((tool) => {
      const declarations = record(tool)?.functionDeclarations;
      if (Array.isArray(declarations)) {
        const filtered = declarations.filter((declaration) =>
          allowed.has(toolName(declaration) ?? "")
        );
        return filtered.length ? [{ ...record(tool), functionDeclarations: filtered }] : [];
      }
      return allowed.has(toolName(tool) ?? "") ? [tool] : [];
    });
  }
  return next;
}

/** A forced tool choice must remain satisfiable after the literal allowlist filter. */
export function hasForbiddenAgentToolChoice(body: Body, profile: AgentProfile): boolean {
  if (profile.toolAllowlist === null) return false;
  const choice = record(body.tool_choice);
  const forcedName = record(choice?.function)?.name ?? choice?.name;
  if (typeof forcedName === "string" && !profile.toolAllowlist.includes(forcedName)) return true;
  const functionConfig = record(record(body.toolConfig)?.functionCallingConfig);
  const forcedNames = functionConfig?.allowedFunctionNames;
  if (
    Array.isArray(forcedNames) &&
    forcedNames.some((name) => typeof name !== "string" || !profile.toolAllowlist!.includes(name))
  )
    return true;
  return (
    (body.tool_choice === "required" || choice?.type === "any" || functionConfig?.mode === "ANY") &&
    (!Array.isArray(body.tools) || body.tools.length === 0)
  );
}

const MAX_ANTHROPIC_CACHE_BOUNDARIES = 4;
export function exceedsAgentCacheBoundaries(body: Body): boolean {
  // Only protocol blocks are breakpoints: tool schemas/inputs may legitimately
  // contain a property named cache_control. Automatic caching reserves one slot.
  let count = record(body.cache_control) ? 1 : 0;
  const pending: unknown[] = [];
  function addBlocks(value: unknown): void {
    if (Array.isArray(value)) for (const block of value) pending.push(block);
  }
  addBlocks(body.system);
  addBlocks(body.tools);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) addBlocks(record(message)?.content);
  }
  while (pending.length > 0) {
    const block = record(pending.pop());
    if (!block) continue;
    if (block.cache_control !== undefined && block.cache_control !== null) count += 1;
    if (count > MAX_ANTHROPIC_CACHE_BOUNDARIES) return true;
    if (block.type === "tool_result") addBlocks(block.content);
  }
  return false;
}
