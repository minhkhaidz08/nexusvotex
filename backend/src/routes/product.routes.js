const router = require('express').Router();
const { productController } = require('../controllers/product.controller');
const { authMiddleware } = require('../middleware/auth');

router.get('/', productController.list);
router.get('/featured', productController.featured);
router.get('/:id', productController.detail);

module.exports = router;
