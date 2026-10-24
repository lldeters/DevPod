// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Calls a function the way the IDE calls a resolver's `tunnelFactory`: it keeps the function in a
 * field of its own object and invokes it from there, so `this` is not the resolver. A factory that
 * uses `this` works when called as `resolver.tunnelFactory(...)` and fails in the real IDE.
 */
export function callLikeTheIde<A extends unknown[], R>(factory: (...args: A) => R, ...args: A): R {
  const host = { forwardPortProvider: factory };
  return host.forwardPortProvider(...args);
}
