/** Exercise the actual native persistence hook without initializing a Gateway. */
import assert from "node:assert/strict";

export function loadHeartbeatPersistenceGuard(source) {
  const match = /(?:^|\n)(?:export )?function guardSessionManager(?:\$\d+)?\s*\(/.exec(source);
  assert.ok(match, "Native session persistence guard is missing");
  const start = source.indexOf("function ", match.index);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, "Native persistence guard boundary is missing");
  const body = source.slice(start, end + 2);
  let hooks;
  const dependencies = {
    getGlobalHookRunner: () => undefined,
    redactTranscriptMessage: (message) => message,
    installSessionToolResultGuard: (_manager, options) => {
      hooks = options;
      return { flushPendingToolResults() {}, clearPendingToolResults() {} };
    },
  };
  const bindings = { __name: (fn) => fn, ...dependencies };
  for (const [name, value] of Object.entries(dependencies)) {
    for (const alias of body.matchAll(new RegExp(`\\b${name}\\$\\d+\\b`, "g"))) {
      bindings[alias[0]] = value;
    }
  }
  // Execute only repository-owned source extracted for this contract probe.
  // oxlint-disable-next-line typescript/no-implied-eval
  const guard = new Function(...Object.keys(bindings), `return (${body});`)(
    ...Object.values(bindings),
  );
  return (message, options = {}) => {
    guard({}, options);
    return hooks.beforeMessageWriteHook({ message })?.message ?? message;
  };
}

export function verifyHeartbeatPersistenceIdentity(persist) {
  const original = {
    role: "assistant",
    content: [{ type: "text", text: "Reminder" }],
    __openclaw: { id: "native-message", seq: 241 },
  };
  const result = persist(original, { heartbeatRunId: "heartbeat-run" });
  assert.deepEqual(
    result["__openclaw"],
    {
      id: "native-message",
      seq: 241,
      runId: "heartbeat-run",
      isHeartbeat: true,
    },
    "Heartbeat persistence lost the identity needed to join its final event",
  );
  assert.deepEqual(original["__openclaw"], { id: "native-message", seq: 241 });
  assert.deepEqual(result.content, original.content);
  for (const role of ["user", "toolResult"]) {
    const message = { role, content: "Unrelated" };
    assert.deepEqual(persist(message, { heartbeatRunId: "heartbeat-run" }), message);
  }
  assert.deepEqual(
    persist(original),
    original,
    "Ordinary turns must retain their existing metadata",
  );
  return { heartbeatRunIdentity: true, ordinaryMessagesUnchanged: true };
}
