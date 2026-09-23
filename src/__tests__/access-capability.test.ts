import { describe, expect, it } from "vitest";
import { chooseAccessPath } from "../lib/access-capability.js";

// ALI-1003: choose API, CLI JSON or MCP by runtime capability. Pure decision table -
// the whole input space is 3 booleans (8 rows), so this enumerates it exhaustively
// rather than picking two examples per rule, which is the more robust form of the
// same discipline for a space this small (tdd.md).
describe("chooseAccessPath", () => {
  it.each([
    // hasDirectApiCredentials, hasShell, isMcpClient, expected path
    [true, false, false, "api"],
    [true, true, false, "api"],
    [true, false, true, "api"],
    [true, true, true, "api"], // direct API creds win even when shell + MCP are both available
    [false, true, false, "cli-json"],
    [false, true, true, "cli-json"], // shell-capable is the default even when MCP is also available
    [false, false, true, "mcp"],
    [false, false, false, null], // nothing detected - never guess
  ] as const)(
    "api=%s shell=%s mcp=%s -> %s",
    (hasDirectApiCredentials, hasShell, isMcpClient, expected) => {
      const result = chooseAccessPath({
        hasDirectApiCredentials,
        hasShell,
        isMcpClient,
      });
      expect(result.path).toBe(expected);
    },
  );

  it("explains a direct-API choice by naming the credentials, not the other capabilities", () => {
    const result = chooseAccessPath({
      hasDirectApiCredentials: true,
      hasShell: true,
      isMcpClient: true,
    });
    expect(result.reason).toMatch(/api|credential/i);
  });

  it("explains a shell choice by naming the shell, not MCP", () => {
    const result = chooseAccessPath({
      hasDirectApiCredentials: false,
      hasShell: true,
      isMcpClient: true,
    });
    expect(result.reason.toLowerCase()).toContain("shell");
  });

  it("explains an MCP choice by naming the absence of a shell, not forcing a shell detour", () => {
    const result = chooseAccessPath({
      hasDirectApiCredentials: false,
      hasShell: false,
      isMcpClient: true,
    });
    expect(result.reason.toLowerCase()).toContain("mcp");
  });

  it("explains a null choice by saying nothing was detected, never fabricating a path", () => {
    const result = chooseAccessPath({
      hasDirectApiCredentials: false,
      hasShell: false,
      isMcpClient: false,
    });
    expect(result.path).toBeNull();
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
