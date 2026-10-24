// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

// Minimal declarations for the `resolvers` proposed API, limited to what this extension uses.
// Signatures follow vscode.proposed.resolvers.d.ts of the VS Code release the IDE is based on
// (1.103); confirmed to work with Kiro 1.4.26, whose base is VS Code 1.131.0. Proposed APIs can
// change in any release; compare against the IDE's base version when updating `engines.vscode`.
import 'vscode';

declare module 'vscode' {
  export interface ManagedMessagePassing {
    readonly onDidReceiveMessage: Event<Uint8Array>;
    readonly onDidClose: Event<Error | undefined>;
    readonly onDidEnd: Event<void>;
    send(data: Uint8Array): void;
    end(): void;
    drain?(): Thenable<void>;
  }

  export class ManagedResolvedAuthority {
    readonly makeConnection: () => Thenable<ManagedMessagePassing>;
    readonly connectionToken: string | undefined;
    constructor(makeConnection: () => Thenable<ManagedMessagePassing>, connectionToken?: string);
  }

  export interface RemoteAuthorityResolverContext {
    readonly resolveAttempt: number;
  }

  export interface TunnelOptions {
    remoteAddress: { port: number; host: string };
    /** The local port the IDE would like; the factory may choose another one. */
    localAddressPort?: number;
    label?: string;
    privacy?: string;
    protocol?: string;
  }

  export interface TunnelDescription {
    remoteAddress: { port: number; host: string };
    localAddress: { port: number; host: string } | string;
    privacy?: string;
    protocol?: string;
  }

  export interface Tunnel extends TunnelDescription {
    readonly onDidDispose: Event<void>;
    dispose(): void | Thenable<void>;
  }

  export interface TunnelCreationOptions {
    elevation: boolean;
  }

  export interface TunnelInformation {
    /** Tunnels the environment already provides; they appear as forwarded in the Ports view. */
    environmentTunnels?: TunnelDescription[];
    tunnelFeatures?: { elevation: boolean; privacyOptions: unknown[]; protocol?: boolean };
  }

  export type ResolverResult = ManagedResolvedAuthority & TunnelInformation;

  export interface RemoteAuthorityResolver {
    resolve(
      authority: string,
      context: RemoteAuthorityResolverContext,
    ): ResolverResult | Thenable<ResolverResult>;
    /** Called for every port the IDE forwards (manually or automatically). */
    tunnelFactory?(
      tunnelOptions: TunnelOptions,
      tunnelCreationOptions: TunnelCreationOptions,
    ): Thenable<Tunnel> | undefined;
  }

  export class RemoteAuthorityResolverError extends Error {
    static NotAvailable(message?: string, handled?: boolean): RemoteAuthorityResolverError;
    static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError;
    constructor(message?: string);
  }

  export namespace workspace {
    export function registerRemoteAuthorityResolver(
      authorityPrefix: string,
      resolver: RemoteAuthorityResolver,
    ): Disposable;
  }
}
