/**
 * @automaker/prompts
 * AI prompt templates for AutoMaker
 */

// Enhancement prompts
export {
  IMPROVE_SYSTEM_PROMPT,
  TECHNICAL_SYSTEM_PROMPT,
  SIMPLIFY_SYSTEM_PROMPT,
  ACCEPTANCE_SYSTEM_PROMPT,
  IMPROVE_EXAMPLES,
  TECHNICAL_EXAMPLES,
  SIMPLIFY_EXAMPLES,
  ACCEPTANCE_EXAMPLES,
  getEnhancementPrompt,
  getSystemPrompt,
  getExamples,
  buildUserPrompt,
  isValidEnhancementMode,
  getAvailableEnhancementModes,
} from './enhancement.js';

// QA Review prompts
export {
  QA_REVIEWER_SYSTEM_PROMPT,
  QA_FIXER_SYSTEM_PROMPT,
  buildReviewerPrompt,
  buildFixerPrompt,
  formatReviewComment,
} from './qa-review.js';

// Re-export types from @automaker/types
export type { EnhancementMode, EnhancementExample } from '@automaker/types';
