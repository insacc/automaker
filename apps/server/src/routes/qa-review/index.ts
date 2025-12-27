/**
 * QA Review API Routes
 */

import { Router, type Request, type Response } from 'express';
import type { QAReviewService } from '../../services/qa-review-service.js';

export function createQAReviewRoutes(qaReviewService: QAReviewService): Router {
  const router = Router();

  /**
   * POST /api/qa-review/start
   * Start QA review for a feature
   */
  router.post('/start', async (req: Request, res: Response) => {
    const {
      projectPath,
      featureId,
      worktreePath,
      prNumber,
      prUrl,
      specification,
      featureDescription,
      config,
      model,
    } = req.body;

    if (!projectPath || !featureId || !worktreePath || !prNumber || !prUrl) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: projectPath, featureId, worktreePath, prNumber, prUrl',
      });
      return;
    }

    try {
      // Start review asynchronously - don't await
      qaReviewService
        .startReview(
          projectPath,
          featureId,
          worktreePath,
          prNumber,
          prUrl,
          specification || '',
          featureDescription || `Feature ${featureId}`,
          config,
          model
        )
        .catch((error) => {
          console.error(`[QAReview] Review failed for ${featureId}:`, error);
        });

      res.json({ success: true, message: 'QA review started' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  /**
   * POST /api/qa-review/stop
   * Stop an active QA review
   */
  router.post('/stop', (req: Request, res: Response) => {
    const { featureId } = req.body;

    if (!featureId) {
      res.status(400).json({ success: false, error: 'Missing featureId' });
      return;
    }

    const stopped = qaReviewService.stopReview(featureId);
    res.json({ success: stopped, message: stopped ? 'Review stopped' : 'No active review found' });
  });

  /**
   * GET /api/qa-review/active
   * Get all active reviews
   */
  router.get('/active', (_req: Request, res: Response) => {
    const reviews = qaReviewService.getActiveReviews();
    res.json({ success: true, reviews });
  });

  /**
   * GET /api/qa-review/status/:featureId
   * Get review status for a specific feature
   */
  router.get('/status/:featureId', async (req: Request, res: Response) => {
    const { featureId } = req.params;
    const { projectPath } = req.query;

    if (!projectPath || typeof projectPath !== 'string') {
      res.status(400).json({ success: false, error: 'Missing projectPath query parameter' });
      return;
    }

    // Check if review is currently active
    const isActive = qaReviewService.isReviewActive(featureId);

    // Load saved state
    const state = await qaReviewService.loadQAReviewState(projectPath, featureId);

    res.json({
      success: true,
      isActive,
      state,
    });
  });

  return router;
}
