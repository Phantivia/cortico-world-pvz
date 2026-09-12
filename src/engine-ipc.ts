import type {
  EventEnvelope,
  EventTag,
  WorldConsoleDecl,
  PushOptions,
  ToolCallContext,
  TriggerMode,
} from 'cortico/core/types.ts';
import type { LogNote } from 'cortico/core/ipc-logger.ts';
import type { PvzConfigSection } from './config.ts';
import type { PvzPhotoFrameReply } from './world.ts';

export type PvzOwnershipPhase = 'suspended' | 'resumed';

export interface PvzOwnershipIdentity {
  mode: 'launch' | 'attach';
  phase: PvzOwnershipPhase;
  pid: number;
  ownerToken: string;
  creationTime: string;
  primaryThreadId: number | null;
  artifactDir: string;
}

export interface EngineInit {
  cfg: PvzConfigSection;
  timezone: string;
  botName: string;
  taskIdBase: number;
  ownedProcess: boolean;
  ownerToken: string;
  recoveryIdentity: PvzOwnershipIdentity | null;
  ownershipFile: string;
}

export type EngineInitReply = PvzOwnershipIdentity;

export type EngineRequest =
  | { kind: 'init'; init: EngineInit }
  | {
      kind: 'tool'; name: string; args: Record<string, unknown>; role: string;
      callId: string | null; round: number | null;
    }
  | { kind: 'photo-frame' }
  | { kind: 'handoff-snapshot' }
  | { kind: 'render-deferred'; type: string; renderId?: number }
  | { kind: 'shutdown' };

export function toolCallContextFromRequest(
  request: Extract<EngineRequest, { kind: 'tool' }>,
): Pick<ToolCallContext, 'role' | 'callId' | 'round'> {
  return {
    role: request.role,
    ...(request.callId !== null ? { callId: request.callId } : {}),
    ...(request.round !== null ? { round: request.round } : {}),
  };
}

export type EngineCast =
  | { kind: 'config'; cfg: PvzConfigSection }
  | { kind: 'cancel-action' };

export type EngineNote =
  | LogNote
  | { kind: 'prelaunch-failure'; error: string }
  | ({ kind: 'ownership' } & PvzOwnershipIdentity)
  | {
      kind: 'arm-deferred';
      type: string;
      renderId?: number;
      senderKey?: string;
      meta?: Record<string, unknown>;
      tags?: readonly EventTag[];
      trigger?: TriggerMode;
    }
  | {
      kind: 'status';
      decl: Pick<WorldConsoleDecl, 'lamps' | 'badges' | 'links'>;
    };

export type HostRequest =
  | {
      kind: 'push';
      evt: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { origin?: EventEnvelope['origin']; blobs?: undefined };
      opts?: PushOptions;
    };

export type MainToChild =
  | { t: 'req'; id: number; req: EngineRequest }
  | { t: 'hrep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'cast'; cast: EngineCast };

export type ChildToMain =
  | { t: 'rep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'hreq'; id: number; req: HostRequest }
  | { t: 'note'; note: EngineNote };

export type { PvzPhotoFrameReply };
