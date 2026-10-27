import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { BtwController } from './controller.js';
export type BtwControllerFor = (sessionId: SessionId) => BtwController | undefined;
export declare function createBtwInputSource(controllerFor: BtwControllerFor): InputTriggerSource;
