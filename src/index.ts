/** Public API surface, for embedding agentctl in another Node program. */

export * from './domain/types.js';
export * from './domain/schemas.js';
export * from './domain/hierarchy.js';

export {
  AgentctlError,
  ValidationError,
  NotFoundError,
  ConflictError,
  TransportError,
} from './core/errors.js';

export { AgentRegistry } from './app/agentRegistry.js';
export { ContextStore, ProjectStore } from './app/projectStore.js';
export { EventLog } from './app/eventLog.js';
export { GlobalConfigStore } from './app/globalConfig.js';
export { MessageBus } from './app/messageBus.js';
export { TaskService, executionConfigFor, isTerminal } from './app/taskService.js';
export { RunnerSupervisor } from './app/runnerSupervisor.js';
export { Workspace } from './app/workspace.js';
export { runDoctor } from './app/doctor.js';

export { AgentWorker } from './runner/agentWorker.js';
export { CoordinatorProcess } from './runner/coordinator.js';

export { getProvider, listProviders, PROVIDER_IDS } from './providers/registry.js';
export type { ProviderAdapter, ModelDescriptor, DispatchContext } from './providers/types.js';

export { createTmuxClient } from './infra/tmux/tmux.js';
export type { TmuxClient, TmuxSessionInfo } from './infra/tmux/tmux.js';

export { buildProgram, run, BIN_NAME, VERSION } from './cli/index.js';
