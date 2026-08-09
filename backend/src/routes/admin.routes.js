const router = require('express').Router();
const { adminController } = require('../controllers/admin.controller');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.use(authMiddleware, adminOnly);

// Dashboard
router.get('/dashboard', adminController.dashboard);

// Products
router.get('/products', adminController.listProducts);
router.post('/products', adminController.createProduct);
router.put('/products/:id', adminController.updateProduct);
router.delete('/products/:id', adminController.deleteProduct);

// Categories
router.get('/categories', adminController.listCategories);
router.post('/categories', adminController.createCategory);
router.put('/categories/:id', adminController.updateCategory);
router.delete('/categories/:id', adminController.deleteCategory);

// Inventory keys
router.get('/inventory', adminController.listInventory);
router.get('/inventory/sold', adminController.listSoldKeys);
router.post('/inventory', adminController.addKey);
router.put('/inventory/:id', adminController.updateKey);
router.delete('/inventory/:id', adminController.deleteKey);
router.post('/inventory/import', adminController.importKeys);

// Orders
router.get('/orders', adminController.listOrders);
router.get('/orders/:id', adminController.orderDetail);

// Custom orders
router.get('/custom-orders', adminController.listCustomOrders);
router.post('/custom-orders/:id/complete', adminController.completeCustomOrder);
router.post('/custom-orders/:id/cancel', adminController.cancelCustomOrder);

// Deposits
router.get('/deposits', adminController.listDeposits);

// Users
router.get('/users', adminController.listUsers);
router.put('/users/:id', adminController.updateUser);
router.post('/users/:id/adjust-balance', adminController.adjustUserBalance);
router.get('/users/:id/transactions', adminController.userTransactions);

// Discount codes
router.get('/discounts', adminController.listDiscounts);
router.post('/discounts', adminController.createDiscount);
router.put('/discounts/:id', adminController.updateDiscount);
router.delete('/discounts/:id', adminController.deleteDiscount);

// News
router.get('/news', adminController.listNews);
router.post('/news', adminController.createNews);
router.put('/news/:id', adminController.updateNews);
router.delete('/news/:id', adminController.deleteNews);

// Settings
router.get('/settings', adminController.getSettings);
router.put('/settings', adminController.updateSettings);

// Activity logs
router.get('/activity-logs', adminController.listActivityLogs);

module.exports = router;
