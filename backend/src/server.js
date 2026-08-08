require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const routes = require('./routes/index');
const { validateEnv } = require('./config/env');

validateEnv();

const app = express();
const PORT = process.env.PORT || 5000;

// Behind a reverse proxy (Render, nginx) TRUST_PROXY=true so req.ip used by
// the rate limiter reflects the real client IP instead of the proxy's.
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', true);
}

// CORS - allow the configured frontend origins, or all by default.
// In production set CORS_ORIGIN to a comma-separated allowlist.
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : true;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static uploads (nosniff prevents MIME-sniffing of polyglot files
// that could smuggle script into an image/upload response).
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// API routes
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 404 + error handling
app.use(notFound);
app.use(errorHandler);

// Start cron jobs
const { initCronJobs } = require('./services/cron');
initCronJobs(cron);

app.listen(PORT, () => {
  console.log(`[NexusVotex] API running on port ${PORT}`);
});
