const router = require('express').Router();
const { webhookController } = require('../controllers/webhook.controller');

router.post('/thesieure', webhookController.theSieuRe);
router.get('/thesieure', webhookController.theSieuRe);
router.post('/payos', webhookController.payos);

module.exports = router;
