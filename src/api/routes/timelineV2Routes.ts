import express from 'express';
import multer from 'multer';
import path from 'path';
import * as timelineController from '../controllers/timelineController';
import { RepositoryManager } from '../../core/repositoryManager';
import fs from 'fs'; // Import fs for directory creation
import { OrchestratorService } from '../../orchestrator/orchestratorService'; // Import OrchestratorService

const router = express.Router();

// Configure multer for file uploads
// Store files in a temporary 'uploads/' directory.
// The orchestrator will later move them to the 'raw/' directory within the specific repository.
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

// Ensure 'uploadsDir' exists
if (!fs.existsSync(uploadsDir)) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log(`Created uploads directory at: ${uploadsDir}`);
  } catch (err) {
    console.error(`Error creating uploads directory at ${uploadsDir}:`, err);
    // Depending on the desired behavior, you might want to throw an error here
    // or let the application continue and potentially fail at upload time.
  }
}

// TODO: Ensure 'uploadsDir' is created if it doesn't exist, or handle errors if multer can't write.
// For now, assuming the directory will be created manually or by a startup script.
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // It's good practice to ensure the directory exists before calling cb.
        // For now, we assume it does or multer handles it gracefully if not.
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        // Using a more robust way to create a unique suffix to avoid collisions.
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Mount point for this router will be /api (or /api/v2 etc.)
// So, routes here are relative to that.

// POST /upload (effectively /api/upload if router mounted on /api)
// router.post('/upload', upload.single('file'), timelineController.uploadFile); // This seems like an old route without repoId and OrchestratorService

// GET /timeline (effectively /api/timeline)
router.get('/timeline', timelineController.getTimeline);

// GET /timeline/:id (effectively /api/timeline/:id)
router.get('/timeline/:id', timelineController.getTimelineEntryById);

// GET /timeline/:id/diff (effectively /api/timeline/:id/diff)
router.get('/timeline/:id/diff', timelineController.getTimelineEntryDiff);

// POST /regen (effectively /api/regen)
router.post('/regen', timelineController.regenerateKnowledgeBase);

// POST /timeline/:id/revert (effectively /api/timeline/:id/revert)
router.post('/timeline/:id/revert', timelineController.revertTimelineEntry);

export const setupTimelineV2Routes = (app: express.Application, repositoryManager: RepositoryManager, orchestratorService: OrchestratorService) => {
    const router = express.Router();

    // Define routes with repositoryId parameter and use the new controller signature
    router.post('/:repositoryId/upload', upload.single('file'), timelineController.uploadFile(repositoryManager, orchestratorService)); // Pass orchestratorService
    
    router.get('/:repositoryId/timeline', timelineController.getTimeline(repositoryManager));
    
    router.get('/:repositoryId/timeline/:id', timelineController.getTimelineEntryById(repositoryManager));
    
    router.get('/:repositoryId/timeline/:id/diff', timelineController.getTimelineEntryDiff(repositoryManager));
    
    router.post('/:repositoryId/regen', timelineController.regenerateKnowledgeBase(repositoryManager));
    
    router.post('/:repositoryId/timeline/:id/revert', timelineController.revertTimelineEntry(repositoryManager));

    // Mount the router on /api. The routes above will be prefixed with /api
    // e.g. /api/:repositoryId/upload
    app.use('/api', router);
};

// No default export of router needed here 