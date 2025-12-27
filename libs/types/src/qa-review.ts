/**
 * QA Review Types for AutoMaker AI Reviewer System
 *
 * Types for the automated code review system that runs after
 * implementation is complete and a PR is opened.
 */

/**
 * Severity levels for review issues
 */
export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'suggestion';

/**
 * Categories of issues that can be identified
 */
export type ReviewCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'code-style'
  | 'documentation'
  | 'testing'
  | 'architecture';

/**
 * A single issue identified during code review
 */
export interface ReviewIssue {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  description: string;
  suggestion?: string;
  codeSnippet?: string;
}

/**
 * Result of a single review iteration
 */
export interface ReviewResult {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
  timestamp: string;
  iteration: number;
}

/**
 * Status of the QA review process
 */
export type QAReviewStatus =
  | 'pending'
  | 'reviewing'
  | 'fixing'
  | 'approved'
  | 'max_iterations_reached'
  | 'failed';

/**
 * State of the QA review process for a feature
 */
export interface QAReviewState {
  status: QAReviewStatus;
  iteration: number;
  maxIterations: number;
  reviews: ReviewResult[];
  currentReviewId?: string;
  prNumber?: number;
  prUrl?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/**
 * Configuration for QA review behavior
 */
export interface QAReviewConfig {
  /** Maximum number of review/fix iterations (default: 3) */
  maxIterations: number;
  /** Whether to post comments to GitHub PR (default: true) */
  autoPostComments: boolean;
  /** Model to use for reviewer agent */
  reviewerModel?: string;
  /** Model to use for fixer agent */
  fixerModel?: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_QA_REVIEW_CONFIG: QAReviewConfig = {
  maxIterations: 3,
  autoPostComments: true,
};

/**
 * Event types emitted during QA review
 */
export type QAReviewEventType =
  | 'qa_review_started'
  | 'qa_review_progress'
  | 'qa_review_issues_found'
  | 'qa_review_approved'
  | 'qa_fixer_started'
  | 'qa_fixer_progress'
  | 'qa_fixer_complete'
  | 'qa_review_complete'
  | 'qa_review_max_iterations'
  | 'qa_review_error';

/**
 * Event payload for QA review WebSocket events
 */
export interface QAReviewEvent {
  type: QAReviewEventType;
  featureId: string;
  projectPath: string;
  iteration?: number;
  maxIterations?: number;
  issues?: ReviewIssue[];
  prNumber?: number;
  prUrl?: string;
  error?: string;
  message?: string;
}
