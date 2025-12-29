/**
 * QA Review Service - AI-powered code review workflow
 *
 * Manages:
 * - PR review with AI reviewer agent
 * - Issue detection and GitHub comment posting
 * - Auto-fix loop with fixer agent
 * - Iteration management (max N iterations)
 */

import { ProviderFactory } from '../providers/provider-factory.js';
import type {
  QAReviewState,
  QAReviewConfig,
  ReviewResult,
  ReviewIssue,
  QAReviewEvent,
  QAReviewEventType,
} from '@automaker/types';
import { DEFAULT_QA_REVIEW_CONFIG } from '@automaker/types';
import { resolveModelString, DEFAULT_MODELS } from '@automaker/model-resolver';
import { getFeatureDir } from '@automaker/platform';
import {
  QA_REVIEWER_SYSTEM_PROMPT,
  QA_FIXER_SYSTEM_PROMPT,
  buildReviewerPrompt,
  buildFixerPrompt,
  formatReviewComment,
} from '@automaker/prompts';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import * as secureFs from '../lib/secure-fs.js';
import type { EventEmitter } from '../lib/events.js';

const execAsync = promisify(exec);

interface ActiveReview {
  featureId: string;
  projectPath: string;
  worktreePath: string;
  prNumber: number;
  prUrl: string;
  abortController: AbortController;
  state: QAReviewState;
}

export class QAReviewService {
  private events: EventEmitter;
  private activeReviews = new Map<string, ActiveReview>();

  constructor(events: EventEmitter) {
    this.events = events;
  }

  /**
   * Start the QA review process for a feature after PR creation
   */
  async startReview(
    projectPath: string,
    featureId: string,
    worktreePath: string,
    prNumber: number,
    prUrl: string,
    specification: string,
    featureDescription: string,
    config: Partial<QAReviewConfig> = {},
    model?: string
  ): Promise<void> {
    if (this.activeReviews.has(featureId)) {
      throw new Error(`Review already in progress for feature ${featureId}`);
    }

    const fullConfig: QAReviewConfig = { ...DEFAULT_QA_REVIEW_CONFIG, ...config };
    const abortController = new AbortController();

    const initialState: QAReviewState = {
      status: 'reviewing',
      iteration: 1,
      maxIterations: fullConfig.maxIterations,
      reviews: [],
      prNumber,
      prUrl,
      startedAt: new Date().toISOString(),
    };

    const review: ActiveReview = {
      featureId,
      projectPath,
      worktreePath,
      prNumber,
      prUrl,
      abortController,
      state: initialState,
    };

    this.activeReviews.set(featureId, review);

    // Update feature status to ai_review
    await this.updateFeatureStatus(projectPath, featureId, 'ai_review');

    // Save initial state
    await this.saveQAReviewState(projectPath, featureId, initialState);

    // Emit start event
    this.emitEvent('qa_review_started', {
      featureId,
      projectPath,
      prNumber,
      prUrl,
      maxIterations: fullConfig.maxIterations,
    });

    // Run the review loop
    try {
      await this.runReviewLoop(review, fullConfig, specification, featureDescription, model);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      review.state.status = 'failed';
      review.state.error = errorMessage;
      await this.saveQAReviewState(projectPath, featureId, review.state);

      this.emitEvent('qa_review_error', {
        featureId,
        projectPath,
        error: errorMessage,
      });
    } finally {
      this.activeReviews.delete(featureId);
    }
  }

  /**
   * Stop an active review
   */
  stopReview(featureId: string): boolean {
    const review = this.activeReviews.get(featureId);
    if (!review) return false;

    review.abortController.abort();
    this.activeReviews.delete(featureId);
    return true;
  }

