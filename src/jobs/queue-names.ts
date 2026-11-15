/**
 * BullMQ queue names.
 *
 * Kept in their own module so a processor can name its queue without importing
 * jobs.module.ts, which itself imports the processors. Importing through
 * jobs.module.ts would create a cycle where the decorator reads an undefined
 * value during the first evaluation.
 */
export const MAINTENANCE_QUEUE = 'maintenance';
export const DOMAIN_EVENTS_QUEUE = 'domain-events';
