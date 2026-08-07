const router = require('express').Router();
const { walletController } = require('../controllers/wallet.controller');
const { authMiddleware } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

router.use(authMiddleware);

// Card PINs are submitted to a paid provider on every attempt - a brute-force
// vector against the provider that costs the shop money per try.
const cardLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Nạp thẻ quá nhiều lần trong giờ, vui lòng thử lại sau' });

const bankLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Tạo yêu cầu nạp ngân hàng quá nhanh, vui lòng thử lại sau',
  keyFn: (req) => `u:${req.userId}`,
});

router.get('/', walletController.summary);
router.get('/transactions', walletController.transactions);
router.post('/deposit/card', cardLimiter, walletController.depositCard);
router.post('/deposit/bank', bankLimiter, walletController.depositBank);
router.post('/deposit/bank/verify', walletController.verifyBankDeposit);

module.exports = router;
