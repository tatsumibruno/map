import { type DispatchContext } from './types.js';

/**
 * The envelope is written to disk rather than typed into the terminal: it
 * keeps large context out of the TUI, survives restarts, and gives the agent a
 * stable artefact to re-read.
 *
 * `RESPONSE_SENTINEL` is what the runner scrolls back for when the agent could
 * not (or did not) write the response file.
 */
export const RESPONSE_SENTINEL_BEGIN = '<<<AGENTCTL_RESULT_BEGIN';
export const RESPONSE_SENTINEL_END = 'AGENTCTL_RESULT_END>>>';

export function buildSharedEnvelope(context: DispatchContext, providerNotes: string[]): string {
  const refs =
    context.contextRefs.length > 0
      ? context.contextRefs.map((ref) => `- \`${ref}\``).join('\n')
      : '- (no additional context files)';

  const effort =
    context.execution.reasoningEffort === undefined
      ? ''
      : `\n- Reasoning effort: \`${context.execution.reasoningEffort}\``;

  const notes =
    providerNotes.length > 0 ? `\n${providerNotes.map((n) => `- ${n}`).join('\n')}` : '';

  return `# agentctl task ${context.correlationId}

## Identity
- To: \`${context.agent.id}\` (${context.agent.displayName})
- From: \`${context.from}\`
- Correlation id: \`${context.correlationId}\`
- Message id: \`${context.messageId}\`
- Working directory: \`${context.workingDirectory}\`
- Provider: \`${context.execution.provider}\`
- Model: \`${context.execution.model}\`${effort}

## Objective
${context.body}

## Context references
Paths are relative to the project root (\`${context.workingDirectory}\`). Read only what you need.

${refs}

Shared project context lives in \`${relativeOrAbsolute(context.workingDirectory, context.contextDir)}\`.

## How to return your answer
1. Do the work.
2. Write your **complete final answer** to this exact file, overwriting it:

   \`${context.responsePath}\`

3. The file must contain only the answer — no terminal decoration, no progress log.
4. If you cannot write the file, print the answer to the terminal between these
   markers on their own lines instead:

   \`\`\`
   ${RESPONSE_SENTINEL_BEGIN}
   ...your answer...
   ${RESPONSE_SENTINEL_END}
   \`\`\`

5. If the task is impossible or under-specified, say so explicitly in the same
   place — a written failure is a valid result, silence is not.

## Constraints
- Stay inside the working directory unless the objective says otherwise.
- Never include credentials, tokens, or API keys in your answer.${notes}
`;
}

function relativeOrAbsolute(root: string, target: string): string {
  return target.startsWith(root) ? target.slice(root.length).replace(/^[/\\]/, '') : target;
}