  /**
   * Main review loop - runs reviewer, then fixer if issues found
   */
  private async runReviewLoop(
    review: ActiveReview,
    config: QAReviewConfig,
    specification: string,
    featureDescription: string,
    model?: string
  ): Promise<void> {
    const { featureId, projectPath, worktreePath, prNumber, abortController } = review;
    const resolvedModel = resolveModelString(config.reviewerModel || model, DEFAULT_MODELS.claude);

    console.log(
      `[QAReview] Starting review loop for feature ${featureId}, max iterations: ${config.maxIterations}`
    );

    while (review.state.iteration <= config.maxIterations) {
      if (abortController.signal.aborted) {
        throw new Error('Review cancelled');
      }

      console.log(`[QAReview] Iteration ${review.state.iteration}: Getting PR diff...`);

      // 1. Get PR diff
      const diff = await this.getPRDiff(worktreePath, prNumber);
      console.log(`[QAReview] Got PR diff (${diff.length} chars)`);

      // 2. Get previous issues (for re-review)
      const previousIssues =
        review.state.reviews.length > 0
          ? review.state.reviews[review.state.reviews.length - 1].issues
          : undefined;

      // 3. Run reviewer agent
      console.log(`[QAReview] Running AI reviewer agent...`);
      this.emitEvent('qa_review_progress', {
        featureId,
        projectPath,
        iteration: review.state.iteration,
        message: `Running AI review (iteration ${review.state.iteration}/${config.maxIterations})...`,
      });

      const reviewResult = await this.runReviewer(
        worktreePath,
        diff,
        specification,
        featureDescription,
        review.state.iteration,
        previousIssues,
        resolvedModel,
        abortController
      );

      console.log(
        `[QAReview] Reviewer completed. Approved: ${reviewResult.approved}, Issues: ${reviewResult.issues.length}`
      );
      review.state.reviews.push(reviewResult);

      // 4. Post review comments to GitHub if configured
      if (config.autoPostComments) {
        console.log(`[QAReview] Posting review to GitHub PR #${prNumber}...`);
        await this.postInlineReviewComments(
          worktreePath,
          prNumber,
          reviewResult.issues,
          review.state.iteration,
          reviewResult.approved,
          reviewResult.summary
        );
        console.log(`[QAReview] Review posted to GitHub`);
      }

      // 5. Check if approved
      if (reviewResult.approved) {
        console.log(`[QAReview] PR approved by AI reviewer, moving to waiting_approval`);
        review.state.status = 'approved';
        review.state.completedAt = new Date().toISOString();
        await this.saveQAReviewState(projectPath, featureId, review.state);

        // Update feature status to waiting_approval
        await this.updateFeatureStatus(projectPath, featureId, 'waiting_approval');

        this.emitEvent('qa_review_approved', {
          featureId,
          projectPath,
          prNumber,
          iteration: review.state.iteration,
          message: 'PR approved by AI reviewer',
        });
        console.log(`[QAReview] Review complete for feature ${featureId}`);
        return;
      }

      // 6. Issues found - emit event
      console.log(`[QAReview] Issues found: ${reviewResult.issues.length}`);
      this.emitEvent('qa_review_issues_found', {
        featureId,
        projectPath,
        iteration: review.state.iteration,
        issues: reviewResult.issues,
      });

      // 7. Check if max iterations reached
      if (review.state.iteration >= config.maxIterations) {
        console.log(
          `[QAReview] Max iterations (${config.maxIterations}) reached, moving to waiting_approval`
        );
        review.state.status = 'max_iterations_reached';
        review.state.completedAt = new Date().toISOString();
        await this.saveQAReviewState(projectPath, featureId, review.state);

        // Still move to waiting_approval so human can review
        await this.updateFeatureStatus(projectPath, featureId, 'waiting_approval');

        this.emitEvent('qa_review_max_iterations', {
          featureId,
          projectPath,
          prNumber,
          maxIterations: config.maxIterations,
          issues: reviewResult.issues,
        });
        console.log(`[QAReview] Review complete (max iterations) for feature ${featureId}`);
        return;
      }

      // 8. Run fixer agent
      console.log(`[QAReview] Running AI fixer agent...`);
      review.state.status = 'fixing';
      await this.saveQAReviewState(projectPath, featureId, review.state);

      this.emitEvent('qa_fixer_started', {
        featureId,
        projectPath,
        iteration: review.state.iteration,
        issues: reviewResult.issues,
      });

      const fixerModel = resolveModelString(config.fixerModel || model, DEFAULT_MODELS.claude);
      await this.runFixer(
        worktreePath,
        reviewResult.issues,
        specification,
        featureDescription,
        review.state.iteration,
        fixerModel,
        abortController
      );
      console.log(`[QAReview] Fixer agent completed`);

      // 9. Commit and push fixes
      console.log(`[QAReview] Committing and pushing fixes...`);
      await this.commitAndPushFixes(worktreePath, review.state.iteration);
      console.log(`[QAReview] Fixes committed and pushed`);

      this.emitEvent('qa_fixer_complete', {
        featureId,
        projectPath,
        iteration: review.state.iteration,
      });

      // 10. Increment iteration and continue
      review.state.iteration++;
      review.state.status = 'reviewing';
      await this.saveQAReviewState(projectPath, featureId, review.state);
      console.log(`[QAReview] Moving to iteration ${review.state.iteration}`);
    }

    console.log(`[QAReview] Review loop ended for feature ${featureId}`);
  }

