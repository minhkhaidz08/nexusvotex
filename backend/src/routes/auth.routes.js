const router = require('express').Router();
const { authController } = require('../controllers/auth.controller');
const { authMiddleware } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Đăng ký quá nhanh, vui lòng thử lại sau' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút' });

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginLimiter, authController.login);
router.get('/me', authMiddleware, authController.me);
router.put('/password', authMiddleware, authController.changePassword);
router.put('/avatar', authMiddleware, authController.updateAvatar);
router.put('/profile', authMiddleware, authController.updateProfile);

module.exports = router;
