const router = require('express').Router();

const authRoutes = require('./auth.routes');
const productRoutes = require('./product.routes');
const categoryRoutes = require('./category.routes');
const orderRoutes = require('./order.routes');
const walletRoutes = require('./wallet.routes');
const notificationRoutes = require('./notification.routes');
const miscRoutes = require('./misc.routes');
const adminRoutes = require('./admin.routes');
const webhookRoutes = require('./webhook.routes');

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/', categoryRoutes);
router.use('/orders', orderRoutes);
router.use('/wallet', walletRoutes);
router.use('/notifications', notificationRoutes);
router.use('/', miscRoutes);
router.use('/admin', adminRoutes);
router.use('/webhook', webhookRoutes);

module.exports = router;