  /**
   * Run the AI reviewer agent
   */
  private async runReviewer(
    worktreePath: string,
    diff: string,
    specification: string,
    featureDescription: string,
    iteration: number,
    previousIssues: ReviewIssue[] | undefined,
    model: string,
    abortController: AbortController
  ): Promise<ReviewResult> {
    const provider = ProviderFactory.getProviderForModel(model);
    const prompt = buildReviewerPrompt(
      diff,
      featureDescription,
      specification,
      iteration,
      previousIssues
    );

    const options = {
      prompt,
      model,
      cwd: worktreePath,
      systemPrompt: QA_REVIEWER_SYSTEM_PROMPT,
      maxTurns: 15,
      allowedTools: ['Read', 'Glob', 'Grep'], // Read-only tools for static code review
      abortController,
    };

    let responseText = '';
    for await (const msg of provider.executeQuery(options)) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            responseText += block.text || '';
          }
        }
      } else if (msg.type === 'result' && msg.subtype === 'success') {
        responseText += msg.result || '';
      }
    }

    // Parse the JSON response
    return this.parseReviewResponse(responseText, iteration);
  }

  /**
   * Run the AI fixer agent
   */
  private async runFixer(
    worktreePath: string,
    issues: ReviewIssue[],
    specification: string,
    featureDescription: string,
    iteration: number,
    model: string,
    abortController: AbortController
  ): Promise<void> {
    const provider = ProviderFactory.getProviderForModel(model);
    const prompt = buildFixerPrompt(issues, featureDescription, specification, iteration);

    const options = {
      prompt,
      model,
      cwd: worktreePath,
      systemPrompt: QA_FIXER_SYSTEM_PROMPT,
      maxTurns: 50, // More turns for fixing
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], // Bash for git commits only
      abortController,
    };

    for await (const msg of provider.executeQuery(options)) {
      // Stream through - fixer makes changes directly
      if (msg.type === 'error') {
        throw new Error(msg.error || 'Fixer agent error');
      }
    }
  }

  /**
   * Get PR diff using gh CLI
   */
  private async getPRDiff(worktreePath: string, prNumber: number): Promise<string> {
    try {
      const { stdout } = await execAsync(`gh pr diff ${prNumber}`, {
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
      });
      return stdout;
    } catch (error) {
      console.error('[QAReview] Failed to get PR diff:', error);
      // Fall back to git diff against main/master
      try {
        const { stdout } = await execAsync('git diff origin/main...HEAD', {
          cwd: worktreePath,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      } catch {
        const { stdout } = await execAsync('git diff origin/master...HEAD', {
          cwd: worktreePath,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      }
    }
  }

  /**
   * Post review comments to GitHub PR
   * Uses gh pr review command for reliability
   */
  private async postInlineReviewComments(
    worktreePath: string,
    prNumber: number,
    issues: ReviewIssue[],
    iteration: number,
    approved: boolean,
    summary?: string
  ): Promise<void> {
    // Build detailed review body with all issues
    const reviewBody = this.formatDetailedReviewBody(issues, iteration, approved, summary);

    // Determine review action
    const reviewAction = approved ? '--approve' : '--request-changes';

    try {
      // Use gh pr review which is more reliable than the API
      const escapedBody = reviewBody.replace(/'/g, "'\\''");
      await execAsync(`gh pr review ${prNumber} ${reviewAction} --body '${escapedBody}'`, {
        cwd: worktreePath,
        timeout: 60000, // 60 second timeout
      });

      console.log(
        `[QAReview] Posted review for PR #${prNumber} (${approved ? 'approved' : 'changes requested'})`
      );
    } catch (error) {
      console.error('[QAReview] Failed to post review:', error);
      // Fallback to regular comment if review fails
      await this.postFallbackComment(worktreePath, prNumber, issues, iteration, approved, summary);
    }
  }

  /**
   * Format detailed review body with all issues listed
   */
  private formatDetailedReviewBody(
    issues: ReviewIssue[],
    iteration: number,
    approved: boolean,
    summary?: string
  ): string {
    let body = `## AI Code Review ${approved ? '✅ Approved' : '🔍 Changes Requested'} (Iteration ${iteration})\n\n`;

    if (summary) {
      body += `> ${summary}\n\n`;
    }

    if (!approved && issues.length > 0) {
      // Group issues by severity
      const critical = issues.filter((i) => i.severity === 'critical');
      const major = issues.filter((i) => i.severity === 'major');
      const minor = issues.filter((i) => i.severity === 'minor');
      const suggestions = issues.filter((i) => i.severity === 'suggestion');

      if (critical.length > 0) {
        body += `### 🚨 Critical Issues (${critical.length})\n\n`;
        critical.forEach((issue) => {
          body += `- **${issue.filePath}${issue.lineStart ? `:${issue.lineStart}` : ''}** - ${issue.description}\n`;
          if (issue.suggestion) body += `  - 💡 ${issue.suggestion}\n`;
        });
        body += '\n';
      }

      if (major.length > 0) {
        body += `### ⚠️ Major Issues (${major.length})\n\n`;
        major.forEach((issue) => {
          body += `- **${issue.filePath}${issue.lineStart ? `:${issue.lineStart}` : ''}** - ${issue.description}\n`;
          if (issue.suggestion) body += `  - 💡 ${issue.suggestion}\n`;
        });
        body += '\n';
      }

      if (minor.length > 0) {
        body += `### 📝 Minor Issues (${minor.length})\n\n`;
        minor.forEach((issue) => {
          body += `- **${issue.filePath}${issue.lineStart ? `:${issue.lineStart}` : ''}** - ${issue.description}\n`;
          if (issue.suggestion) body += `  - 💡 ${issue.suggestion}\n`;
        });
        body += '\n';
      }

      if (suggestions.length > 0) {
        body += `### 💡 Suggestions (${suggestions.length})\n\n`;
        suggestions.forEach((issue) => {
          body += `- **${issue.filePath}${issue.lineStart ? `:${issue.lineStart}` : ''}** - ${issue.description}\n`;
        });
        body += '\n';
      }
    }

    body += '---\n*Generated by AutoMaker AI Reviewer*';
    return body;
  }

  /**
   * Fallback: Post a regular PR comment if review fails
   */
  private async postFallbackComment(
    worktreePath: string,
    prNumber: number,
    issues: ReviewIssue[],
    iteration: number,
    approved: boolean,
    summary?: string
  ): Promise<void> {
    const comment = formatReviewComment(issues, iteration, approved, summary);

    // Escape the comment for shell
    const escapedComment = comment.replace(/'/g, "'\\''");

    try {
      await execAsync(`gh pr comment ${prNumber} --body '${escapedComment}'`, {
        cwd: worktreePath,
      });
      console.log(`[QAReview] Posted fallback comment for PR #${prNumber}`);
    } catch (error) {
      console.error('[QAReview] Failed to post fallback comment:', error);
      // Continue even if comment posting fails
    }
  }

  /**
   * Commit and push fixer changes
   */
  private async commitAndPushFixes(worktreePath: string, iteration: number): Promise<void> {
    try {
      const { stdout: status } = await execAsync('git status --porcelain', { cwd: worktreePath });

      if (status.trim()) {
        await execAsync('git add -A', { cwd: worktreePath });
        await execAsync(
          `git commit -m "fix: address QA review feedback (iteration ${iteration})"`,
          {
            cwd: worktreePath,
          }
        );
        await execAsync('git push', { cwd: worktreePath });
      }
    } catch (error) {
      console.error('[QAReview] Failed to commit and push fixes:', error);
      throw error;
    }
  }

  /**
   * Parse reviewer response into ReviewResult
   */
  private parseReviewResponse(response: string, iteration: number): ReviewResult {
    // Extract JSON from response (look for ```json blocks or raw JSON)
    const jsonMatch =
      response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) {
      return {
        approved: false,
        issues: [],
        summary: 'Failed to parse review response - no JSON found',
        timestamp: new Date().toISOString(),
        iteration,
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[1]);

      // Handle the reviewer output format
      const approved = parsed.status === 'approved';
      const issues: ReviewIssue[] = (parsed.issues || []).map((issue: any, index: number) => ({
        id: `issue-${iteration}-${index}`,
        severity: this.mapSeverity(issue.severity),
        category: issue.category || 'code-style',
        filePath: issue.file || 'unknown',
        lineStart: issue.line,
        description: issue.description || issue.title || 'No description',
        suggestion: issue.suggestion,
      }));

      return {
        approved,
        issues,
        summary: parsed.summary || '',
        timestamp: new Date().toISOString(),
        iteration,
      };
    } catch (error) {
      console.error('[QAReview] Failed to parse review JSON:', error);
      return {
        approved: false,
        issues: [],
        summary: 'Failed to parse review JSON',
        timestamp: new Date().toISOString(),
        iteration,
      };
    }
  }

  /**
   * Map severity levels from reviewer format to our format
   */
  private mapSeverity(severity: string): 'critical' | 'major' | 'minor' | 'suggestion' {
    const lower = (severity || '').toLowerCase();
    if (lower === 'high' || lower === 'critical') return 'critical';
    if (lower === 'medium' || lower === 'major') return 'major';
    if (lower === 'low' || lower === 'minor') return 'minor';
    return 'suggestion';
  }

  /**
   * Save QA review state to feature directory
   */
  private async saveQAReviewState(
    projectPath: string,
    featureId: string,
    state: QAReviewState
  ): Promise<void> {
    const featureDir = getFeatureDir(projectPath, featureId);
    const statePath = path.join(featureDir, 'qa-review-state.json');
    await secureFs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Load QA review state from feature directory
   */
  async loadQAReviewState(projectPath: string, featureId: string): Promise<QAReviewState | null> {
    const featureDir = getFeatureDir(projectPath, featureId);
    const statePath = path.join(featureDir, 'qa-review-state.json');
    try {
      const data = (await secureFs.readFile(statePath, 'utf-8')) as string;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Update feature status in feature.json
   */
  private async updateFeatureStatus(
    projectPath: string,
    featureId: string,
    status: string
  ): Promise<void> {
    const featureDir = getFeatureDir(projectPath, featureId);
    const featurePath = path.join(featureDir, 'feature.json');

    try {
      const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
      const feature = JSON.parse(data);
      feature.status = status;
      feature.updatedAt = new Date().toISOString();

      // Set justFinishedAt for waiting_approval to show badge
      if (status === 'waiting_approval') {
        feature.justFinishedAt = new Date().toISOString();
      }

      await secureFs.writeFile(featurePath, JSON.stringify(feature, null, 2));

      // Emit feature update event for UI sync
      this.events.emit('feature:updated', {
        featureId,
        projectPath,
        status,
      });

      console.log(`[QAReview] Updated feature ${featureId} status to ${status}`);
    } catch (error) {
      console.error(`[QAReview] Failed to update feature status:`, error);
      // Don't throw - status update failure shouldn't break the review flow
    }
  }

  /**
   * Emit QA review event
   */
  private emitEvent(type: QAReviewEventType, data: Partial<QAReviewEvent>): void {
    this.events.emit('qa-review:event', {
      type,
      ...data,
    });
  }

  /**
   * Get status of all active reviews
   */
  getActiveReviews(): Array<{ featureId: string; state: QAReviewState }> {
    return Array.from(this.activeReviews.values()).map((r) => ({
      featureId: r.featureId,
      state: r.state,
    }));
  }

  /**
   * Check if a review is active for a feature
   */
  isReviewActive(featureId: string): boolean {
    return this.activeReviews.has(featureId);
  }
}
