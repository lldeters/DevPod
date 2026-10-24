// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

/** Replaced by esbuild with the short commit hash of the build (see esbuild.mjs). */
declare const __BUILD_ID__: string | undefined;

/** Identifies the build in the log and in the diagnostics; the version number alone does not. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
