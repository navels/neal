import { writeConsultMarkdown } from '../consult.js';
import { getFinalCompletionReviewArtifactPath, writeFinalCompletionReviewMarkdown } from '../final-completion-review.js';
import { writePlanProgressArtifacts } from '../progress.js';
import { writeReviewMarkdown } from '../review.js';
import type { OrchestrationState } from '../types.js';

export async function writeExecutionArtifacts(state: OrchestrationState) {
  await writeReviewMarkdown(state.reviewMarkdownPath, state);
  await writeConsultMarkdown(state.consultMarkdownPath, state);
  await writePlanProgressArtifacts(state);
  if (state.topLevelMode === 'execute' && (state.finalCompletionSummary || state.finalCompletionReviewVerdict)) {
    await writeFinalCompletionReviewMarkdown(getFinalCompletionReviewArtifactPath(state.runDir), state);
  }
}
