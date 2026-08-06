const router = require('express').Router();
const { notificationController } = require('../controllers/notification.controller');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);
router.get('/', notificationController.list);
router.get('/unread-count', notificationController.unreadCount);
router.put('/:id/read', notificationController.markRead);
router.put('/read-all', notificationController.markAllRead);

module.exports = router;
