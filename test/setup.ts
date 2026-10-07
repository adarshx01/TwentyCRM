import 'reflect-metadata';
import { configureLogging } from '../src/observability/logger';

// Quiet logs in tests unless LOG_LEVEL is set.
configureLogging(process.env.LOG_LEVEL ?? 'silent');
