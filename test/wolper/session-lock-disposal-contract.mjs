/** Shared behavioral contract for the native source and installed compiled controller. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

export const sessionLockControllerPattern =
  /(?:^|\n)(?:export )?async function createEmbeddedAttemptSessionLockController(?:\$\d+)?\s*\(/;

export function loadSessionLockController(text) {
  const match = sessionLockControllerPattern.exec(text);
  assert.ok(match, "Native session lock controller is missing");
  const start = text.indexOf("async function ", match.index);
  const end = text.indexOf("\n}", start);
  assert.ok(end > start, "Native session lock controller boundary is missing");
  const body = text.slice(start, end + 2);
  // Evaluate only the actual controller function, never runtime initialization.
  // Stable synthetic transcript metadata isolates lock ownership from filesystem
  // policy; the contract supplies every acquisition and release.
  const dependencies = {
    AsyncLocalStorage,
    resolveSessionFileFenceKey: (filename) => filename,
    readSessionFileFingerprint: async () => ({ exists: false }),
    readSessionFileFingerprintSync: () => ({ exists: false }),
    readSessionFileFenceSnapshot: async () => ({ fingerprint: { exists: false } }),
    sameSessionFileFingerprint: (left, right) => left?.exists === false && right?.exists === false,
    ownedSessionFileWrites: new Map(),
    trustSessionFileState: () => 0,
    recordOwnedSessionFileWrite: () => 0,
    isTrustedSessionFileState: () => true,
    isSessionWriteLockTimeoutError: () => false,
    EmbeddedAttemptSessionTakeoverError: Error,
    waitForSessionEventQueue: async () => {},
    sessionFenceAdvanceIsBenign: async () => false,
    sessionFenceRewriteIsBenign: async () => false,
  };
  const bindings = { __name: (fn) => fn, ...dependencies };
  // Bind the pinned bundler's suffixed imports without rewriting native code.
  for (const [name, value] of Object.entries(dependencies)) {
    for (const alias of body.matchAll(new RegExp(`\\b${name}\\$\\d+\\b`, "g"))) {
      bindings[alias[0]] = value;
    }
  }
  // Execute only repository-owned source extracted for this contract probe.
  // oxlint-disable-next-line typescript/no-implied-eval
  return new Function(...Object.keys(bindings), `return (${body});`)(...Object.values(bindings));
}

function deferredSessionLock() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sessionLockOptions = {
  sessionFile: "/synthetic-session-lock-contract/session.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

export async function verifyLateSessionLockAcquisitionReleased(create) {
  const acquisitionStarted = deferredSessionLock();
  const acquisition = deferredSessionLock();
  let acquired = 0;
  let lateReleased = 0;
  const controller = await create({
    lockOptions: sessionLockOptions,
    acquireSessionWriteLock: async () => {
      acquired += 1;
      if (acquired === 1) {
        return { release: async () => {} };
      }
      acquisitionStarted.resolve();
      return await acquisition.promise;
    },
  });
  await controller.releaseForPrompt();
  const pendingReacquire = controller.reacquireAfterPrompt();
  await acquisitionStarted.promise;
  // Abort settlement is bounded. Teardown can finish while the provider's
  // stream-finally acquisition still waits behind a cleanup writer.
  await controller.dispose();
  acquisition.resolve({
    release: async () => {
      lateReleased += 1;
    },
  });
  await pendingReacquire;
  try {
    assert.equal(lateReleased, 1, "Late prompt acquisition leaked a live-process session lock");
  } finally {
    await controller.dispose();
  }
}

export async function verifySessionLockReacquireAfterDisposeBlocked(create) {
  let acquired = 0;
  let released = 0;
  const controller = await create({
    lockOptions: sessionLockOptions,
    acquireSessionWriteLock: async () => {
      acquired += 1;
      return {
        release: async () => {
          released += 1;
        },
      };
    },
  });
  await controller.dispose();
  await controller.reacquireAfterPrompt();
  try {
    assert.equal(acquired, 1, "Disposed attempt acquired another retained session lock");
    assert.equal(released, 1);
  } finally {
    await controller.dispose();
  }
}

export async function verifySessionLockDisposal(create) {
  await verifyLateSessionLockAcquisitionReleased(create);
  await verifySessionLockReacquireAfterDisposeBlocked(create);
  return { lateAcquireReleased: true, reacquireAfterDisposeBlocked: true };
}
