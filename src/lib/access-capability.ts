/**
 * ALI-1003: choose API, CLI JSON or MCP by runtime capability.
 *
 * The matrix here is the ticket's own "Outcome" section, not an invented policy:
 *   - a runtime with direct API/SDK credentials configured talks to the API directly
 *   - a shell-capable terminal agent gets the installed CLI's --json output as a
 *     reasonable default
 *   - an MCP-native client with no shell gets MCP - never a forced shell detour
 *
 * This is deliberately pure and does no capability DETECTION (no filesystem, no TTY
 * check, no env var reads) - callers supply already-known booleans. Detection belongs
 * to whatever calls this (e.g. `align setup`), which has its own established patterns
 * (isTTY, detectEditors) and its own tests; keeping this function pure is what makes
 * the decision table exhaustively testable and keeps this module free of the
 * "no forced migration" risk - it recommends, it does not act.
 */

export type AccessPath = "api" | "cli-json" | "mcp";

export interface AccessPathCapability {
  /** A direct API/SDK credential is already configured for this runtime. */
  hasDirectApiCredentials: boolean;
  /** This runtime can execute a shell (spawn the installed CLI binary). */
  hasShell: boolean;
  /** This runtime is itself an MCP client. */
  isMcpClient: boolean;
}

export interface AccessPathChoice {
  /** The recommended path, or null when no capability was detected - never a guess. */
  path: AccessPath | null;
  /** Why this path was chosen, for `align setup` to surface to the person configuring it. */
  reason: string;
}

export function chooseAccessPath(
  capability: AccessPathCapability,
): AccessPathChoice {
  if (capability.hasDirectApiCredentials) {
    return {
      path: "api",
      reason:
        "Direct API credentials are configured for this runtime; use the API/SDK directly for structured calls.",
    };
  }
  if (capability.hasShell) {
    return {
      path: "cli-json",
      reason:
        "This runtime can execute a shell; the installed CLI's --json output is a reasonable default when configured for the intended graph.",
    };
  }
  if (capability.isMcpClient) {
    return {
      path: "mcp",
      reason:
        "This is an MCP-native client with no shell available; MCP is first-class here - do not force a shell detour.",
    };
  }
  return {
    path: null,
    reason:
      "No direct API credentials, shell, or MCP client capability was detected; declare at least one before an access path can be chosen.",
  };
}
