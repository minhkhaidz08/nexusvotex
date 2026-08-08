const router = require('express').Router();
const { orderController } = require('../controllers/order.controller');
const { authMiddleware } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

router.use(authMiddleware);

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Thanh toán quá nhanh, vui lòng thử lại sau',
  keyFn: (req) => `u:${req.userId}`,
});

const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Gửi quá nhiều yêu cầu, vui lòng thử lại sau',
  keyFn: (req) => `u:${req.userId}`,
});

const customLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Tạo đơn đặt hàng quá nhanh, vui lòng thử lại sau',
  keyFn: (req) => `u:${req.userId}`,
});

router.get('/', orderController.myOrders);
router.get('/:id', orderController.detail);
router.post('/checkout', checkoutLimiter, orderController.checkout);
router.post('/custom', customLimiter, orderController.createCustomOrder);
router.post('/cart/preview', previewLimiter, orderController.previewCart);

module.exports = router;
