const router = require('express').Router();
const { miscController } = require('../controllers/misc.controller');
const { authMiddleware } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const upload = require('../middleware/upload');

// Public
router.get('/news', miscController.listNews);
router.get('/news/:id', miscController.newsDetail);
router.get('/settings/public', miscController.publicSettings);

// Protected
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Tải file quá nhiều lần, vui lòng thử lại sau',
  keyFn: (req) => `u:${req.userId}`,
});
router.post('/upload', authMiddleware, uploadLimiter, upload.single('file'), miscController.uploadFile);

module.exports = router;
